# KVM-Recon 后续开发计划

## 1. 目标

开发一个可在机房离线运行的 macOS / Windows 桌面客户端，采集 BMC HTML5 KVM 适配所需资料，导出脱敏 Capture Pack，并通过离场验收清单判断资料是否足够支撑离开机房后的 KVM 网关适配。

## 2. 全局约束

- 不依赖公网。
- 不在现场调用外部分析服务。
- 不保存明文密码。
- 不保存完整 KVM 视频码流。
- 不实现生产 KVM 网关。
- 不实现浏览器插件逻辑。
- `kvmFamily` 是协议主键，厂商和型号只作为 profile/证据字段。
- 未知族只导出资料包，不自动生成 Adapter。

## 3. 当前状态（2026-08-24）

阶段 0–8 的 **MVP 核心代码与单测已闭环**（含 popup 窗口采集、截图角色、`not-h5`、导出确认和安全日志）。

阶段 9 补的是 **MVP 产品化缺口**（采集生命周期、进度轮询收点击、WebSocket `closedAt`），不扩大成自动登录 / MITM / 在线分析。

仍未做、且本轮继续延后：

- 真实 BMC 验收（第 13 节闸门）。
- 本机 Windows 安装包。
- macOS 代码签名。

**真机闸门仍然必要，但不阻塞阶段 9 与后续版本规划。** 第 14 节非目标仍禁止混入当前开发。MVP 之外的能力见第 17 节，先规划后按版本做。

状态标记：

- `代码完成`：实现与单测已落地。
- `部分完成`：主路径有了，规范或架构仍有缺口。
- `待真机`：代码有了，必须用真实 BMC 或安装包证明。
- `未开始`：下一阶段或更后。
- `规划中`：已写入后续版本，本轮不实现。

## 4. 阶段 0：项目初始化

状态：`代码完成` / `待真机`

目标：形成可启动的桌面客户端骨架。

任务：

- 初始化 Electron + TypeScript 项目。`代码完成`
- 增加 renderer 页面：新建采集、采集中、导出结果。`代码完成`（同一页用阶段标签，不是三套独立路由）
- 增加 main process 作业生命周期管理。`代码完成`（开始 / 关闭窗口 / 导出后关窗；暂停与多作业并行见第 17 节 V1.1）
- 增加本地数据目录与临时作业目录。`代码完成`（截图目录）
- 增加基础日志，但默认不记录敏感值。`代码完成`（`createCaptureLogger`）

验收：

- macOS 本地可启动应用。`待真机`
- Windows 可构建安装包或便携包。`代码完成`（`package:win` 已配置）/ `待真机`（本机未生成 `.exe`，本轮不打 Windows 包）
- 能新建一次空采集作业并导出空 Capture Pack。`代码完成`

## 5. 阶段 1：Capture Pack Schema 与脱敏器

状态：`代码完成`（TypeScript 契约）/ 独立 JSON Schema 文件 `未开始`

目标：先固定导出契约，避免后续采集逻辑散乱。

任务：

- 定义 `manifest.json`、`http/requests.jsonl`、`ws/frames.jsonl`、`page/timeline.jsonl`、`tls/certificate.json`、`checklist.json` schema。`代码完成`（`src/core/capture-pack/types.ts` 等）
- 实现字段级脱敏器。`代码完成`
- 实现 URL、Header、Cookie、JSON body、storage 的敏感字段识别。`代码完成`（storage 目前只导出 key 列表）
- 实现导出前脱敏检查。`代码完成`（失败则不弹保存框、不写 zip）

验收：

- 给定模拟 HTTP/WS/storage 数据，导出包不包含明文密码、Token、Cookie、CSRF。`代码完成`
- 脱敏检查失败时阻止默认导出。`代码完成`

## 6. 阶段 2：BMC 基础 Probe

状态：`代码完成`（模拟 HTTP）/ `待真机`

目标：在不登录的情况下采集基础指纹。

任务：

- 实现 TLS 证书和协议探测。`代码完成`
- 实现 `/redfish/v1` 基础探测，并导出 `probe/redfish.json`。`代码完成`
- 实现 AMI MegaRAC 路径指纹：`/api/randomtag`、`/api/session`、`/api/kvm/token`。`代码完成`
- 实现 OpenBMC H5 路径指纹：`/randomtag`、`/kvm/video`、`/redfish/v1/SessionService`。`代码完成`
- 实现华为 iBMC 路径指纹：`KvmService`、`SetKvmKey` 可达性。`代码完成`
- 输出 `family-signatures.json` 与 `path-evidence.json`。`代码完成`

验收：

- 对已知 AMI/华为/OpenBMC 样本能输出候选 `kvmFamily` 和证据。`代码完成`（模拟）/ `待真机`
- 对未知 BMC 输出 `unknown-h5` 或 `not-h5`，不默认误判为某个已知族。`代码完成`（模拟）/ `待真机`

## 7. 阶段 3：内嵌浏览器采集

状态：`代码完成` / `待真机`

目标：支持现场人员手工登录，并采集页面事实。

任务：

- 创建隔离 Chromium session。`代码完成`
- 支持受控忽略 BMC 自签证书。`代码完成`（仅目标主机）
- 打开 BMC 首页。`代码完成`
- 捕获导航、hash 变化、popup/new window。`代码完成`（popup 挂 CDP，截图/storage 取前台窗口）
- 捕获 localStorage/sessionStorage 变化。`代码完成`（补采时 key 快照与增减，不导出明文）
- 支持关键截图。`代码完成`（手动「采集当前页面」+ 角色标记；导出时再拍 viewer）
- 记录 DOM 选择器候选。`代码完成`（登录按钮、KVM 入口、viewer 容器）

验收：

- 现场人员可在采集窗口登录 BMC。`待真机`
- popup/new window 不丢失，仍归属当前采集作业。`代码完成`（模拟）/ `待真机`
- Capture Pack 包含登录页、登录后页面、KVM 入口或 viewer 截图。`代码完成`（有 PNG 与角色；真机画面 `待真机`）

## 8. 阶段 4：HTTP 与 WebSocket 记录

状态：`代码完成`（主窗口 CDP）/ `待真机`

目标：采集适配 KVM 网关所需的 HTTP/WS 事实。

任务：

- 通过 CDP 记录 HTTP 请求、响应、Header、状态码和 body 摘要。`代码完成`
- 生成 HAR 或结构化请求列表。`代码完成`
- 标记疑似登录、疑似 token、疑似 KVM 入口 API。`代码完成`
- 捕获 WebSocket 创建、URL、子协议、Header。`代码完成`
- 捕获 WebSocket 关闭时间 `closedAt`。`代码完成`（`Network.webSocketClosed`）
- 捕获 WebSocket frame 元数据、方向、时间戳、长度、前 N 字节 hex、是否二进制。`代码完成`
- 对持续视频帧做采样和计数，不保存完整流。`代码完成`

验收：

- AMI 场景能看到 `/api/kvm/token` 和 `/kvm` WS 元数据。`代码完成`（模拟）/ `待真机`
- 华为场景能看到 `KvmService`、`SetKvmKey`、`/websocket` 元数据。`代码完成`（模拟）/ `待真机`
- OpenBMC 场景能看到 Redfish Session 和 `/kvm/video` 元数据。`代码完成`（模拟）/ `待真机`

popup 窗口与首个窗口共用同一作业的 CDP 与网络记录器。若现场过早关掉 viewer 窗口，清单仍可能因缺少 WS 给出 `NO`。

## 9. 阶段 5：离场验收清单

状态：`代码完成` / `待真机`

目标：导出前告诉现场人员资料是否足够。

任务：

- 实现基础连接、BMC 指纹、登录链路、KVM 入口、HTTP 关键 API、WebSocket、页面截图、脱敏检查等检查项。`代码完成`
- 每项输出 `pass/fail/unknown/missing/not_applicable/needs_user_action`。`代码完成`
- 每项输出 `blocking/warning/info` 影响级别。`代码完成`
- 生成 `checklist.json`、`report.md`、`report.html`。`代码完成`
- 导出前给出 `YES/PARTIAL/NO` 离场结论。`代码完成`
- 采集中实时进度（不含脱敏项）。`代码完成`

验收：

- 未捕获 KVM WebSocket 时给出 `NO` 或 blocking 提示。`代码完成`（单测）
- 缺截图但 HTTP/WS 完整时给出 `PARTIAL`。`代码完成`（单测）
- 关键资料完整且脱敏通过时给出 `YES`。`代码完成`（单测）

## 10. 阶段 6：已知族 Profile 草稿

状态：`代码完成` / `待真机`

目标：对已知协议族生成可人工审核的适配草稿。

任务：

- AMI：提取 Cookie 名、CSRF 名、token API、WS 路径、子协议、权限字段、登录能力指纹。`代码完成`（有数据才有字段）
- 华为：提取 Redfish 登录、KvmService、SetKvmKey、KVM 端口、加密开关、WS 魔数。`代码完成`（魔数依赖帧 headHex，启发式）
- OpenBMC：提取 SessionService、UNIQUEID、X-Auth-Token、`/kvm/video`、WS 子协议。`代码完成`
- 输出 `artifacts/oem-profile.yaml`。`代码完成`
- 对未知族不输出 profile，只输出分析备注。`代码完成`

验收：

- 已知族 profile 草稿字段能映射到下游 KVM 网关 Adapter/Profile 开发所需事实。`待真机`
- 未知族不会生成空壳 Adapter。`代码完成`

## 11. 阶段 7：打包与现场交付

状态：`部分完成` / `待真机`

目标：让非开发人员可安装、采集、导出。

任务：

- macOS 打包。`代码完成`（`package:mac` / `package:dir`）/ `待真机`（未签名）
- Windows 打包。`代码完成`（脚本与 nsis/zip 配置）/ `待真机`
- 增加离线使用说明。`代码完成`（`docs/offline-field-guide.md`）
- 增加导出包命名规则。`代码完成`
- 增加采集失败时的可读错误提示。`代码完成`
- 增加样例 Capture Pack。`代码完成`（`examples/sample-capture-pack/`）

验收：

- 无公网环境中可安装和启动。`待真机`
- 没有管理员权限时能给出明确限制提示。`代码完成`（导出写失败映射为「当前权限不足」）
- 采集完成后能导出 zip，并可在另一台电脑离线打开报告。`代码完成`（组包）/ `待真机`

## 12. 阶段 8：MVP 补齐

状态：`代码完成` / 真机见第 13 节

目标：补齐规范/架构已要求、真机前会踩到的缺口。不扩展为自动登录、MITM、在线分析或自动写 Adapter。

### 8.1 popup / 新窗口完整纳入当前作业

状态：`代码完成`

- popup / new window 与首个采集窗口共用同一 `jobId`、时间线和网络记录器。
- 为 popup 挂 CDP，记录其 HTTP/WebSocket。
- 「采集当前页面」可针对当前前台窗口（含 popup）截图、storage、选择器。
- 采集进度能反映 popup 内已建立的 KVM WebSocket。

验收：

- 模拟 popup 打开 viewer 时，`ws/sockets.json` 与 `ws/frames.jsonl` 含该窗口连接。
- 时间线有 popup 事件，且不含本机绝对路径。
- 首个窗口关闭或失去焦点后，作业仍能导出 popup 已采集的网络事实。

### 8.2 截图角色与页面时间线

状态：`代码完成`

- 支持为截图标记角色：登录页、登录后首页、KVM 入口、viewer、异常画面。
- 时间线记录点击摘要（选择器或文案摘要，不含敏感值）。
- storage 记录写入前后 key 变化（仍不导出明文敏感值）。

验收：

- Capture Pack 的 `page/screenshots/` 与 `page/screenshots.json` 能区分至少登录与 viewer。
- `page/timeline.jsonl` 含 click 或等价用户操作摘要。

### 8.3 签名与 TLS 补齐

状态：`代码完成`

- 无 HTML5 KVM 迹象时输出 `not-h5`，与 `unknown-h5` 区分。
- `tls/certificate.json` 分记 Node probe 与 Chromium 可达性。
- WebSocket 帧在可识别时填写 `magic`（如 AMI 文本握手），仍不保存完整流。

验收：

- 纯静态或非 H5 探测样本主族为 `not-h5`，不误判为 `ami-megarac` / `openbmc-h5` / `huawei-ibmc`。
- 未知但确有 H5 迹象的仍为 `unknown-h5`。

### 8.4 导出确认与现场可观测性

状态：`代码完成`

- 导出前展示 checklist 摘要和脱敏结果摘要，用户确认后再选路径。
- 增加默认不记录敏感值的基础日志。
- 选择器补充登录按钮与 viewer 容器候选。

验收：

- 脱敏失败仍先于保存框拦截。
- 日志抽检不含密码、Cookie、Token 原文。

### 8.5 契约文件

状态：`代码完成`（以 TypeScript 类型为权威，规范目录已对齐）

任务：

- 将 Capture Pack 主要文件补为独立 JSON Schema，或在规范中明确「以 TypeScript 类型为权威」。

验收：

- `docs/capture-pack-spec.md` 与导出目录一致，含 `probe/path-evidence.json`、`page/screenshots.json`。

## 13. 真机验收闸门

状态：`未开始`

本闸门不是功能开发。阶段 8/9 代码完成后，用真实 BMC 证明 popup KVM 与三族资料可采集。当前按产品安排 **延后**，不阻塞阶段 9 与后续版本规划。

最低证据：

1. 一台 AMI MegaRAC：登录 → HTML5 KVM（含若弹出新窗口）→ 导出包可见 token API 与 KVM WS；清单不为因漏 popup 导致的误 `NO`。
2. 一台华为 iBMC：可见 `KvmService` / `SetKvmKey` / WS 元数据。
3. 一台 OpenBMC H5：可见 Session 与 `/kvm/video` 或等价 WS。
4. 一台未知或非 H5 设备：`unknown-h5` 或 `not-h5`，不生成空壳 Adapter。
5. 导出 zip 可在另一台离线电脑打开 `report.html`。
6. Windows 安装包或便携 zip 至少构建一次并记录产物路径。

## 14. 第一版 MVP 范围与非目标

第一版只做以下闭环：

- Electron 桌面客户端。
- 手工登录采集。
- 基础 probe。
- HTTP/WS 元数据记录（含 popup 窗口，阶段 8.1）。
- 截图和 storage。
- 脱敏导出。
- 离场验收报告。

暂不做（后续版本，禁止混入阶段 8/9）：

- 自动登录脚本生成。
- 完整 MITM。
- 在线分析服务。
- 自动写下游网关 Adapter。
- 完整视频解码。
- 登录后自动带着 Cookie/Token 复验 probe。
- 签名库从成功适配回写（见第 15 节，属离场后流程）。

## 15. 与下游适配开发的交接

离场后，工程师或离线分析流程读取 Capture Pack，并结合目标网关代码完成：

- 判断 `kvmFamily`。
- 判断是 OEM Profile 还是新 Adapter。
- 补充或修正网关注册、OEM Profile、OpenBMC/Huawei Adapter。
- 根据 `checklist.json` 判断是否需要二次进场补采。
- 将成功适配经验回写到 KVM-Recon 签名库和 checklist 规则。

## 16. 阶段 9：MVP 产品化补齐（不依赖真机）

状态：`代码完成` / 真机仍见第 13 节（延后）

目标：把 MVP 核心收成可现场使用的采集作业，而不是继续堆自动登录或 MITM。本阶段不打 Windows 包、不做真机验收。

### 9.1 采集生命周期

状态：`代码完成`

- 导出成功后关闭采集窗口（含 popup）。
- 「关闭采集窗口」与导出拆开：关窗后作业数据保留，仍可导出。
- 新建作业前关掉上一作业窗口，避免窗口残留。
- 采集窗口被关掉后，「采集当前页面」不可用，导出不因补采截图失败而整包失败。

### 9.2 进度轮询收点击

状态：`代码完成`

- `getCaptureSnapshot` 每 2 秒 drain 点击摘要写入时间线，不再只在「采集当前页面」时出现 click。
- 不在轮询中自动截图，避免刷屏和误采。

### 9.3 WebSocket `closedAt`

状态：`代码完成`

- CDP `Network.webSocketClosed` 写入 `ws/sockets.json` 的 `closedAt`。
- 关闭后仍保留帧计数与首包特征。

验收（模拟）：

- 关窗后仍能导出已采集的 HTTP/WS。
- 时间线在未点「采集当前页面」时也能出现 click。
- `ws/sockets.json` 在 socket 关闭后含 `closedAt`。

## 17. MVP 之外的后续版本

以下不是当前缺口补丁，而是 MVP 核心之外的产品能力。本轮只入档，不实现大功能。

### V1.1 现场体验

状态：`规划中`

- 暂停 / 继续采集（不停掉 CDP 会话）。
- 多作业并行或作业列表（当前同一时刻只保留一份可导出作业）。
- 导出包二次导出（同一作业再存一份）。
- 采集窗口被用户手动关掉时的更明确主界面提示。
- macOS 代码签名；Windows 安装包在联网构建机打出（仍不在本轮执行）。

### V2 离场分析增强

状态：`规划中`

- 登录后带着 Cookie/Token 复验 probe（已知族路径）。
- 签名库从成功适配回写（见第 15 节）。
- 独立 JSON Schema 文件（当前以 TypeScript 类型为权威）。
- Capture Pack 对比工具（两次进场资料 diff）。

### V3 超出采集工具边界

状态：`规划中`（禁止提前混入）

- 自动登录脚本生成。
- 完整 MITM / 中间人解密。
- 在线分析服务。
- 自动写下游网关 Adapter。
- 完整 KVM 视频解码。

