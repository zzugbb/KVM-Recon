# KVM-Recon 开发计划（采集侧已收口）

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

## 3. 当前状态（2026-08-24）：采集侧代码阶段收口

**结论：机房离线采集闭环的代码与单测已完成，本阶段不再新增采集功能。**

已完成（模拟数据 / 单测）：

- 阶段 0–8：MVP 核心（探测、内嵌浏览器、HTTP/WS、清单、Profile 草稿、导出脱敏、popup、截图角色、`not-h5`）。
- 阶段 9–12：作业生命周期、出机房资料质量、登录后复验、暂停/多作业、独立 JSON Schema、本地打开/对比 Capture Pack。
- 第 21 节：现场厂商/型号/固件/位置铭牌备注（不改写 `kvmFamily`）。

明确延后、不作为本阶段缺口：

- 真实 BMC 验收（第 13 节闸门）。
- 本机实际打 Windows 安装包。
- macOS 代码签名。

**产品边界止于导出脱敏 Capture Pack。** 自动写 Adapter、机房内在线分析、MITM、自动登录、完整视频解码不属于本项目，也不进入下一采集功能迭代。

出机房后的协议分析与写 Adapter，由工程师或 AI 基于 Capture Pack 完成。

状态标记：

- `代码完成`：实现与单测已落地。
- `部分完成`：主路径有了，规范或架构仍有缺口。
- `待真机`：代码有了，必须用真实 BMC 或安装包证明。
- `未开始`：下一阶段或更后。
- `延后`：已确认不做或等产品安排，不阻塞采集侧收口。

## 4. 阶段 0：项目初始化

状态：`代码完成` / `待真机`

目标：形成可启动的桌面客户端骨架。

任务：

- 初始化 Electron + TypeScript 项目。`代码完成`
- 增加 renderer 页面：新建采集、采集中、导出结果。`代码完成`（同一页用阶段标签，不是三套独立路由）
- 增加 main process 作业生命周期管理。`代码完成`（开始 / 关闭窗口 / 导出后关窗；作业列表最多 8 份，可暂停）
- 增加本地数据目录与临时作业目录。`代码完成`（截图目录）
- 增加基础日志，但默认不记录敏感值。`代码完成`（`createCaptureLogger`）

验收：

- macOS 本地可启动应用。`待真机`
- Windows 可构建安装包或便携包。`代码完成`（`package:win` 已配置）/ `待真机`（本机未生成 `.exe`，本轮不打 Windows 包）
- 能新建一次空采集作业并导出空 Capture Pack。`代码完成`

## 5. 阶段 1：Capture Pack Schema 与脱敏器

状态：`代码完成`（TypeScript 契约 + `schema/` JSON Schema）

目标：先固定导出契约，避免后续采集逻辑散乱。

任务：

- 定义 `manifest.json`、`http/requests.jsonl`、`ws/frames.jsonl`、`page/timeline.jsonl`、`tls/certificate.json`、`checklist.json` schema。`代码完成`（`src/core/capture-pack/types.ts` 与 `schema/*.json`）
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

状态：`代码完成`（安装包脚本）/ `待真机`（现场无公网安装与签名）

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

目标：补齐规范/架构已要求、真机前会踩到的缺口。不把本工具做成分析平台或 Adapter 生成器。

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

状态：`代码完成`（TypeScript 类型为权威，`schema/` 已提供独立 JSON Schema）

任务：

- 将 Capture Pack 主要文件补为独立 JSON Schema，或在规范中明确「以 TypeScript 类型为权威」。`代码完成`（`schema/`：manifest、checklist、HTTP 行、WS socket/frame、operator-observed；其余文件以 TypeScript 类型为权威）

验收：

- `docs/capture-pack-spec.md` 与导出目录一致，含 `probe/path-evidence.json`、`page/screenshots.json`。

## 13. 真机验收闸门

状态：`延后` / `未开始`

本闸门不是功能开发。采集侧代码完成后，用真实 BMC 证明 popup KVM 与三族资料可采集。当前按产品安排 **延后**，不阻塞采集侧代码阶段收口。

最低证据：

1. 一台 AMI MegaRAC：登录 → HTML5 KVM（含若弹出新窗口）→ 导出包可见 token API 与 KVM WS；清单不为因漏 popup 导致的误 `NO`。
2. 一台华为 iBMC：可见 `KvmService` / `SetKvmKey` / WS 元数据。
3. 一台 OpenBMC H5：可见 Session 与 `/kvm/video` 或等价 WS。
4. 一台未知或非 H5 设备：`unknown-h5` 或 `not-h5`，不生成空壳 Adapter。
5. 导出 zip 可在另一台离线电脑打开 `report.html`。
6. Windows 安装包或便携 zip 至少构建一次并记录产物路径。

## 14. 第一版范围与项目边界

本项目只做机房离线采集闭环：

- Electron 桌面客户端。
- 手工登录采集。
- 基础 probe。
- HTTP/WS 元数据记录（含 popup 窗口）。
- 截图和 storage。
- 脱敏导出。
- 离场验收报告与交接说明。
- 暂停采集、多作业、本地打开/对比 Capture Pack、现场铭牌备注。

**本项目不做：**

- 自动登录脚本生成。
- 完整 MITM / 中间人解密。
- 在机房内调用外部分析或 AI。
- 根据 Capture Pack 自动编写下游网关 Adapter。
- 完整 KVM 视频解码。

**采集侧功能清单（本阶段已完成，不再作为待开发项）：**

- 登录后带着浏览器会话复验 probe（Cookie 值只在内存中用，不落盘）。
- HTTP/WS 标注来自首窗口还是 popup。
- 未导出作业关闭前提示；同一作业允许再次导出。
- 暂停采集、多作业列表、独立 JSON Schema、本地 Capture Pack 对比查看。
- 结构化填写现场厂商/型号/固件/位置。

机房里通常没有公网。采集到的数据应在 **出机房、联网之后** 交给工程师或 AI 做协议分析和写 Adapter。

## 15. 与下游适配开发的交接

KVM-Recon 交出去的是 Capture Pack，不是 Adapter。

出机房并联网后，工程师或 AI 读取本包完成：

- 判断 `kvmFamily`。
- 判断是 OEM Profile 还是新 Adapter。
- 补充或修正网关注册、OEM Profile、OpenBMC/Huawei Adapter。
- 根据 `checklist.json` 判断是否需要二次进场补采。

上述工作不在本仓库实现。本包内的 `artifacts/handover.md` 和（已知族）`artifacts/oem-profile.yaml` 只是给离场分析用的事实摘要，需要人工/AI 审核，不能当生产 Adapter。

## 16. 阶段 9：采集作业可用性（不依赖真机）

状态：`代码完成` / 真机仍见第 13 节（延后）

目标：把采集作业收成可现场使用的生命周期。本阶段不打 Windows 包、不做真机验收。

### 9.1 采集生命周期

状态：`代码完成`

- 导出成功后关闭采集窗口（含 popup）。
- 「关闭采集窗口」与导出拆开：关窗后作业数据保留，仍可导出。
- 新建作业前关掉上一作业窗口，避免窗口残留。`代码完成`（阶段 12 改为多作业并行，新建不再关闭上一作业）
- 采集窗口被关掉后，「采集当前页面」不可用，导出不因补采截图失败而整包失败。
- 用户手动关掉全部采集窗口时，主界面同步为窗口已关闭。

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

## 17. 阶段 10：出机房资料质量

状态：`代码完成` / 真机仍见第 13 节（延后）

目标：让 Capture Pack 离开机房后足够被工程师或 AI 阅读，而不是在本工具里写 Adapter。

- Cookie / Set-Cookie 保留 cookie **名**，只脱敏值。
- JSON 请求/响应体摘要保留字段名 `jsonKeys`，不保存明文敏感值。
- URL query 中的 token 等参数脱敏，路径保留。
- 每个包写入 `artifacts/handover.md`，说明出机房后如何把包交给工程师/AI。
- `report.html` 增加「离场后怎么用」。

验收（模拟）：

- `set-cookie: QSESSIONID=<redacted:...>` 能抽出 cookie 名 `QSESSIONID`，且不含明文 session。
- 登录 JSON 可见 `UserName` / `Password` 字段名，不见密码原文。
- 导出包含 `artifacts/handover.md`，文案不暗示本工具会写 Adapter。

## 18. 项目边界

**不属于 KVM-Recon：**

- 自动写下游网关 Adapter（出机房后由工程师或 AI 基于 Capture Pack 完成）。
- 在线分析服务 / 机房内调用 AI。
- 完整 MITM。
- 自动登录脚本。
- 完整 KVM 视频解码。

**采集侧功能清单已完成。** 下一事项只剩第 13 节真机验收闸门，以及 Windows 安装包实打 / macOS 签名（均延后）。

结构化填写厂商/型号备注已在第 21 节落地。暂停采集、多作业、独立 JSON Schema、本地 Pack 对比已在阶段 12 落地。真机验收和 Windows 安装包继续延后，见第 13 节。

## 19. 阶段 11：采集完整度（不依赖真机）

状态：`代码完成` / 真机仍延后

- 登录后用浏览器会话 Cookie 复验 probe；导出包只保留 cookie **名** 与路径可达性。
- HTTP / WebSocket 记录 `windowRole`：`main` 或 `popup`。
- 新建作业覆盖未导出资料前确认；导出后允许再次导出。`代码完成`（阶段 12 起改为关闭作业前确认，新建不再覆盖）

验收（模拟）：

- 匿名探测看不到 token 路径、带会话后能看到时，主族可从 `unknown-h5`/`not-h5` 提升为已知族。
- popup 上的 KVM WS 带 `windowRole: "popup"`。
- 复验日志不含 Cookie 值。

## 20. 阶段 12：现场作业与离线复核（不依赖真机）

状态：`代码完成` / 真机仍延后

目标：提升现场采集体验，并让出机房后能在本机打开、对比 Capture Pack。本阶段不写 Adapter、不调用公网。

- 暂停 / 继续采集：采集窗口保持打开，暂停期间不记录新的 HTTP / WebSocket / 点击；进行中的 HTTP 响应和 WebSocket 关闭仍会补全。
- 多作业列表：新建不再关闭或丢弃上一份作业；最多同时保留 8 份；可切换查看、关闭作业（未导出需确认）。
- 独立 JSON Schema：`schema/` 提供 `manifest`、`checklist`、HTTP 行、WS socket/frame 的 JSON Schema；运行时仍用轻量必填字段检查，不引入 ajv。
- 本地打开 / 对比 Capture Pack：选择 zip 后展示族、就绪结论、HTTP/WS 数量和差异表。

验收（模拟）：

- 暂停后新的 HTTP/WS 不进入记录器，继续后恢复记录。
- 同时存在两份作业时，导出其中一份不影响另一份。
- 样例 Capture Pack zip 通过形状检查；对比能标出 `kvmFamily` 差异。

## 21. 现场厂商/型号备注（不依赖真机）

状态：`代码完成` / 真机仍延后

目标：让现场把机箱铭牌写成结构化证据，供出机房后对照，而不是用厂商 Logo 覆盖 `kvmFamily`。

- 界面增加现场厂商、型号、固件、机柜位置；作业备注仍为自由文本。
- 导出写入 `manifest.job.observed` 与 `probe/operator-observed.json`。
- `artifacts/handover.md` 分别列出铭牌字段，并写明不能替代 `kvmFamily`。
- 探测得到的协议族不受铭牌字段影响。

验收（模拟）：

- 铭牌填写华为、probe 判定 `ami-megarac` 时，导出包主族仍为 `ami-megarac`。
- 空铭牌不写入 `manifest.job.observed`；若连备注也没有，则不生成 `probe/operator-observed.json`。

## 22. 本阶段收口

状态：`代码完成`（采集侧）/ 真机与安装包 `延后`

2026-08-24 起，KVM-Recon **采集侧代码阶段结束**。仓库可作为离线采集工具的代码基线：能探测、采集、脱敏导出 Capture Pack，并在本机打开/对比资料包。

本阶段交付物：

- Electron + TypeScript 桌面客户端源码与单测。
- Capture Pack 契约：`docs/capture-pack-spec.md`、`schema/`、`examples/sample-capture-pack/`。
- 现场说明：`docs/offline-field-guide.md`。
- 打包脚本：`package:mac` / `package:win`（本机未实打 Windows 包、未做 macOS 签名）。

本阶段之后默认不再开发新的采集功能。开源仓库治理、CI 与未签名安装包发布见第 24 节，不属于新的采集功能。

若要继续，只应是：

1. 第 13 节真机验收（产品安排后再做）。
2. 用 GitHub Actions `Release`（tag `v*`）或 `Package` 生成 Windows / macOS 安装包；本机交叉打 Windows 包仍非必须。
3. 按发布需要补代码签名与公证（证书放在 GitHub Secrets，不进仓库）。
4. 真机或现场反馈暴露的缺陷修复。

不要把「写 Adapter、机房调 AI、MITM、自动登录、完整视频解码」当作本仓库后续迭代。

## 23. 最终核对（含原 MVP 外清单）

核对日期：2026-08-24。

**采集功能：没有待开发项。** 原「MVP 外、采集工具可做」的项已全部落地；原 V3 路线（自动登录 / MITM / 在线分析 / 写 Adapter）已确认为项目边界外，不是待办。

| 类别 | 项 | 结论 |
| --- | --- | --- |
| 原 V1.1 | 暂停 / 继续采集 | 已做 |
| 原 V1.1 | 多作业列表 | 已做 |
| 原可做 | 独立 JSON Schema | 已做（主要文件；其余以 TS 为权威） |
| 原可做 | 本地打开 / 对比 Capture Pack | 已做 |
| 原可做 | 现场厂商 / 型号 / 固件 / 位置 | 已做 |
| 原 V2 | 登录后 Cookie 复验 probe | 已做（值不落盘） |
| 原可做 | HTTP/WS `windowRole` | 已做 |
| 原可做 | 未导出关闭确认、再次导出 | 已做 |
| 原 V3 | 自动登录、MITM、机房内 AI、自动写 Adapter、完整视频解码 | **永不做** |
| 延后 | 真机验收、本机交叉打 Windows 包、代码签名/公证 | 不是功能缺口；未签名包由 GitHub Actions 构建 |

故意保持的约束（不是未完成优化）：

- storage 只导出 key，不导明文。
- 不采集 Cookie 写入调用来源。
- `page/timeline.jsonl`、`tls/certificate.json` 等不以独立 JSON Schema 全覆盖，以 TypeScript 导出代码为权威。
- 铭牌字段在新建作业时填写，不提供作业中途改铭牌。

本阶段之后默认不新增采集功能。

## 24. GitHub 开源治理与发布（非采集功能）

状态：`代码完成` / 签名与真机 `延后`

目标：仓库按常见 GitHub 开源项目补齐治理文件和自动化，**不改变采集产品边界**。

已落地：

- MIT `LICENSE`，以及 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`、Issue/PR 模板、Dependabot、CODEOWNERS。
- CI：`typecheck`、单测、本地 mock BMC 探测/导出闭环、构建、Electron 主窗口启动烟测。
- `Package` workflow：手动构建未签名 macOS / Windows 产物为 Artifact。
- `Release` workflow：推送 `v*` 标签后发布到 GitHub Releases，并附 `SHA256SUMS.txt`。
- 说明：`docs/releasing.md`；README 增加徽章、下载与安全入口。

不做：

- 用 GitHub 在机房调 AI 或自动写 Adapter。
- 把证书写入仓库。未签名是当前发布方式。
- 对真实 BMC 的在线 e2e（没有公开 BMC，也不做自动登录）。





