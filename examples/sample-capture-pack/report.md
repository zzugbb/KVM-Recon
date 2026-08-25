# KVM-Recon Capture Report

离场适配就绪：PARTIAL

阻断项：0
警告项：1

## 检查项
- BMC 基础连接：pass / blocking；证据：https://10.0.0.10:443, tls:TLSv1.2；补采动作：无
- BMC 协议族指纹：pass / warning；证据：ami-megarac:0.9, /api/randomtag, /api/session, /api/kvm/token；补采动作：无
- 登录链路 HTTP 资料：pass / blocking；证据：login-1；补采动作：无
- HTML5 KVM 入口：pass / blocking；证据：#kvm, token-1；补采动作：无
- KVM 关键 HTTP API：pass / warning；证据：token-1；补采动作：无
- KVM WebSocket：pass / blocking；证据：ws-1；补采动作：无
- KVM 画面截图：missing / warning；证据：无；补采动作：打开 HTML5 KVM 后会自动截图，无需再点「采集当前画面」。
- TLS 证书信息：pass / info；证据：TLSv1.2, CN=bmc.local；补采动作：无
- 导出脱敏检查通过：pass / blocking；证据：redactedFields=3；补采动作：无

## 现场补采提示
- KVM 画面截图：打开 HTML5 KVM 后会自动截图，无需再点「采集当前画面」。

## 阅读说明

- 本文件只列就绪结论和检查项。出机房后先读根目录 `README.md`。
