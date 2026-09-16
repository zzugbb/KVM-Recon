# KVM-Recon 技术架构

## 1. 背景

不同厂商和固件版本的 BMC HTML5 KVM 在登录方式、Cookie/Token、KVM 入口、WebSocket 子协议和加密细节上差异很大。KVM-Recon 的目标不是复刻生产网关，而是在机房现场离线采集新增 BMC/KVM 适配所需的事实资料，导出后供离场分析和网关兼容开发使用。

## 2. 客户端形态

实现为 macOS / Windows 桌面客户端：

- 桌面壳：Electron。
- 采集窗口：Electron 内嵌 Chromium。
- 网络记录：Chromium DevTools Protocol（CDP）为主。
- 本地探测：Node.js 进程访问 BMC，采集 TLS、Redfish、路径指纹和已知族探测结果。
- 导出格式：脱敏 Capture Pack zip。

Electron 优先级高于 Tauri 的原因是：Electron 自带 Chromium 和 CDP，能稳定记录 HTTP、WebSocket、popup、storage、截图和页面事件；Tauri 依赖系统 WebView，跨平台网络采集能力不一致。

## 3. 运行时模块

### 3.1 Desktop Shell

负责应用窗口、菜单、作业生命周期、导入导出、离线配置和本地文件访问。

关键职责：

- 创建隔离浏览器 profile。
- 为采集窗口设置受控证书策略。
- 管理采集作业开始、暂停/继续、关闭窗口、导出和作业列表。最多同时保留 8 份作业。
- 不在本地持久化明文密码。

### 3.2 Capture Browser

用于访问目标 BMC。现场人员可以在此窗口手工登录并打开 HTML5 KVM。

关键职责：

- 打开 BMC 首页。
- 捕获 popup / new window，并记录 URL 与打开时机。
- 记录页面导航、storage key、截图、选择器候选。
- 保留用户真实操作路径，避免工具自动操作破坏 BMC 会话状态。

当前能力：popup 与首个窗口共用同一作业的时间线、网络记录器和前台截图/storage。新窗口会挂 CDP。可暂停记录且不关窗。导出成功或现场选择「关闭采集窗口」后关闭全部采集窗口，作业数据仍可导出。最多同时保留 8 份作业。

### 3.3 CDP Recorder

通过 CDP 记录浏览器侧事实。

采集范围：

- HTTP 请求和响应摘要（含来自首窗口或 popup）。
- HAR 或结构化请求列表。
- Cookie、CSRF、Token 等敏感字段脱敏后的 Header/摘要。
- WebSocket 创建事件、URL、子协议、关闭时间 `closedAt`。
- WebSocket 握手响应状态、响应头和服务端最终选择的子协议。
- WebSocket frame 方向、时间戳、长度、前 N 字节 hex、是否二进制。
- 页面截图、导航时间线、popup URL、选择器候选。

注意：WebSocket 只记录元数据和有界帧样本，不保存完整视频流；每条连接持续累计帧总数、采样数和丢弃数。HTTP JSON 与 URL-encoded 表单请求/响应会保留字段级脱敏后的结构化样本，短文本响应保留有限长度样本，便于离场后复原嵌套字段、表单参数和非敏感参数关系。图片、字体、媒体、样式、流式响应、二进制 MIME、`data:` / `blob:` 和超限正文不会读取。点击摘要在采集进度轮询中写入时间线。不采集 Cookie 的写入调用来源；导出包只保留脱敏后的 cookie **名**。

HTTP 重定向按 hop 保存，避免 Chromium 复用 `requestId` 时覆盖登录跳转或 Viewer 跳转。CDP 请求和响应 ExtraInfo 中的 Cookie / Set-Cookie 等头会结合 `redirectHasExtraInfo` / `hasExtraInfo` 合并到对应 hop，不会因某一跳缺少 ExtraInfo 而错位；响应 ExtraInfo 的真实状态码和原始头始终优先于普通响应，头名按大小写不敏感方式合并。请求 ExtraInfo 合并后会重新计算链路标签。EventSource、SSE 和可识别的长轮询不参与普通 HTTP 空闲等待。Dedicated Worker / shared worker 入口脚本常在父会话发出 `requestWillBeSent`，在 Worker 子会话收到响应与 `loadingFinished`；采集器会把同一 `requestId` 关联回父记录，并在子会话 `Network.enable` 后补读 JS 正文。Worker 源码采到后该请求离开 in-flight；加载失败或 target detach 仍无正文时保留 `loading-failed`，清单为 PARTIAL。

### 3.4 Probe Engine

Node.js 本地探测引擎。开始采集时先做未登录探测；登录后可用浏览器会话复验需鉴权的路径。Cookie 值只在内存中使用，不写入 Capture Pack。出机房后的写 Adapter 仍不在本工具内。

无副作用探测项：

- TLS 证书、协议版本、cipher、自签信息。
- TLS、`/redfish/v1/`、`/api/randomtag` 和 `/randomtag` 四路同时开始；仅在带斜杠的 Redfish 根不可用时兼容回退 `/redfish/v1`。
- AMI MegaRAC 指纹：正文验证后的 `/api/randomtag`，以及证书 `O=American Megatrends` / `CN=AMI`。
- OpenBMC H5 指纹：正文验证后的 `/randomtag`，以及 OpenBMC 证书信息。
- 华为 iBMC 指纹：Redfish `Vendor`、`Oem.Huawei`、`SoftwareName=iBMC` / `SmsName=iBMC` 与证书身份。

Recon 不主动请求 `/api/session`、`/api/kvm/token`、`/api/settings/media/h5viewercfg`、`KvmService`、`SetKvmKey` 等会话、一次性 Token 或操作接口。这些链路仅从现场人员在浏览器中的真实操作流量记录，避免预取 Token、占用会话槽或改变 BMC 状态。

路径命中：HTML 不算（含 UTF-8 BOM）；2xx 需为结构化 JSON 或明确的短非 HTML 指纹文本；`text/plain` 但正文为 JSON 的响应按 JSON 解析；Redfish 根同时兼容 `/redfish/v1` 与 `/redfish/v1/`。401/403/405 只记录为路径事实，不再直接算接口命中。`/kvm/video` 是 WebSocket 升级口，匿名 GET 的 401 不算路径命中。登录后复验为 false 的路径覆盖匿名结果，不用 OR 合并。探测结果同时导出 `probe/path-details.json`，保留每个路径的状态码、内容类型、重定向和响应结构特征。

已知族判定与 InManage NodeServer 的 adapter-registry 语义对齐：优先级为 AMI、OpenBMC、Huawei；TLS 身份只读取证书 subject，其中 AMI 使用 subject O/CN、OpenBMC 使用 subject O、Huawei 使用 subject CN，不以 issuer 或 Huawei subject O 判定；AMI/OpenBMC 的 randomtag 需要看到对应 JSON 字段，单独命中已验证 `/randomtag` 即是 OpenBMC 强指纹，通用鉴权墙不算；Huawei 需要 Redfish/OEM/TLS/legacy UI/WS/帧头等强身份信号，不能只因通用 `KvmService` 字段命中就归入华为。H3C HDM2、Dell iDRAC、HPE iLO、Huawei legacy 会作为产品迹象写入 `probe/product-hints.json` 和 manifest；`unknown-h5` 只是采集桶，不是产品提示。H3C/Huawei 品牌仅作辅助，HDM2/legacy 提示必须有对应协议路径、资源或帧证据。

探测实现以当前仓库的 Node probe 与登录后会话复验为准。不要把一次性手工调试脚本直接做进产品主流程。无头批量复验、从调试脚本抽公共库，都不是本项目目标。

### 3.5 Signature Engine

本地签名库，不依赖公网或外部分析服务。

输出：

- `kvmFamily` 候选。
- 命中证据。
- 置信度。
- 是否已知族。
- 是否允许生成 OEM Profile 草稿。

当前覆盖：

- `ami-megarac`
- `openbmc-h5`
- `huawei-ibmc`
- `unknown-h5`
- `not-h5`

无 HTML5 KVM 路径迹象时为 `not-h5`；有 H5 迹象但未命中已知族时为 `unknown-h5`。后两个是未识别采集桶，不是网关 Adapter 名；已知三族也须用流量核对是否同构。下游起名见 `docs/kvm-family.md`。

打分不只看匿名路径是否探通：证书组织名（如 `O=OpenBMC`）、TLS CN、已采集 HTTP/WS URL、WebSocket 子协议与帧头（如 RFB、APCP、FEF6、IVTP）一并加权。现场清单、作业列表和导出包走同一套重判。页面 document 导航不计入 AMI HTTP 证据。AMI 只靠路径存在不再给 0.9；AMI 明确启动接口同时包括 `/api/kvm/token` 与 `/api/settings/media/h5viewercfg`，`/api/session` 加上其中任一即可作为强流量证据。不再因 AMI `/api` 路径否决 OpenBMC；通用 `KvmService` 不再造成 H3C G6 等 HTML5 KVM 误判为 Huawei。

### 3.6 Redactor

统一脱敏器，导出前强制执行。

脱敏对象：

- 密码字段。
- Token / CSRF / Cookie / SessionId。
- `authParam`、`X-Auth-Token`、`QSESSIONID`、`UNIQUEID`、`garc`。
- URL query、请求体、响应体、storage 中的敏感字段。

导出包只保留必要的长度、hash、掩码片段和来源路径。

### 3.7 Checklist Engine

生成离场验收结论。

核心问题：

- 采集到了哪些资料？
- 是否足够离开机房后做 KVM 适配？
- 缺了哪些资料？
- 现场人员还需要做什么？

输出 `YES`、`PARTIAL`、`NO` 三类离场结论。

Readiness 综合登录链路、KVM 启动链路、WebSocket 升级、子协议和真实帧证据判断，不依赖单一 `kvm-video` 标签。登录链路必须是成功的 POST，并有 Session Cookie、Token 或成功响应结构；GET 登录页、DELETE、失败状态、未完成请求和 `/bmc/php/gettoken.php` 均不能充当登录成功。Huawei legacy 的 `/bmc/php/gettoken.php` 等 PHP 表单接口只纳入 KVM 启动链。AMI 启动链接受 `/api/kvm/token` 或 `/api/settings/media/h5viewercfg`。通用 `/websocket` 文本心跳不触发 viewer 截图；viewer 截图只有在正确窗口或子 target 收到可靠 KVM 证据后才自动生成。导出前会等待普通在途 HTTP 请求、响应体读取任务和短静默窗口；`http/capture-status.json` 保留全部 in-flight ID 与 CDP pending 任务。`network.capture.complete` 只对登录、一次性 KVM Token/启动接口、Viewer/Worker 源码和 Worker/OOPIF attach 降级。同窗口内已成功采过的 GET KvmService 资源查询（XHR/Fetch），导出瞬间仍在途时不单独把整包打成 `PARTIAL`；POST 等写操作、重复登录、重复 token/`h5viewercfg`、不同窗口的 Worker 仍为 `PARTIAL`。流式请求不阻塞空闲等待。

Dell iDRAC 的 `/sysmgmt/2015/bmc/session` 允许在脱敏后仍同时存在 `user` / `password` 头时使用空 POST body；缺任一头仍判正文缺失。HPE iLO5 的 `/redfish/v1/Sessions/` 是登录接口，iLO `/wss/ircport` 是直接 KVM 通道，因此不要求额外 Token HTTP API。产品提示不改变五个采集桶。AMI IVTP 弱二进制魔数只在 `/kvm` 且声明 `binary` / `base64` 子协议时标记。

### 3.8 Exporter

将采集结果打包为 Capture Pack。

导出前置条件：

- 脱敏检查通过。
- checklist 已生成。

导出路径由用户在确认离场结论和脱敏摘要后，再通过保存框选择。

现场铭牌（厂商/型号/固件/位置）写入 `manifest.job.observed` 与 `probe/operator-observed.json`，只作证据，不覆盖 `kvmFamily`。

### 3.9 Local Pack Review

主窗口可在本机打开或对比 Capture Pack zip：读取 `manifest.json`、清单和 HTTP/WS 摘要，不调用公网，不写 Adapter。

## 4. 与下游网关适配的衔接

KVM-Recon 导出的资料最终服务于下游 KVM 网关或兼容层开发。完整裁定见 `docs/kvm-family.md`。

- zip 名 / `manifest.family.primary` 是**采集桶**。流量与现网族同构时沿用该名；否则按市面 BMC 产品另起网关主键。
- 先核对包内 HTTP/WS 是否与现网族**同构**；同构才改 Profile 或该 Adapter 的小分支。
- AMI 差异进入 OEM Profile，而不是按服务器品牌新建 Adapter。
- 华为差异用于修正 `huawei-ibmc` 反代、KvmService、SetKvmKey、WebCrypto 垫片。
- OpenBMC 差异用于完善 `openbmc-h5` 登录、WS 子协议和 viewer 参数。
- `unknown-h5` / `not-h5`（以及 zip 写成已知族但流量对不上）默认**新建 Adapter**，起名如 `dell-idrac-h5` / `hpe-ilo-h5`。不要先改现网三个，也不要把采集桶写进 registry。
- 本工具不写 Adapter。

## 5. 项目非目标

- 不做生产远程控制台。
- 不做统一视频解码，不采集完整视频流。
- 不在机房内调用外部分析服务或 AI。
- 不实现浏览器插件逻辑。
- 不根据 Capture Pack 自动编写下游网关 Adapter。写 Adapter 是出机房联网之后的事。

## 6. 关键风险与降级路径

- 老 TLS / 自签证书：Electron 采集窗口受控忽略证书错误；Node probe 记录 TLS 失败原因。
- popup / 新窗口：与首个窗口共用作业，挂 CDP，前台窗口用于截图/storage。
- 登录无法自动化：支持现场人员手工登录，工具只做记录。
- KVM 协议不可解码：只记录 WS 元数据和首包特征，离场后分析。
- 资料不完整：导出前用 checklist 阻断或提示补采。

## 7. 范围

采集侧代码已收口，见 `docs/development-plan.md` 当前状态。架构上不再规划 Adapter 生成器、在线分析或 MITM。真机验收与 Apple/微软付费代码签名按产品安排。安装包由 GitHub Actions 构建：macOS 为 ad-hoc 签名，Windows 无 Authenticode，见 `docs/releasing.md`。
