# KVM-Recon Capture Report

离场适配就绪：PARTIAL

阻断项：0
警告项：1

## 检查项
- BMC 基础连接已采集：pass / blocking；证据：https://10.0.0.10:443；补采动作：无
- KVM WebSocket 已建立并捕获帧：pass / blocking；证据：ws-1；补采动作：无
- viewer 页面截图已采集：missing / warning；证据：无；补采动作：请打开 HTML5 KVM 后把画面窗口留在前台，选择截图角色并点击“采集当前页面”。

## 现场补采提示
- viewer 页面截图已采集：请打开 HTML5 KVM 后把画面窗口留在前台，选择截图角色并点击“采集当前页面”。

## 离场后怎么用

- KVM-Recon 不在机房写 Adapter，也不调用公网分析服务。
- 出机房联网后，把本 zip 交给工程师或 AI，并阅读 `artifacts/handover.md`。
