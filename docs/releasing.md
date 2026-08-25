# 发布说明

维护者用本文生成 macOS / Windows 安装包。现场机房通常无公网，安装包须在联网环境做好再拷入现场。

## 产物

| 平台 | 环境 | 格式 |
| --- | --- | --- |
| macOS | GitHub `macos-latest` 或本机 | dmg / zip（x64 + arm64） |
| Windows | GitHub `windows-latest` | NSIS 安装包 / zip（x64） |

当前构建**未使用 Apple / 微软付费开发者证书**：

| 平台 | 签名 | 下载后常见提示 | 处理 |
| --- | --- | --- | --- |
| macOS | ad-hoc（不是 Apple 公证） | 无法验证开发者 | 「系统设置 → 隐私与安全性」允许 |
| Windows | 无 Authenticode | SmartScreen：已保护你的电脑 / 未知发布者 | 「更多信息 → 仍要运行」 |

现场步骤见 `docs/offline-field-guide.md`。

不要把本机 `release/` 目录提交进 git。

## 发布到 GitHub Releases

1. 更新 `package.json` 的 `version` 与 `CHANGELOG.md`，提交到 `main`。
2. 创建 GitHub Release（标签如 `v0.2.0`，目标分支 `main`），填写标题和说明。不要在网页上上传 dmg/exe。
3. 也可以只打标签并推送：

```bash
git tag -a v0.2.0 -m "KVM-Recon 0.2.0"
git push origin v0.2.0
```

4. 标签匹配 `v*` 或在 Actions 里手动运行 **Release** 并填写标签后，workflow 会构建安装包并挂到该 Release，再附 `SHA256SUMS.txt`。

仓库里的 `CHANGELOG.md` 是版本历史：平时改动写在 `[Unreleased]`，发新版时挪到新版本号下。GitHub Release 说明可从该版本章节复制，不必再改 README。

下一版重复上述步骤，使用新的版本号和标签。若某次构建成功但 Release 上没有安装包，在 Actions 打开 **Release** → Run workflow，填同一个标签即可补传。

## 只构建、不发版

在 Actions 中手动运行 **Build installers**，从这次 run 的 Artifact 下载 `kvm-recon-macos` / `kvm-recon-windows`。

## 本机构建

```bash
npm ci
npm run package:mac
```

Windows 安装包请用 GitHub 的 Windows runner（**Build installers** 或 **Release**），避免在 macOS 上交叉编译。产物目录为 `release/`。

## 签名

当前默认：macOS 使用 ad-hoc 签名（不需要 Apple 账号）；Windows 不签名（无 Authenticode）。打开时的系统提示见上文表格与 `docs/offline-field-guide.md`。

若以后要用 Apple Developer ID 并公证，或 Windows Authenticode / EV 证书，把证书放在仓库 Secrets，不要写入 git。

## 校验

1. 只从本仓库 GitHub Releases 下载。
2. 对照 `SHA256SUMS.txt`。
3. 无公网环境下应能打开应用并新建采集作业。
