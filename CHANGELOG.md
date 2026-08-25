# Changelog

本文件记录用户可见变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 和 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

- **日常开发**：把尚未随安装包发出的改动写在 `[Unreleased]`。
- **发布新版本**：把 `[Unreleased]` 里的条目移到新版本标题下（如 `[0.1.1] - YYYY-MM-DD`），同步 `package.json` 的 `version`，再打 `v*` 标签。GitHub Release 说明可从该版本章节复制。

## [Unreleased]

- 主窗口标题旁显示当前工具版本，与 `package.json` / 导出包 `manifest.tool.version` 一致
- README 改为英文默认入口，并提供 [简体中文](README.zh-CN.md)；补充主窗口整页截图
- `schema/` 增补 `page/timeline.jsonl`、`tls/certificate.json` 及页面/探测等导出文件的独立 JSON Schema
- 导出包根目录改为中文 `README.md`（阅读地图 + 适配前裁定），不再写 `artifacts/handover.md`
- 精简 `docs/development-plan.md` 为当前状态与边界，不再展开已完成阶段清单
- KVM 画面截图只认 `role=viewer`；仅登录页/异常页截图不再算已采集、不会因此升 YES
- 包内 `report.md` / `report.html` 只保留检查项，阅读说明指向根目录 `README.md`
- 补拍画面默认改为登录页；本地打开 zip 会检查截图是否带 role

## [0.2.2] - 2026-08-25

- 用 IP 打开 BMC 时采集窗口自动信任自签证书，避免 Chrome 能过「高级」而采集窗白屏；IP 访问不再设置 TLS SNI
- 「查看 → 采集窗口诊断」可显示加载失败与页面报错；采集窗口因 CDP 占用无法打开开发者工具
- 打开 HTML5 KVM 并收到画面数据后自动截图；已有画面时导出/补拍不再重复截
- 采集进度项名称不再带「已采集」，结果只显示在右侧状态列
- 下一步提示（登录 / 打开 KVM / 导出）改到操作按钮下方；就绪后显示「可导出」，导出后显示「已导出」

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
