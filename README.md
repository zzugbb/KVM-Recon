# KVM-Recon

**简体中文** | [English](README.en.md)

[![CI](https://github.com/zzugbb/KVM-Recon/actions/workflows/ci.yml/badge.svg)](https://github.com/zzugbb/KVM-Recon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/zzugbb/KVM-Recon?include_prereleases)](https://github.com/zzugbb/KVM-Recon/releases)

**BMC / HTML5 KVM 离线证据采集工具**

KVM-Recon 是面向机房现场的离线桌面客户端：记录操作员「登录 BMC → 打开 HTML5 KVM」时浏览器实际观察到的请求、正文、脚本、实时通道与画面，并手动导出 Capture Pack 2.0。采集不依赖厂商、型号或协议族规则。包内资料**未脱敏**，离场后由工程师或 AI 研究适配。

0.3.0 使用 Capture Pack 2.0。历史 0.2.x 版本的旧包和 YES/PARTIAL/NO 结果不能当作 2.0 完整度结论。

[下载安装包](https://github.com/zzugbb/KVM-Recon/releases/tag/v0.3.0) · [现场操作](docs/field-guide.md) · [阅读采集包](docs/capture-pack-guide.md) · [文档导航](docs/README.md)

## 项目定位

- 这是离线采集工具，**不是**生产 KVM 网关，也不提供用户远程控制台。
- 不依赖公网，不在机房内调用外部分析服务。
- 现场人员只需填写 BMC 地址与可选设备说明，手工登录并打开 HTML5 KVM；导出仍由用户手动触发。
- 本工具**不写 Adapter**。

包只声明 `captureIntegrity`（COMPLETE/INCOMPLETE）与 `workflowStatus`（是否观察到 KVM 等阶段）；没有协议族分类状态。未知架构只要证据和门禁满足要求，同样可以 COMPLETE。完整度不是“保证能一次写出 Adapter”，而是对采集器已观察证据的可验证结论。

## 下载

从 [v0.3.0 正式版](https://github.com/zzugbb/KVM-Recon/releases/tag/v0.3.0) 获取 macOS 与 Windows 安装包，并核对 `SHA256SUMS.txt`。维护者发版步骤见 [发布指南](docs/releasing.md)。

当前构建**未使用 Apple / 微软付费开发者证书**：

- **macOS**：ad-hoc 签名。从浏览器下载后若提示无法验证开发者，在「系统设置 → 隐私与安全性」中允许即可。
- **Windows**：无 Authenticode 签名。SmartScreen 若提示已保护你的电脑或未知发布者，点「更多信息 → 仍要运行」。

0.3.0 现场流程见 [现场说明](docs/field-guide.md)。历史 0.2.x 说明可从对应 Git 标签获取。

## 现场流程

1. 在机房内安装并打开 KVM-Recon。
2. 输入 BMC 地址；可选在另一个输入框填写自由文本设备说明（厂商/型号可写在一起）。
3. 开始采集，工具打开独立浏览器并记录 TLS/Redfish 补充事实。
4. 内嵌浏览器打开 BMC，现场人员按需**手工**登录。
5. 点击 HTML5 KVM 入口，等待 Viewer 画面出现；弹出的 Viewer 窗口保持打开。
6. 工具自动记录 Chromium 可观察的 HTTP、WebSocket、脚本/Worker、页面状态、截图与其他实时通道；包内同时生成含已取得正文的 `raw/http/session.har`，无需另行从 Chrome 导出 HAR。无法读取的正文或源码会在包内标记缺口；HAR 不等同于底层网络抓包。
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

- `npm test`：单测与 Mock KVM 样例、Schema、导出验证。
- `npm run test:e2e`：Electron 真实浏览器采集与协议 Fixture 回放（需先 build）。设置 `KVM_RECON_FIELD_COLLECTION_2` 可选启用现场 HAR 回放；若还设置 `KVM_RECON_FIELD_HAR_ALL=1`，则回放全部 16 份 HAR。未设置语料目录时，现场 HAR 回放会跳过。
- `npm run package:mac` / `npm run package:win`：本机构建安装包；正式发版请打 `v*` 标签，见 `docs/releasing.md`

## 文档

从[文档导航](docs/README.md)按现场采集、离线分析、开发或发布选择阅读入口。

- [现场操作](docs/field-guide.md)：采集、收尾、导出与异常恢复。
- [采集包阅读指南](docs/capture-pack-guide.md)：完整度、证据索引、原始资料与 Replay 的阅读顺序。
- [开发规范](docs/v0.3-development-spec.md)：Capture Pack 2.0 契约与实现边界。
- [项目状态与验证基线](docs/status.md)：当前能力、验证证据及覆盖范围。
- [发布指南](docs/releasing.md)：构建、签名与安装包发布。
- [Schema](schema/2.0/README.md)与[合成样例](examples/README.md)：结构校验和包内文件示例。
- [版本记录](CHANGELOG.md)、[贡献指南](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md)与[安全说明](SECURITY.md)。

## 安全与边界

- 原始采集包可能包含明文密码、Cookie、Token 和实时通道 payload；只在受控环境保存、传输和分析，禁止上传公开 Issue。
- 不会做：自动登录、MITM、机房内调 AI、自动写 Adapter、完整视频解码。
- 漏洞请走 [Security Advisories](https://github.com/zzugbb/KVM-Recon/security/advisories/new)，不要在 Issue 里贴凭证或未脱敏资料包。

## 许可

[MIT](LICENSE)
