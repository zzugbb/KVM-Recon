# 发布说明

维护者用本文生成 macOS / Windows 安装包。现场机房通常无公网，安装包须在联网环境做好再拷入现场。

## 产物

| 平台 | 环境 | 格式 |
| --- | --- | --- |
| macOS | GitHub `macos-latest` 或本机 | dmg / zip（x64 + arm64） |
| Windows | GitHub `windows-latest` | NSIS 安装包 / zip（x64） |

当前构建**未代码签名、未公证**。macOS 可能需在「隐私与安全性」中允许打开，Windows 可能出现 SmartScreen 提示。

不要把本机 `release/` 目录提交进 git。

## 发布到 GitHub Releases

1. 更新 `package.json` 的 `version` 与 `CHANGELOG.md`，提交到 `main`。
2. 创建 GitHub Release（标签如 `v0.1.0`，目标分支 `main`），填写标题和说明。不要在网页上上传 dmg/exe。
3. 也可以只打标签并推送：

```bash
git tag -a v0.1.0 -m "KVM-Recon 0.1.0"
git push origin v0.1.0
```

4. 标签匹配 `v*` 或在 Actions 里手动运行 **Release** 并填写标签后，workflow 会构建安装包并挂到该 Release，再附 `SHA256SUMS.txt`。

仓库里的 `CHANGELOG.md` 在改版本号时更新即可。GitHub Release 说明写在发布页，不必再抄一遍到其它文档。

下一版重复上述步骤，使用新的版本号和标签。若某次构建成功但 Release 上没有安装包，在 Actions 打开 **Release** → Run workflow，填同一个标签即可补传。

## 只构建、不发版

在 Actions 中手动运行 **Build installers**，从这次 run 的 Artifact 下载 `kvm-recon-macos` / `kvm-recon-windows`。

## 本机构建

```bash
npm ci
npm run package:mac
```

Windows 安装包请用 GitHub 的 Windows runner（**Build installers** 或 **Release**），避免在 macOS 上交叉编译。产物目录为 `release/`。

## 签名（可选）

不要把证书写入仓库。需要签名时，在仓库 Secrets 配置 electron-builder 所需变量，并去掉 Release workflow 中的 `CSC_IDENTITY_AUTO_DISCOVERY=false`。

## 校验

1. 只从本仓库 GitHub Releases 下载。
2. 对照 `SHA256SUMS.txt`。
3. 无公网环境下应能打开应用并新建采集作业。
