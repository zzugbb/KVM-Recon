# Capture Pack 离场交接说明

KVM-Recon 是机房离线采集工具，不是 KVM 网关，也不会根据本包在现场编写 Adapter。
机房内通常没有公网；分析、写 Profile/Adapter 应在出机房并联网之后进行。

## 本包摘要

- kvmFamily：ami-megarac
- 离场结论：PARTIAL
- HTTP 请求：2
- WebSocket 连接：1
- 页面截图：0
- 现场厂商：AMI
- 现场型号：MegaRAC SPX
- 现场固件：1.0.0
- 机柜位置：Lab rack A
- 作业备注：Sample pack for offline handoff format review.
- 现场厂商/型号只是铭牌证据，不能替代 kvmFamily。

## 出机房后建议

1. 打开 `report.html` 或 `checklist.json`，确认 YES / PARTIAL / NO。
2. 将本 zip 交给工程师或 AI，重点阅读 `probe/`、`http/`、`ws/`、`page/`、`tls/`。
3. 已知族草稿在 `artifacts/oem-profile.yaml`，供出机房后人工或 AI 审核，不是可直接上线的 Adapter。
4. 若结论为 NO 或关键项缺失，按报告回现场补采，不要用残缺包硬写网关。
