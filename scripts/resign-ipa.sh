#!/usr/bin/env bash
# 给 unsigned IPA 重签:替换 mobileprovision + 注入实例化 entitlements + 用 codesign 签。
#
# 关于 entitlements:必须传 -e,否则 codesign 从 mobileprovision 继承 RA2G5HURUT.* 字面量,
# 导致 iOS 安装阶段报 0xE800003A MISMATCHED_APPLICATION_IDENTIFIER_ENTITLEMENT。
#
# 使用:
#   ./scripts/resign-ipa.sh                  # 自动找仓库根最新 YueYin-*-unsigned.ipa
#   ./scripts/resign-ipa.sh path/to/x.ipa    # 显式指定 unsigned IPA
#
# 可通过环境变量覆盖:
#   SIGN_IDENTITY      codesign 用的证书 SHA1 或 CN(默认 jimmy chow)
#   SIGN_PROVISION     mobileprovision 路径
#   SIGN_ENTITLEMENTS  entitlements plist 路径(实例化 application-identifier)
#   SIGN_OUTPUT_DIR    签好的 IPA 输出目录(默认仓库根)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

SIGN_MATERIAL_DIR="/Users/berta/Downloads/ResignTool-macos20230128"
SIGN_IDENTITY="${SIGN_IDENTITY:-02E1F0856969698060FB43F6706704C5DC37ED79}"
SIGN_PROVISION="${SIGN_PROVISION:-$SIGN_MATERIAL_DIR/zj.mobileprovision}"
SIGN_ENTITLEMENTS="${SIGN_ENTITLEMENTS:-$SIGN_MATERIAL_DIR/joymusic.entitlements}"
SIGN_OUTPUT_DIR="${SIGN_OUTPUT_DIR:-$PROJECT_ROOT}"

# 1. 找 unsigned IPA
if [[ $# -ge 1 ]]; then
  UNSIGNED_IPA="$1"
else
  UNSIGNED_IPA=$(ls "$PROJECT_ROOT"/YueYin-*-unsigned.ipa 2>/dev/null | head -n 1 || true)
fi
if [[ -z "${UNSIGNED_IPA:-}" || ! -f "$UNSIGNED_IPA" ]]; then
  echo "❌ 未找到 unsigned IPA。先跑 ./scripts/build-unsigned-ipa.sh,或显式传路径。" >&2
  exit 1
fi
echo "==> 待签 IPA: $UNSIGNED_IPA"

# 2. 检查材料
for f in "$SIGN_PROVISION" "$SIGN_ENTITLEMENTS"; do
  if [[ ! -f "$f" ]]; then
    echo "❌ 签名材料缺失: $f" >&2
    exit 1
  fi
done
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_IDENTITY"; then
  echo "❌ keychain 里找不到证书 $SIGN_IDENTITY。先双击 p12 导入到登录钥匙串。" >&2
  exit 1
fi

# 3. 解 IPA
WORK_DIR=$(mktemp -d -t joymusic-resign.XXXX)
trap 'rm -rf "$WORK_DIR"' EXIT
cd "$WORK_DIR"
unzip -q "$UNSIGNED_IPA"
APP_PATH="$WORK_DIR/Payload/app.app"
[[ -d "$APP_PATH" ]] || { echo "❌ IPA 内未发现 Payload/app.app" >&2; exit 1; }

# 4. 替换 mobileprovision
cp "$SIGN_PROVISION" "$APP_PATH/embedded.mobileprovision"

# 5. 签 frameworks 和主 app
shopt -s nullglob
for fw in "$APP_PATH"/Frameworks/*.framework "$APP_PATH"/Frameworks/*.dylib; do
  echo "  签: $(basename "$fw")"
  codesign --force --sign "$SIGN_IDENTITY" "$fw"
done
shopt -u nullglob

echo "==> 签主 app(注入 entitlements)"
codesign --force --sign "$SIGN_IDENTITY" --entitlements "$SIGN_ENTITLEMENTS" "$APP_PATH"

# 6. 打 IPA
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Info.plist")
OUTPUT_IPA="$SIGN_OUTPUT_DIR/YueYin-${VERSION}-signed.ipa"
rm -f "$OUTPUT_IPA"
( cd "$WORK_DIR" && /usr/bin/zip -qry "$OUTPUT_IPA" Payload )
echo
echo "==> 完成: $OUTPUT_IPA"
