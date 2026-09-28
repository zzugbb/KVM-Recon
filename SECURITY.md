# 安全说明

KVM-Recon 在机房内访问 BMC 管理口。Capture Pack 2.0 **未脱敏**，可能包含内网地址、口令、Cookie、会话令牌、请求正文和实时通道载荷。请把 Capture Pack 当作**内部敏感资料**保管，不要把 zip 发到公共 Issue 或公开讨论区。

## 数据范围与工具边界

- 原始 HTTP 请求与响应、HAR、浏览器 Storage 和实时通道帧会按 Chromium 可观察到的内容保存；其中可能包含明文密码、Cookie 值、Token 和视频载荷。
- 采集工作区、崩溃恢复资料与导出的 Capture Pack 都可能含未脱敏数据，须按内部敏感资料保管。
- 不自动上传资料，不做 MITM，不代填登录，不在机房调用外部分析服务。

## 报告漏洞

请使用仓库的 [GitHub Security Advisories](https://github.com/zzugbb/KVM-Recon/security/advisories/new) 私下报告。不要在公开 Issue 里贴：

- BMC 账号、密码、Cookie、Token
- 未脱敏的 Capture Pack 或 HAR
- 内网拓扑、未公开的漏洞利用细节

我们会确认影响范围，并在修复后按需发布安全说明。

## 发布产物

GitHub Releases 中的 macOS / Windows 安装包未使用 Apple / 微软付费开发者证书。macOS 为 ad-hoc 签名，下载后若提示无法验证开发者，在「系统设置 → 隐私与安全性」中允许即可。Windows 无 Authenticode 签名，SmartScreen 若拦截，选择「更多信息 → 仍要运行」。详见 `docs/field-guide.md`。下载后请核对 checksum，并只从本仓库 Releases 获取安装包。
