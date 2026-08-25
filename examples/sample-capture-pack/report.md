# KVM-Recon Capture Report

离场适配就绪：PARTIAL

阻断项：0
警告项：1

## 检查项
- BMC 基础连接：pass / blocking；证据：https://10.0.0.10:443；补采动作：无
- KVM WebSocket：pass / blocking；证据：ws-1；补采动作：无
- KVM 画面截图：missing / warning；证据：无；补采动作：打开 HTML5 KVM 后会自动截图，无需再点「采集当前画面」。

## 现场补采提示
- KVM 画面截图：打开 HTML5 KVM 后会自动截图，无需再点「采集当前画面」。

## 离场后怎么用

- KVM-Recon 不在机房写 Adapter，也不调用公网分析服务。
- 出机房联网后，把本 zip 交给工程师或 AI，并阅读 `README.md`。
