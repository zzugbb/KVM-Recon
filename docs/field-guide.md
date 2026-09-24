# 现场采集说明（0.3.0）

> 本说明适用于 0.3.0 的 Capture Pack 2.0 流程。历史 0.2.x 版本的界面与资料格式不同。

1. 在无公网的现场电脑打开 KVM-Recon，输入 BMC 地址；设备说明可填写任意字符串（例如厂商/型号）。
2. 点击开始采集。内嵌浏览器出现后，像平时一样手工登录 BMC，点击 HTML5 KVM，等待 Viewer 画面出现。若打开弹窗，保持弹窗打开。
3. 采集器观察到 Viewer 活动并稳定后会收尾，但**不会自动导出**。如未自动收尾，可用界面结束采集。
4. 查看主界面的完整度与缺口。点击导出采集包；即使标为 INCOMPLETE，也可导出供离线排查，但不要当作完整资料。
5. 导出后核对 ZIP 路径和大小。包内从 `00_START_HERE.md`、`ai/index.json`、`ai/adapter-dossier.json` 开始阅读，再按证据路径打开原始 HTTP、脚本、截图与实时通道资料。

包内 `raw/http/session.har` 可供常见 HAR 工具直接读取；更完整的原始请求/响应正文位于 `raw/http/bodies/`，索引在 `catalog/resources.jsonl`。现场不需要另开 Chrome 开发者工具手动导出 HAR。

采集器不要求选择协议族，也不按厂商决定是否保存正文。TLS/Redfish 是可选补充事实，探测失败不阻断浏览器采集。包的 `captureIntegrity` 与 `workflowStatus` 依据观察到的证据和门禁得出，并不保证任意设备都能只凭一包完成网关 Adapter。

**安全：**Capture Pack 2.0 不脱敏，可能含明文凭据、Cookie、Token 和 KVM 通道 payload。不要上传公网、公开 Issue 或未经授权的共享位置。将包按内部敏感资料保存和传输。
