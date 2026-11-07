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

当前已发布版本为 **0.3.3**，标签为 **`v0.3.3`**；macOS arm64 安装版实采验收结果见[验证基线](status.md#验证基线)。以下以该版本说明发布流程；后续发版须替换为新版本号，不重复创建或移动已有标签。发布说明取自 [CHANGELOG 的对应章节](../CHANGELOG.md#033---2026-11-07)。

1. 将版本准备提交推送到 `main`，确认该提交的 CI 通过。`package.json`、`package-lock.json` 和 CHANGELOG 章节须对应同一版本。
2. 打开 GitHub **Releases → Draft a new release**，创建新标签 **`v0.3.3`**，目标选已包含版本准备提交的 `main`，标题填写 **`KVM-Recon v0.3.3`**，粘贴更新日志后点击 **Publish release**。不要复用旧标签，无需手工上传安装包。
3. 发布 Release 会触发 **Release** workflow，按该标签的源码构建 macOS x64 / arm64 和 Windows x64 安装包，上传到该 Release，最后生成 `SHA256SUMS.txt`。等待三个 job 全部通过后再下载安装包。触发方式依据 [GitHub 的 release.published 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)。
4. 如需重跑，在 **Actions → Release → Run workflow** 中填写已有标签 **`v0.3.3`**。同标签发布任务串行运行；上传会替换同名附件。

仅创建草稿或推送标签不会自动构建；自动构建在发布 Release 后触发。手动运行同样要求对应 Release 已存在。工作流检查标签对应的源码、应用版本和 CHANGELOG 章节，并将包内 buildId 固定为该标签的提交，手动补传也不会误用运行工作流分支的提交号。依赖安装后会显式安装 Electron 二进制。

发版时将 `[Unreleased]` 归入对应版本及日期；下一版更新版本号和标签后重复上述流程。哪些变更需要版本记录见[贡献约定](../CONTRIBUTING.md#pull-request)。

## 只构建、不发版

在 Actions 中手动运行 **Build installers**，从这次 run 的 Artifact 下载 `kvm-recon-macos` / `kvm-recon-windows`。

## 本机构建

```bash
npm ci
npm run electron:install
npm run package:mac
```

Windows 安装包请用 GitHub 的 Windows runner（**Build installers** 或 **Release**），避免在 macOS 上交叉编译。产物目录为 `release/`。构建后运行 `npm run verify:packaged-docs`，检查实际 ASAR 内的文档相对链接；GitHub 打包与发布流程会在上传前执行同一检查。

如以后启用 Apple Developer ID / 公证或 Windows 签名，证书通过仓库 Secrets 配置，不提交到 Git。

发布工作流负责版本门禁、构建、上传和 checksum，不运行单测或 E2E；因此发布前必须独立确认目标提交的 CI / 验收结果，试构建成功也不代表采集验证通过。

## 校验

1. 只从本仓库 GitHub Releases 下载。
2. 对照 `SHA256SUMS.txt`。
3. 无公网环境下应能打开应用并新建采集作业。
