# Changelog

本文件记录用户可见变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 和 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

- **日常开发**：把尚未随安装包发出的改动写在 `[Unreleased]`。
- **发布新版本**：把 `[Unreleased]` 里的条目移到新版本标题下（如 `[0.1.1] - YYYY-MM-DD`），同步 `package.json` 的 `version`，再打 `v*` 标签。GitHub Release 说明可从该版本章节复制。

## [Unreleased]

## [0.2.1] - 2026-08-25

- 修复安装包因 `"type": "module"` 把预加载脚本当成 ESM，导致无法新建采集、打开/对比/导出 Capture Pack 的问题
- 主界面铭牌改为厂商/型号一行、固件/位置一行，避免型号被截断

## [0.2.0] - 2026-08-25

- 使用项目图标替换 Electron 默认图标（macOS / Windows）
- macOS：ad-hoc 签名，Gatekeeper 提示「无法验证开发者」而非「已损坏」；在「隐私与安全性」中允许
- Windows：安装包无 Authenticode 签名；SmartScreen 可能提示未知发布者，选择「更多信息 → 仍要运行」
- 修复已创建的 GitHub Release 无法挂上安装包、SHA256SUMS 步骤报 `no assets to download` 的问题

## [0.1.0] - 2026-08-24

- 离线采集客户端：探测、手工登录采集、HTTP/WS、脱敏导出 Capture Pack
- 暂停/继续、多作业、独立 JSON Schema、本地打开/对比 Capture Pack、现场铭牌备注
- 登录后 Cookie 复验（值不落盘）、HTTP/WS `windowRole`
- GitHub Actions CI 与安装包发布 workflow
