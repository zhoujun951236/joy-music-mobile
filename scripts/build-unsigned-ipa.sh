#!/usr/bin/env bash
# 在本地构建 unsigned IPA。需要 Xcode + CocoaPods（gem 安装）+ Node.js。
# 输出位于仓库根目录：YueYin-<version>-unsigned.ipa
#
# 使用方式：
#   ./scripts/build-unsigned-ipa.sh                # 全量：prebuild + pod install + archive
#   ./scripts/build-unsigned-ipa.sh --skip-prebuild # 复用现有 ios/ 工程，仅重新 archive + 打包
#
# 环境兼容：
#   - 自动探测 127.0.0.1:7890 代理。监听则 export，未监听就裸跑（在国内裸跑大概率超时）。
#   - 已知 RN 0.81 + 新架构有 codegen 路径错位问题：第一次 archive 必报
#     "Build input file cannot be found: ios/build/generated/ios/..."。
#     脚本会自动 rsync 修复并重试一次，无需人工介入。

set -euo pipefail

SKIP_PREBUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-prebuild) SKIP_PREBUILD=1 ;;
    -h|--help)
      sed -n '1,15p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# —— 代理：监听 127.0.0.1:7890 就自动用，不监听就跳过 ——
if (echo > /dev/tcp/127.0.0.1/7890) >/dev/null 2>&1; then
  export https_proxy=http://127.0.0.1:7890
  export http_proxy=http://127.0.0.1:7890
  export all_proxy=http://127.0.0.1:7890
  echo "==> 代理已启用: 127.0.0.1:7890"
else
  echo "==> 未检测到 127.0.0.1:7890 代理，将直连（拉 RN tarball / rubygems 可能很慢）"
fi

APP_VERSION=$(node -p "require('./app.json').expo.version")
BUNDLE_ID=$(node -p "require('./app.json').expo.ios.bundleIdentifier")
IPA_NAME="YueYin-${APP_VERSION}-unsigned.ipa"

echo "==> 项目根目录: $PROJECT_ROOT"
echo "==> 应用版本: $APP_VERSION"
echo "==> Bundle ID: $BUNDLE_ID"
echo "==> 目标产物: $IPA_NAME"

# —— 1) npm 依赖 ——
if [ ! -d node_modules ]; then
  echo "==> 安装 npm 依赖"
  npm ci
fi

# —— 2) Expo prebuild ——
if [ "$SKIP_PREBUILD" -eq 0 ]; then
  echo "==> Expo prebuild iOS（重置 ios/ 目录）"
  # CI=1 让 expo 跳过交互；它末尾的 pod install 在 rvm 下偶发失败，但 ios/ 工程已生成，可继续。
  CI=1 npx expo prebuild --platform ios --clean || {
    echo "expo prebuild 退出非零，但 ios/ 工程可能已经生成；继续后续步骤。" >&2
  }
fi

if [ ! -d ios ]; then
  echo "ios/ 目录不存在，prebuild 失败" >&2
  exit 1
fi

# —— 3) bundle install（仓库根 Gemfile） ——
# rvm 下系统 pod shim 会读 Gemfile 的版本约束，必须先生成 Gemfile.lock，否则 pod 会报
# find_spec_for_exe: can't find gem cocoapods。
if [ ! -f Gemfile.lock ]; then
  echo "==> bundle install"
  bundle install
fi

# —— 4) pod install ——
if [ ! -d ios/Pods ] || [ "$SKIP_PREBUILD" -eq 0 ]; then
  echo "==> bundle exec pod install"
  bundle exec pod install --project-directory=ios
else
  echo "==> ios/Pods 已存在且未 prebuild，跳过 pod install"
fi

# —— 5) 解析 workspace + scheme ——
WORKSPACE_PATH=$(find ios -maxdepth 1 -name "*.xcworkspace" | head -n 1)
if [ -z "$WORKSPACE_PATH" ]; then
  echo "未在 ios/ 下找到 .xcworkspace" >&2
  exit 1
fi

SCHEMES=$(xcodebuild -workspace "$WORKSPACE_PATH" -list -json | node -e '
let buf = "";
process.stdin.on("data", d => buf += d);
process.stdin.on("end", () => {
  const data = JSON.parse(buf);
  const arr = (data.workspace && data.workspace.schemes) || [];
  console.log(arr.join("\n"));
});')

SCHEME=$(echo "$SCHEMES" | grep -vE '^(Pods-|.*Tests$)' | head -n 1 || true)
if [ -z "$SCHEME" ]; then
  SCHEME=$(echo "$SCHEMES" | head -n 1 || true)
fi
if [ -z "$SCHEME" ]; then
  echo "未识别到 iOS scheme" >&2
  exit 1
fi
echo "==> 使用 scheme: $SCHEME"

ARCHIVE_PATH="ios/build/${SCHEME}.xcarchive"
rm -rf ios/build dist "$IPA_NAME"
mkdir -p ios/build dist/Payload

# —— 6) 同步 ios/app/Info.plist 与 app.json 的版本（--skip-prebuild 模式下 ios/ 不会被重写） ——
sync_info_plist_version() {
  local plist_file="ios/${SCHEME}/Info.plist"
  if [ ! -f "$plist_file" ]; then return 0; fi
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${APP_VERSION}" "$plist_file" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_VERSION}" "$plist_file" 2>/dev/null || true
  echo "==> 已把 ${plist_file} 的版本号同步为 ${APP_VERSION}"
}

# —— 7) Archive：第一次预期失败 → rsync codegen → 第二次成功 ——
# 用文件落地 ARCHIVE 结果而非 PIPESTATUS，避免在 set -e 下被 grep/tee 干扰退出码判断。
run_archive() {
  local log_file="$1"
  rm -f "$log_file"
  set +e
  ( set -o pipefail; xcodebuild \
    -workspace "$WORKSPACE_PATH" \
    -scheme "$SCHEME" \
    -configuration Release \
    -sdk iphoneos \
    -destination "generic/platform=iOS" \
    -archivePath "$ARCHIVE_PATH" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY="" \
    archive 2>&1 | tee "$log_file" >/dev/null )
  local rc=$?
  set -e
  # 主要根据日志里的 ARCHIVE SUCCEEDED 判断；rc 仅作辅助。
  grep -q "\*\* ARCHIVE SUCCEEDED \*\*" "$log_file"
  local archive_ok=$?
  if [ $archive_ok -eq 0 ]; then
    return 0
  fi
  return ${rc:-1}
}

sync_codegen() {
  local gen_dir
  gen_dir=$(find "$HOME/Library/Developer/Xcode/DerivedData" -type d \
    -path "*/ReactCodegen.build/DerivedSources/generated/source/codegen/out/build/generated/ios" \
    2>/dev/null | tail -n 1)
  if [ -z "$gen_dir" ] || [ ! -d "$gen_dir" ]; then
    echo "未找到 DerivedData 中的 codegen 输出目录" >&2
    return 1
  fi
  mkdir -p ios/build/generated/ios
  rsync -a "$gen_dir/" ios/build/generated/ios/
  echo "==> codegen 产物已同步到 ios/build/generated/ios"
}

sync_info_plist_version

echo "==> 第一次 archive（已知 codegen 路径问题，预期会失败一次）"
if run_archive xcodebuild-pass1.log; then
  echo "==> 第一次 archive 直接成功（少见但也行）"
else
  echo "==> 第一次失败，按预期同步 codegen 后重试"
  sync_codegen
  echo "==> 第二次 archive"
  run_archive xcodebuild.log
fi

if ! grep -q "ARCHIVE SUCCEEDED" xcodebuild*.log; then
  echo "archive 仍未成功，请查看 xcodebuild*.log" >&2
  exit 1
fi

# —— 7) 打 IPA ——
APP_PATH=$(find "$ARCHIVE_PATH/Products/Applications" -maxdepth 1 -name "*.app" | head -n 1)
if [ -z "$APP_PATH" ]; then
  echo "archive 未生成 .app" >&2
  exit 1
fi

cp -R "$APP_PATH" dist/Payload/
( cd dist && /usr/bin/zip -qry "../$IPA_NAME" Payload )

# —— 8) 自检 IPA 内 Info.plist 是否符合预期 ——
echo "==> IPA 自检"
PLIST_DUMP=$(unzip -p "$IPA_NAME" "Payload/$(basename "$APP_PATH")/Info.plist" | plutil -p - 2>/dev/null || true)
echo "$PLIST_DUMP" | grep -E "CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion" || true

ACTUAL_BUNDLE_ID=$(echo "$PLIST_DUMP" | awk -F '"' '/CFBundleIdentifier/ {print $4}')
if [ -n "$ACTUAL_BUNDLE_ID" ] && [ "$ACTUAL_BUNDLE_ID" != "$BUNDLE_ID" ]; then
  echo "警告：IPA 内 CFBundleIdentifier=$ACTUAL_BUNDLE_ID，与 app.json 配置 $BUNDLE_ID 不一致" >&2
fi

ls -lh "$IPA_NAME"
echo
echo "==> 完成: $PROJECT_ROOT/$IPA_NAME"
echo "下一步：用你自己的 p12 + mobileprovision 重签后再安装。"
echo "签名工具如果有 Make Bundle ID Unique / Change Bundle ID 选项，请关闭。"
