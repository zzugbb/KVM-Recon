# 安全说明

KVM-Recon 在机房内访问 BMC 管理口，导出的 Capture Pack 可能包含内网地址、主机名、证书摘要和已脱敏的 HTTP/WebSocket 元数据。请把 Capture Pack 当作**内部敏感资料**保管，不要把未审核的 zip 发到公共 Issue 或公开讨论区。

## 本工具保证与不做的事

- 不把明文密码写入导出包。
- 不保存完整 KVM 视频码流。
- Cookie 值不落盘；登录后复验只记录 Cookie **名称**。
- storage 只导出 key，不导明文。
- 不做 MITM，不代填登录，不在机房调用外部分析服务。

## 报告漏洞

请使用仓库的 [GitHub Security Advisories](https://github.com/zzugbb/KVM-Recon/security/advisories/new) 私下报告。不要在公开 Issue 里贴：

- BMC 账号、密码、Cookie、Token
- 未脱敏的 Capture Pack 或 HAR
- 内网拓扑、未公开的漏洞利用细节

我们会确认影响范围，并在修复后按需发布安全说明。

## 发布产物

GitHub Releases 中的 macOS / Windows 安装包未使用 Apple / 微软付费开发者证书。macOS 为 ad-hoc 签名，下载后若提示无法验证开发者，在「系统设置 → 隐私与安全性」中允许即可。Windows 无 Authenticode 签名，SmartScreen 若拦截，选择「更多信息 → 仍要运行」。详见 `docs/offline-field-guide.md`。下载后请核对 checksum，并只从本仓库 Releases 获取安装包。
