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

现场步骤见[现场指南](field-guide.md)。

不要把本机 `release/` 目录提交进 git。

## 发布到 GitHub Releases

0.3.0 已于 2026-09-28 [正式发布](https://github.com/zzugbb/KVM-Recon/releases/tag/v0.3.0)。以下流程供后续版本使用：维护者可先用下文 **Build installers** 试构建；将版本变更提交到 `main`，确认本地验收和该提交的 CI 均通过后，再创建对应 Release 和标签。实际发布日期以 GitHub Release 为准。

当前 Release workflow 用 `gh release upload` 上传附件，**要求 GitHub Release 已经存在**。只打 tag 并推送不够：没有对应 Release 时，构建产物无法挂上。

顺序：

```text
核对版本与发布说明
→ 提交 main
→ 创建 GitHub Release/tag
→ workflow 构建并上传附件
```

1. 核对 `package.json` 与 `package-lock.json` 的版本一致，`CHANGELOG.md` 有对应版本章节，并把待发布变更提交到 `main`。Release workflow 会校验标签、版本和 CHANGELOG 章节。
2. 创建 GitHub Release（标签如 `vX.Y.Z`，目标分支 `main`），填写标题和说明。不要在网页上上传 dmg/exe。
3. 标签匹配 `v*` 后，workflow 会构建安装包并挂到**已有** Release，再附 `SHA256SUMS.txt`。也可在 Actions 里手动运行 **Release**，填写同一个已有标签（例如 `vX.Y.Z`）。

仓库里的 `CHANGELOG.md` 是版本历史：计划在后续安装包发布的功能、行为修复或安全变化写在 `[Unreleased]`；纯文档整理及不改变应用行为的依赖维护无需逐项记录或更新版本号。GitHub Release 说明可从对应版本章节复制。如需要，也可在发版后补记真实发布日期；这不是创建 Release 的前置条件。

下一版重复上述步骤，使用新的版本号和标签。若某次构建成功但 Release 上没有安装包，在 Actions 打开 **Release** → Run workflow，填同一个已有标签即可补传。

## 只构建、不发版

在 Actions 中手动运行 **Build installers**，从这次 run 的 Artifact 下载 `kvm-recon-macos` / `kvm-recon-windows`。

## 本机构建

```bash
npm ci
npm run package:mac
```

Windows 安装包请用 GitHub 的 Windows runner（**Build installers** 或 **Release**），避免在 macOS 上交叉编译。产物目录为 `release/`。

如以后启用 Apple Developer ID / 公证或 Windows 签名，证书通过仓库 Secrets 配置，不提交到 Git。

发布工作流负责版本门禁、构建、上传和 checksum，不运行单测或 E2E；因此发布前必须独立确认目标提交的 CI / 验收结果，试构建成功也不代表采集验证通过。

## 校验

1. 只从本仓库 GitHub Releases 下载。
2. 对照 `SHA256SUMS.txt`。
3. 无公网环境下应能打开应用并新建采集作业。
