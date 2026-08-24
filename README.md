# KVM-Recon

[![CI](https://github.com/zzugbb/KVM-Recon/actions/workflows/ci.yml/badge.svg)](https://github.com/zzugbb/KVM-Recon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/zzugbb/KVM-Recon?include_prereleases)](https://github.com/zzugbb/KVM-Recon/releases)

Offline BMC/KVM Discovery & Compatibility Toolkit / KVM 离线探测与兼容性采集工具。

KVM-Recon 是面向机房现场的离线桌面客户端：采集「登录 BMC → 打开 HTML5 KVM → 建立相关 HTTP/WebSocket」的事实资料，导出脱敏 Capture Pack。离开机房、联网之后，再把资料包交给工程师或 AI 做网关兼容分析。

## 项目定位

- 这是离线采集工具，**不是**生产 KVM 网关，也不提供用户远程控制台。
- 不依赖公网，不在机房内调用外部分析服务。
- 现场人员可以辅助登录、点击菜单、打开 HTML5 KVM；工具负责记录适配所需资料。
- 本工具**不写 Adapter**。

主键是 `kvmFamily`（`ami-megarac` / `openbmc-h5` / `huawei-ibmc` / `unknown-h5` / `not-h5`），不是厂商 Logo 或型号字符串。现场铭牌（厂商/型号/固件/位置）只作为证据。

## 下载

安装包在维护者推送 `v*` 标签后由 GitHub Actions 生成，发布到 [Releases](https://github.com/zzugbb/KVM-Recon/releases)。若尚无 Release，请按下面「开发」从源码构建，或按 `docs/releasing.md` 打一次标签。

当前构建**未代码签名、未公证**。请只从本仓库 Releases 下载，并核对 `SHA256SUMS.txt`。现场步骤见 `docs/offline-field-guide.md`。

## 现场流程

1. 在机房内安装并打开 KVM-Recon。
2. 输入 BMC 地址、端口；可选填写现场厂商、型号、固件、机柜位置和作业备注。
3. 开始采集，工具执行基础探测与 TLS/指纹采集。
4. 内嵌浏览器打开 BMC，现场人员按需**手工**登录。
5. 点击 HTML5 KVM 入口，等待 viewer 与 WebSocket。若 KVM 开在新窗口，把新窗口留在前台至少 10 秒。
6. 工具记录 HTTP、WebSocket、页面、截图、storage key、TLS、指纹和 checklist。
7. 导出 Capture Pack。出机房后阅读包内 `artifacts/handover.md`。

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

- `npm test`：单测 + 本地 mock BMC 的探测/脱敏/zip 闭环
- `npm run test:e2e`：启动 Electron 主窗口，加载成功后退出（需先 build）
- `npm run package:mac` / `npm run package:win`：本机构建；CI 在 tag `v*` 时发布到 Releases

## 文档

- `docs/development-plan.md`：分阶段计划、采集侧收口、真机闸门与项目边界
- `docs/mvp-architecture.md`：技术架构与模块边界
- `docs/capture-pack-spec.md`：Capture Pack 目录与数据契约
- `docs/offline-field-guide.md`：离线安装与现场采集
- `docs/releasing.md`：GitHub Actions 打包与 Release
- `schema/`：Capture Pack JSON Schema
- `CHANGELOG.md`：版本记录
- `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / `LICENSE`：GitHub 仓库页顶栏会自动列出，给贡献者和安全报告用；现场采集请看上面的「下载」和「现场流程」

## 安全与边界

- 不保存明文密码；Cookie 值不落盘；不保存完整 KVM 视频码流。
- 不会做：自动登录、MITM、机房内调 AI、自动写 Adapter、完整视频解码。
- 漏洞请走 [Security Advisories](https://github.com/zzugbb/KVM-Recon/security/advisories/new)，不要在 Issue 里贴凭证或未脱敏资料包。

## 许可

[MIT](LICENSE)
