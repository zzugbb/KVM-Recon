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
- WebSocket frame 方向、时间戳、长度、前 N 字节 hex、是否二进制。
- 页面截图、导航时间线、popup URL、选择器候选。

注意：WebSocket 只记录元数据和首包特征，不保存完整视频流。点击摘要在采集进度轮询中写入时间线。不采集 Cookie 的写入调用来源；导出包只保留脱敏后的 cookie **名**。

### 3.4 Probe Engine

Node.js 本地探测引擎。开始采集时先做未登录探测；登录后可用浏览器会话复验需鉴权的路径。Cookie 值只在内存中使用，不写入 Capture Pack。出机房后的写 Adapter 仍不在本工具内。

探测项：

- TLS 证书、协议版本、cipher、自签信息。
- `/redfish/v1` 基础信息。
- AMI MegaRAC 指纹：`/api/randomtag`、`/api/session`、`/api/kvm/token`。
- OpenBMC H5 指纹：`/randomtag`、`/kvm/video`、`/redfish/v1/SessionService`。
- 华为 iBMC 指纹：Redfish Session、`KvmService`、`SetKvmKey`。

路径命中：HTML 不算（含 UTF-8 BOM）；2xx 需为 JSON 或短非 HTML 文本（如 randomtag）；401/403/405 仍算接口存在。`/kvm/video` 是 WebSocket 升级口，匿名 GET 的 401 不算路径命中。登录后复验为 false 的路径覆盖匿名结果，不用 OR 合并。

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

无 HTML5 KVM 路径迹象时为 `not-h5`；有 H5 迹象但未命中已知族时为 `unknown-h5`。

打分不只看匿名路径是否探通：证书组织名（如 `O=OpenBMC`）、已采集 HTTP/WS URL、WebSocket 帧头（如 `/xyz/openbmc_project`）一并加权。现场清单、作业列表和导出包走同一套重判。页面 document 导航不计入 AMI HTTP 证据。AMI 只靠路径存在不再给 0.9；不再因 AMI `/api` 路径否决 OpenBMC。

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

KVM-Recon 导出的资料最终服务于下游 KVM 网关或兼容层开发：

- `kvmFamily` 对齐网关侧的 canonical family。
- AMI 差异进入 OEM Profile，而不是新建品牌 Adapter。
- 华为差异用于修正 `huawei-ibmc` 反代、KvmService、SetKvmKey、WebCrypto 垫片。
- OpenBMC 差异用于完善 `openbmc-h5` 登录、WS 子协议和 viewer 参数。
- 未知族只输出 Capture Pack，由出机房后的工程师或 AI 判断是新 Profile 还是新 Adapter。本工具不写 Adapter。

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
