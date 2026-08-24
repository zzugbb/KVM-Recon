# 发布说明

本文说明如何用 GitHub 构建并发布 KVM-Recon 桌面安装包。现场机房通常无公网，安装包必须在联网环境生成后拷入现场。

## 产物

| 平台 | Runner | 格式 |
| --- | --- | --- |
| macOS | `macos-latest` | dmg / zip（x64 + arm64） |
| Windows | `windows-latest` | NSIS 安装包 / zip（x64） |

默认**不代码签名、不公证**。macOS 首次打开可能需要「系统设置 → 隐私与安全性」允许；Windows 可能出现 SmartScreen 提示。这是未签名构建的预期行为，不是功能缺口。

## 从 GitHub 发正式版

1. 更新 `package.json` 的 `version` 与 `CHANGELOG.md`。
2. 提交到 `main`。
3. 打 annotated tag 并推送：

```bash
git tag -a v0.1.0 -m "KVM-Recon 0.1.0"
git push origin v0.1.0
```

4. 标签匹配 `v*` 时，`.github/workflows/release.yml` 会在 macOS 与 Windows 上构建，并用 `GITHUB_TOKEN` 上传到 GitHub Release。

不要把本机 `release/` 目录提交进 git。

## 只构建、不发 Release

在 GitHub Actions 里手动运行 **Package** workflow（`workflow_dispatch`）。产物作为 Artifact 下载，不会创建 GitHub Release。用于验证打包脚本。

## 本机构建

```bash
npm ci
npm run package:mac
npm run package:win
```

`package:win` 需要 Windows 或可交叉编译的环境；推荐用 GitHub 的 `windows-latest`，避免在 macOS 上交叉打 Windows 包。

## 以后若要签名

不要把证书写入仓库。在仓库 Secrets 中配置 electron-builder 所需的 `CSC_LINK` / `CSC_KEY_PASSWORD`（Windows）以及 Apple 公证相关变量，再去掉 Release workflow 里的 `CSC_IDENTITY_AUTO_DISCOVERY=false`。在此之前保持未签名发布。

## 校验

下载安装包后：

1. 核对本仓库 Release 页面，而不是第三方镜像。
2. 对照 Release 附带的 checksum。
3. 在隔离机器上打开，确认窗口标题为 `KVM-Recon`，且无公网也可新建作业。
