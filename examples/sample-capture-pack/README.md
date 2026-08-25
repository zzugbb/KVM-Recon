# KVM-Recon Capture Pack

这是一份**脱敏事实包**，用来给现有 KVM 网关做 HTML5 兼容适配。
KVM-Recon 只负责机房离线采集，**不写 Adapter**。解压后先读本文件即可，不必再打开采集工具仓库。

## 本包摘要

- kvmFamily：ami-megarac（置信度 0.9）
- 离场结论：PARTIAL。能分析，但可能缺项。先看未齐项，再决定写草稿还是回现场补采。
- HTTP 请求：2；WebSocket：1；KVM 画面截图：0
- WebSocket URL：wss://10.0.0.10/kvm
- 登录后复验：未做
- Cookie 名（无值）：（无）
- 未齐（阻断）：（无）
- 未齐（警告）：KVM 画面截图
- 现场厂商：AMI
- 现场型号：MegaRAC SPX
- 现场固件：1.0.0
- 机柜位置：实验室 A 柜
- 作业备注：样例包，仅用于说明导出目录与 README 格式。
- 现场厂商/型号只是铭牌证据，不能替代工具判定的采集桶。
- 已知族草稿在 `artifacts/oem-profile.yaml`，只供审核，不是可上线的 Adapter。

## 阅读顺序

1. 本文件。
2. `manifest.json`：作业、目标、kvmFamily、就绪结论。
3. `checklist.json` 或 `report.html`：缺什么、要不要补采。
4. 按「文件做什么」打开对应目录，不要通读全部 jsonl。

## 文件做什么

| 路径 | 用来回答 |
| --- | --- |
| `manifest.json` | 这是哪次作业、目标地址、工具判定的 kvmFamily |
| `checklist.json` / `report.html` | 离场能否适配、缺哪一项 |
| `probe/bmc-basic.json` | 匿名探测到的厂商/型号/固件（可能为空） |
| `probe/family-signatures.json` | 为何判成这一族、证据路径 |
| `probe/path-evidence.json` | 指纹路径是否命中（HTML 200 不算） |
| `probe/redfish.json` | Redfish 根是否通、根上的原始字段 |
| `probe/operator-observed.json` | 现场看铭牌填的厂商/型号（可选） |
| `probe/authenticated.json` | 登录后复验：Cookie 名和带会话后的路径（可选，无 Cookie 值） |
| `http/requests.jsonl` | 登录、KVM token、入口相关 HTTP；看 tags 与 URL |
| `http/har.json` | 同上，HAR 格式，便于用现成工具打开 |
| `ws/sockets.json` | KVM WebSocket 的 URL、子协议、帧数量、是否 popup |
| `ws/frames.jsonl` | 采样帧的 headHex / magic，不是完整视频 |
| `page/timeline.jsonl` | 打开了哪些页、点了什么、何时截图 |
| `page/selectors.json` | 登录/KVM 入口/viewer 的候选选择器 |
| `page/storage.json` | storage 的 key 列表，不含明文值 |
| `page/screenshots.json` 与 `page/screenshots/` | 证明当时画面形态，不是码流 |
| `tls/certificate.json` | 自签/协议/cipher，方便网关侧 TLS 策略 |
| `artifacts/oem-profile.yaml` | 已知族的审核草稿，不是生产 Adapter |
| `artifacts/notes.md` | 未知族备注（若有） |

## 动手前先裁定

### 核对真实族再动手（必做）

zip 名和 `manifest.family.primary` 只是采集器对三套已知指纹的打分，**不是**网关 Adapter 主键。HTTP / WebSocket 才是事实。

1. 对照 `http/requests.jsonl` 与 `ws/sockets.json`：登录 URL、Cookie 名、KVM WS 路径和子协议，是否与某一已知族同构。
2. **同构**：才可复用现网 `ami-megarac` / `openbmc-h5` / `huawei-ibmc`，差异放 Profile 或该 Adapter 内的小分支。
3. **不同构，或工具标 `unknown-h5` / `not-h5`**：默认新建 Adapter + 新的 registry 名。不要先改现网那三个，也不要把采集桶写进网关配置。
4. 新族名用市面 BMC 产品（kebab-case），例如 `dell-idrac-h5`、`hpe-ilo-h5`、`lenovo-xcc-h5`。不要用服务器铭牌当族名。

### 本包已经能回答

- 工具判定的族是 ami-megarac，离场结论是 PARTIAL。
- 登录相关 HTTP 在 `http/requests.jsonl`（tags 含 login / kvm-token / kvm-entry）。
- KVM 画面通道看 `ws/sockets.json` 与 `ws/frames.jsonl`。URL：wss://10.0.0.10/kvm。
- 有没有 viewer 截图：没有。
- 还缺什么：阻断 （无）；警告 KVM 画面截图。

### 必须问人或看网关仓库（本包没有）

- 要适配进哪套网关代码？接口、目录、已有 Adapter 长什么样？
- 流量是否与现网某一族同构？同构才改 Profile / 小分支；否则新建 Adapter，不要先改现网三个。
- 成功标准是什么：能反代登录即可，还是必须打通 WS / 画面 / WebCrypto？
- 若结论不是 YES：先写草稿，还是等现场补采后再写？

答不出上面四项时，先问人，不要假设一套网关 API 然后生成代码。

## 不要做

- 不要把本包当成可上线 Adapter，也不要补造 BMC 未出现的接口。
- 不要把铭牌厂商/型号当成采集桶或网关主键。
- 不要把 `unknown-h5` / `not-h5` 写进网关 registry；也不要因为 zip 写成某一已知族就去改现网对应 Adapter。
- 包内没有明文密码、Cookie 值、storage 值、完整 KVM 视频；不要向现场人员索要这些往包里填。
- 结论为 NO 时不要硬写网关。
