# 本地构建 unsigned IPA — 自助手册

写给独自打包时的自己看。脚本能处理大部分事，但环境上有几个坑得注意。

**核心脚本位置**：`/Users/berta/Desktop/爱问答/joy-music-mobile-master/scripts/build-unsigned-ipa.sh`

下面命令都假设你已经 `cd` 到仓库根目录 `/Users/berta/Desktop/爱问答/joy-music-mobile-master/`，所以引用脚本写成相对路径 `./scripts/build-unsigned-ipa.sh`。

## 前置检查

```bash
# 1. VPN 代理必须开（127.0.0.1:7890）
nc -z 127.0.0.1 7890 && echo "代理 OK" || echo "代理没开！"

# 2. Xcode、CocoaPods、Node 都装着
xcodebuild -version
pod --version
node --version

# 3. 工程目录干净（推荐）
cd /Users/berta/Desktop/爱问答/joy-music-mobile-master
git status
```

如果 `pod --version` 报 `find_spec_for_exe: can't find gem cocoapods`，说明 rvm gem 残留，跑一次：
```bash
gem install cocoapods --no-document
```

## 标准流程（绝大多数情况就这一条命令）

```bash
cd /Users/berta/Desktop/爱问答/joy-music-mobile-master

# 升版本号（可选；不改也能打）
npm run release:version -- 1.3.1

# 构建。改了 JS / 没动 app.json plugins → 加 --skip-prebuild 几分钟搞定
./scripts/build-unsigned-ipa.sh --skip-prebuild

# 改了 app.json / plugins / 第一次构建 → 不加 --skip-prebuild，全量约 15-20 分钟
# ./scripts/build-unsigned-ipa.sh
```

产物在仓库根目录：`YueYin-<version>-unsigned.ipa`，约 16 MB。

脚本已经处理：
- 自动探测代理，监听就 export
- 自动 `bundle install` + `bundle exec pod install`（绕开 rvm pod shim 那个坑）
- **第一次 archive 必失败**（RN 0.81 + 新架构的 codegen 路径错位 bug）→ 自动 rsync codegen → 第二次 archive 成功
- `--skip-prebuild` 模式下自动用 PlistBuddy 同步 `ios/app/Info.plist` 的版本号

构建完会自检并打印 IPA 内的 CFBundleIdentifier / 版本号，注意看一眼是不是预期的（`com.joymusic.mobile1` + 你的版本）。

## 提交 + 打 tag

```bash
git add -A
git commit -m "release v1.3.1: 改了 X"
git tag -a v1.3.1 -m "v1.3.1 — 改了 X"
```

## 常见翻车 + 解法

### A. xcodebuild 报 `Build input file cannot be found: ios/build/generated/ios/...`

**预期会发生**，脚本会自动处理。如果脚本反而提早退出说"archive 仍未成功"，多半是脚本判定逻辑出错。手动跑一次：
```bash
GEN=$(find ~/Library/Developer/Xcode/DerivedData -type d \
  -path "*/ReactCodegen.build/DerivedSources/generated/source/codegen/out/build/generated/ios" \
  2>/dev/null | tail -n 1)
mkdir -p ios/build/generated/ios
rsync -a "$GEN/" ios/build/generated/ios/

# 然后重跑 xcodebuild archive（脚本里那一段，注意带代理 env）
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=http://127.0.0.1:7890
xcodebuild -workspace ios/app.xcworkspace -scheme app \
  -configuration Release -sdk iphoneos -destination "generic/platform=iOS" \
  -archivePath ios/build/app.xcarchive \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  archive

# 打 IPA
APP_VERSION=$(node -p "require('./app.json').expo.version")
rm -rf dist && mkdir -p dist/Payload
cp -R ios/build/app.xcarchive/Products/Applications/app.app dist/Payload/
( cd dist && zip -qry "../YueYin-${APP_VERSION}-unsigned.ipa" Payload )
```

### B. `bundle install` 卡半天没动静

肯定是代理没开。先 `nc -z 127.0.0.1 7890`，确认监听后再跑。

### C. `npx expo prebuild` 末尾报 pod install 失败

可以无视。脚本后面会用 `bundle exec pod install` 替代。

### D. IPA 自检显示版本号 / bundleId 不对

- 版本号不对：`--skip-prebuild` 时 ios/app/Info.plist 没同步。脚本里 `sync_info_plist_version()` 应该会处理，如果没生效，手动改 `ios/app/Info.plist` 的两个 `CFBundleShortVersionString` / `CFBundleVersion`，再重跑 archive。
- bundleId 不对：检查 `app.json` 里 `expo.ios.bundleIdentifier` 是不是 `com.joymusic.mobile1`，以及 `ios/app.xcodeproj/project.pbxproj` 里 `PRODUCT_BUNDLE_IDENTIFIER` 也是这个。

### E. 想从头来一次（清干净所有 build 缓存）

```bash
rm -rf ios node_modules
git clean -xfd        # ⚠️ 会删所有未追踪的文件，确认 ipa 已经备份
npm ci
./scripts/build-unsigned-ipa.sh
```

## 重签提醒

签名工具如果有 "Make Bundle ID Unique" / "Change Bundle ID" 之类选项，**关掉**。否则又会给你加 `1` 变成 `com.joymusic.mobile11`，导致设备上多出一个 app。

## 想回到某个稳定版

```bash
git tag                    # 看所有 tag
git checkout v1.3.0        # 切到 v1.3.0 看代码
git checkout -b try v1.3.0 # 从 v1.3.0 拉分支改东西
git checkout main          # 回主线
```
