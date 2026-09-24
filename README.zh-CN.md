# KVM-Recon

[English](README.md) | **简体中文**

[![CI](https://github.com/zzugbb/KVM-Recon/actions/workflows/ci.yml/badge.svg)](https://github.com/zzugbb/KVM-Recon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/zzugbb/KVM-Recon?include_prereleases)](https://github.com/zzugbb/KVM-Recon/releases)

Offline BMC/KVM Evidence Capture / BMC KVM 离线证据采集工具。

KVM-Recon 是面向机房现场的离线桌面客户端：记录操作员「登录 BMC → 打开 HTML5 KVM」时浏览器实际观察到的请求、正文、脚本、实时通道与画面，并手动导出 Capture Pack 2.0。采集不依赖厂商、型号或协议族规则。包内资料**未脱敏**，离场后由工程师或 AI 研究适配。

主分支正在开发 0.3.0；GitHub 已发布的 0.2.10 是旧格式和旧界面，不能把旧包的 YES/PARTIAL/NO 当作 2.0 完整度结论。

界面与现场说明目前是中文。GitHub 访客请看英文 [README.md](README.md)。

## 界面预览

界面以单作业工作台为准；仓库中的历史截图不代表当前开发版本。

## 项目定位

- 这是离线采集工具，**不是**生产 KVM 网关，也不提供用户远程控制台。
- 不依赖公网，不在机房内调用外部分析服务。
- 现场人员只需填写 BMC 地址与可选设备说明，手工登录并打开 HTML5 KVM；导出仍由用户手动触发。
- 本工具**不写 Adapter**。

包只声明 `captureIntegrity`（COMPLETE/INCOMPLETE）与 `workflowStatus`（是否观察到 KVM 等阶段）；没有协议族分类状态。未知架构只要证据和门禁满足要求，同样可以 COMPLETE。完整度不是“保证能一次写出 Adapter”，而是对采集器已观察证据的可验证结论。

## 下载

从 [GitHub Releases](https://github.com/zzugbb/KVM-Recon/releases) 获取 macOS 与 Windows 安装包，并核对 `SHA256SUMS.txt`。维护者发版步骤见 `docs/releasing.md`。

当前构建**未使用 Apple / 微软付费开发者证书**：

- **macOS**：ad-hoc 签名。从浏览器下载后若提示无法验证开发者，在「系统设置 → 隐私与安全性」中允许即可。
- **Windows**：无 Authenticode 签名。SmartScreen 若提示已保护你的电脑或未知发布者，点「更多信息 → 仍要运行」。

0.3.0 开发版流程见 [现场说明](docs/field-guide.md)。已发布 0.2.10 的旧说明可从对应 Git 标签获取。

## 现场流程

1. 在机房内安装并打开 KVM-Recon。
2. 输入 BMC 地址；可选在同一输入框填写设备说明。
3. 开始采集，工具打开独立浏览器并记录 TLS/Redfish 补充事实。
4. 内嵌浏览器打开 BMC，现场人员按需**手工**登录。
5. 点击 HTML5 KVM 入口，等待 Viewer 画面出现；弹出的 Viewer 窗口保持打开。
6. 工具自动记录 HTTP、WebSocket、脚本/Worker、页面状态、截图与已观察到的其他实时通道。
7. 在主界面手动导出 Capture Pack。离场后按包内 `00_START_HERE.md` 阅读资料。

主窗口标题旁会显示当前工具版本（`vX.Y.Z`）；导出包还会写入 `manifest.tool.buildId`，用于确认现场包来自哪次构建。

## 开发

需要 Node.js 22+。

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run dev
```

- `npm test`：单测与 Mock KVM 样例、Schema、导出验证。现场语料通过 `KVM_RECON_FIELD_COLLECTION_2` 可选启用；未设置时跳过现场 HAR 回放。
- `npm run test:e2e`：Electron 真实浏览器采集与协议 Fixture 回放（需先 build）。
- `npm run package:mac` / `npm run package:win`：本机构建安装包；正式发版请打 `v*` 标签，见 `docs/releasing.md`

## 文档

索引见 `docs/README.md`。

- `docs/v0.3-development-spec.md`：0.3.0 权威开发规范（阶段 0–5 已实现，阶段 6 待验收）
- `docs/field-guide.md`：0.3.0 开发版现场操作
- `docs/releasing.md`：构建与发布安装包
- `docs/development-plan.md`：项目边界与当前状态
- `schema/2.0/`：Capture Pack 2.0 JSON Schema
- `CHANGELOG.md`：版本记录；发新版时把 `[Unreleased]` 收成版本号
- `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`LICENSE`

## 安全与边界

- 原始采集包可能包含明文密码、Cookie、Token 和实时通道 payload；只在受控环境保存、传输和分析，禁止上传公开 Issue。
- 不会做：自动登录、MITM、机房内调 AI、自动写 Adapter、完整视频解码。
- 漏洞请走 [Security Advisories](https://github.com/zzugbb/KVM-Recon/security/advisories/new)，不要在 Issue 里贴凭证或未脱敏资料包。

## 许可

[MIT](LICENSE)
