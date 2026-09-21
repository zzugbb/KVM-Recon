# Changelog

本文件记录用户可见变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 和 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

- **日常开发**：把尚未随安装包发出的改动写在 `[Unreleased]`。
- **发布新版本**：把 `[Unreleased]` 里的条目移到新版本标题下（如 `[0.1.1] - YYYY-MM-DD`），同步 `package.json` 的 `version`，再打 `v*` 标签。GitHub Release 说明可从该版本章节复制。

## [Unreleased]

- 0.3.0 阶段 0（契约先行）：`src/core/capture-pack-v2/` 三正交状态、11 个 `INCOMPLETE` 稳定原因与十项完整度门禁映射、`derivePackIntegrity`；`schema/2.0/`（30 个 Schema 与类型同步，导出按包内 Schema 副本自校验）；Capture Pack 1.x 导入固定 `LEGACY_UNVERIFIED`。
- 新增随机 URL Mock KVM（对现有厂商签名零命中）：SHA-256 摘要凭据登录链、CSRF 校验的 KVM 启动、严格会话校验；真实浏览器可走通登录 → 控制台 → Viewer → WebSocket 全链（`e2e/mock-kvm-browser-flow.mjs`）。
- 新增完整度失败 Fixture（每个 `INCOMPLETE` 原因一个）、样例包一致性验证器（负向 36 项）与 `examples/capture-pack-v2/` 样例包（完整度从观察事实派生，无编造关系）。
- 0.3.0 阶段 1（磁盘工作区与流式导出）：单作业 `JobWorkspace`（跨进程互斥为 OS 内核独占、磁盘水位 5 GiB 粘性、finalize 不可变、崩溃后可恢复导出）、SHA-256 内容寻址 `BodyStore`、checksums 与流式 ZIP64；新管线无任何大小上限。
- 0.3.0 阶段 2（协议无关采集）：`src/core/collector/` 全量采集——CDP 原始 journal、HTTP 全 hop 正文 + 流式 HAR + `catalog/resources.jsonl`、WebSocket 全部双向帧、WebCrypto 调用、脚本/Worker/WASM 源码、NetLog、截图/DOM 快照/点击表单时间线、IndexedDB/CacheStorage、运行环境、WebRTC/WebTransport/SSE/下载实时通道（观察脚本注入不改页面行为，不可观测通道显式记账）。
- 0.3.0 阶段 2 收口：生产 Controller（每作业独立 partition、自签证书放行、popup 血缘、`about:blank` 预提交）与单作业 Electron 壳（IPC start/status/stop/export/discard、启动崩溃恢复 `recoverCrashedJobExport`、保守证据摘要）替换 0.2.x 链路；删除 0.2.x 运行链路与五项大小上限（1 MiB / 2 MiB / 24 文件 / 8 MiB / 64 帧），导出不脱敏，恒为 `INCOMPLETE + TARGET_OPENED`（workflowStatus 由阶段 3 完整度引擎派生）。
- 修复多根 CDP journal 并发写 seq 乱序（`RAW_JOURNAL_INVALID`）：按 seq 顺序链式追加，新增并发回归测试。
- 新增现场 HAR 回放 E2E（`e2e/field-har-replay.mjs`，`KVM_RECON_FIELD_COLLECTION_2` 指向只读语料目录，缺失跳过）：0.2.x 真实现场 HAR 回放给新链路，断言新包为旧语料超集——全部资源 URL 在包、响应正文逐条目 SHA-256 相等（最大 4.74 MB）、登录 POST 口令逐字节在包。回放按 HAR 原始 Content-Type（含 charset）响应，规避 Chromium 对无 charset CSS 的编码嗅探转码。
- 0.3.0 阶段 2 审核修复：SSE 观察脚本回调不再被吞（onXXX 重赋值防堆叠、addEventListener 透传、构造器 instanceof 保真）；`stop()` 幂等（重入共享同一次收尾）且每步 best-effort——任一步失败记入证据后继续，全挂载失败/HAR 构建失败仍有诚实兜底可导出；attach 失败清理监听；drain/closed 丢弃事件与 SSE 未知 kind 显式记账；WebSocket 目录名碰撞去重；popup 关闭超时强制 destroy；jobId 加随机后缀。
- 0.3.0 阶段 2 第二轮审核修复：SSE 观察脚本监听器身份保真（removeEventListener 按原始 listener 移除包装、onXXX 属性不可枚举、非函数赋值归 null、构造器无 new 抛 TypeError）；快照命令（getCookies / storage 求值 / getFrameTree）全部有界超时，渲染进程挂死不再挂起 `stop()`；WS flush 逐 socket best-effort；新增 Frame Tree 快照（`raw/browser/frame-tree.json`）与 Controller 诊断事实（`raw/controller/diagnostics.jsonl`，含证书错误）随包导出，新增两个 Schema。
- 0.3.0 阶段 2 第三轮审核修复：SSE addEventListener 按 WHATWG（type, callback, capture）去重，同一身份的注册复用同一包装对象（原生按回调身份自行去重，once 已消费 / signal 已中止后重挂天然生效），不再因生成第二个闭包导致页面回调被调用两次；监听器映射改条目列表，同 listener 不同 capture 的注册各自可移除；onXXX 处理器对 capture:true 的移除按 WHATWG no-op。构造器包装的 new.target 子类语义显式记为已知边界。
- 0.3.0 阶段 2 第三轮审核修复（P3-4）：HTTP 事务行 / 资源索引行写入失败持久记入证据摘要新类别 `journalWriteFailures`（此前只有进程内 droppedEvent 计数，包内无缺失作证）；journal 行缺失按规范 §14 映射 `INCOMPLETE_RAW_JOURNAL` 并使 raw-journals-closed 门禁失败。
- 0.3.0 阶段 2 第五轮审核修复（P2-1）：journal 写失败持久记账推广到全部 journal 路径——CDP events/commands（粘性链保留，首行失败与后续跳过行逐条作证）、实时通道 webrtc/webtransport/sse/downloads、runtime crypto、browser console/timeline/actions；任一 journal 行丢失不再派生假 COMPLETE。补充测试：Controller 诊断行写失败 droppedEvent 计账且 stderr 镜像不中断（`controllerDiagnosticRecorder` 抽取为独立模块）；P3-B 子类语义边界用测试钉住。
- 0.3.0 阶段 2 第六轮审核修复（P2-1 + P3 顺手项）：观察脚本钩子安装失败不再静默——crypto/action/webrtc/webtransport/sse 各安装 catch 经 binding 上报 `observer-hook-failed`，收集端落 `droppedEvent` 记账（report 通道自身失败仍为文档化不可上报边界）；elementSummary 取消 200 字符截断；删除 WebTransport `patchReady` 死代码；SSE onXXX 自有访问器改 non-configurable（delete 对齐原生 no-op）；WebRTC/SSE 重复 close 只上报一次；removeEventListener 双通道中间态边界用测试钉住；HAR 请求正文读失败注释失实修正；样例 HAR 复用真实 harBuilder 条目构造（消除 timings 漂移）；删除死代码 `tryLoggedSend` 与未使用依赖 jszip。
- 0.3.0 阶段 2 第九轮审核修复（P2-R9-1 + P3-R9-1）：RTCDataChannel 两处漏接的安装 catch（监听安装 / send 包装）照抄同文件模式补上 `reportHookFailure('webrtc-datachannel', ...)`，datachannel 证据面缺失不再静默；恶意 dc 反例测试钉住（修复前跑红验证）。droppedEvent 按方法计数快照随 `catalog/capture-facts.json` 落盘进包（stop 收尾末尾快照，含收尾期丢带；v1 / 硬崩溃为 null，恢复导出经字段展开透传），包内可见 droppedEvent 记账。
- 0.3.0 阶段 3（证据图与完整度）：`workflowStatusEngine` 从只读会话事实快照派生三态——`LOGIN_REACHED` 要求 POST + 正文 + 2xx/3xx + 响应 Set-Cookie 且**之后**有请求逐字节携带该 cookie，`KVM_REACHED` 要求 Viewer 活动组合时序（用户动作 → popup/显著导航 → 持续双向通道），否则 `TARGET_OPENED`；识别失败退回诚实下限并显式记账，绝不阻断采集与收尾；观察脚本钩子失败仅当对应观察面真实在场才映射 `channelGaps` 缺口。
- 0.3.0 阶段 3（证据图）：`valueFlowEngine` 只记字节级观察背书的值传播边（Set-Cookie → storage cookie → 后续请求 Cookie 头、crypto 输出 ⊆ 请求正文、先前响应正文值 == WS 握手 URL 查询参数，无匹配零边）；`catalog/relations.jsonl` 记 initiated / created / opened / value-flow 结构关系，全部走 knownIds 闭环（`UNKNOWN_EVIDENCE_ID` 门禁）；装配层 `ai/value-flow.json` 工作区文件优先。
- 0.3.0 阶段 3（Viewer 自动收尾）：`viewerActivity` 纯模块 + 看门狗 2s 轮询，检测到 Viewer 活动后 15s 稳定窗口（新 target/通道/动作重置）静默通过才自动 `controller.stop()`——绝不自动导出、不关窗、不弹保存框；识别/快照抛错只记诊断绝不停采集；renderer「当前作业」卡显示派生 workflowStatus。
- 0.3.0 阶段 3 修复：Chromium 真实事件序（`responseReceivedExtraInfo` 先于 `responseReceived`）下 Set-Cookie 只在 extraInfo——`responseReceived` 改为合并头而非整包替换；挂载中途失败补 `attached=false` salvage 行（已记录事务不得引用 catalog 中不存在的 target）；采集 E2E 未处理异常立即退出（进程不再悬死到超时）。
- 0.3.0 阶段 3 清理：删除观察脚本三个实例 id 櫏写入（`__kvmReconPcId` / `__kvmReconWtId` / `__kvmReconSseId`，id 经 payload 闭包流转，无读取方）；Mock KVM WS 回声链 25ms 节流（≈ 40fps 真实视频帧率，不节流回声环 ~5000 帧/s 超出采集落盘能力）。
- 0.3.0 阶段 3 第 11 轮审核修复（P3-R11-1~4 + 测试缺口）：value-flow「响应正文 / Set-Cookie → 消费者」边改用响应到达时间近似（请求开始 + timing.sendMs + waitMs）——crypto 调用 / WS 握手参数 / cookie 携带请求发生在请求开始与响应到达之间时页面尚不可能读到该正文，不得成边（timing 缺失时退回请求开始时间的诚实下限）；Viewer 看门狗自动收尾失败显式记账（新增诊断 `viewer-auto-stop-failed`，stop() 拒绝 / 同步抛错只记诊断，绝不产生未处理 Promise 拒绝）；workflowStatus 派生按事实变化签名缓存（renderer 2s 轮询在事实未变时直接命中缓存，不重跑 O(actions×navigations) 配对，签名投影覆盖派生引擎全部读取面含原位变更）；development-plan「导出恒为 INCOMPLETE + TARGET_OPENED」过期自相矛盾措辞修正（`COMPLETE` 只与 `KVM_REACHED` 组合是真实状态关系约束）。Mock KVM 采集器 E2E 接通 NetLog 源（include-sensitive，与生产同源）与 mainEnvironment，完整会话经 `exportJobWorkspaceZip`（含包一致性门禁）导出并断言 `COMPLETE + KVM_REACHED`——§20 验收场景 1 端到端闭环。
- 当前版本仍为 0.2.10：阶段 0–3 已在主分支落地，0.2.x 运行链路已删除（已发布安装包不受影响）；阶段 4–6 未实现，真机验收最后统一进行。

## [0.2.10] - 2026-09-16

- Dell iDRAC `/sysmgmt/2015/bmc/session` 使用 `user` / `password` 请求头认证时不再误报登录 POST 正文缺失；仍要求两个脱敏后的头名同时存在。
- HPE iLO5 `/redfish/v1/Sessions/` 纳入登录链；iLO `/wss/ircport` 作为直接 KVM 通道时，关键 HTTP API 项为不适用，不再强求不存在的 Token 接口。
- HPE 产品提示只从 Redfish/铭牌身份或 iLO 专属路径产生，不再因 Dell URL 中的 `FailoverFQDD` 子串误报 HPE。
- AMI IVTP 弱首字节只在 `/kvm` 且声明 `binary` / `base64` 子协议的 WebSocket 上标记，HPE IRC 等二进制流不再被提示为 AMI。
- Dell Angular 差分加载的 ES2015 / ES5 主包按逻辑 bundle 互为替代；现代 Chromium 已完整采到 ES2015 时，不再因未加载 `nomodule` ES5 包而 PARTIAL。
- 提升 HPE iLO、Dell DVC/APCP 与 Viewer Worker 关键源码的预算优先级；不提高 24 文件 / 8 MiB 安全上限。
- 新增 `KVM_RECON_FIELD_COLLECTION_2` 可选离线门禁，覆盖 27 个现场 ZIP、16 份 HAR、H3C HDM2、Dell 两种 Viewer、HPE iLO4/iLO5 及现有 AMI/Huawei 回归。

## [0.2.9] - 2026-09-15

- AMI HTML5 同时识别 `/api/kvm/token` 与 `/api/settings/media/h5viewercfg` 为明确 KVM 启动/Token 接口；后者不再当成宽泛 `kvm-entry`。`/api/session` + `h5viewercfg` 可作为 AMI 流量证据。采集器仍不主动探测这些接口。
- Worker/OOPIF 子会话里，入口脚本可能在父会话发出 `requestWillBeSent`、在 Worker 会话收到 `responseReceived`/`loadingFinished`。仅当 Worker target URL（保留非敏感 query）与**唯一**父入口脚本匹配时，才建立 `sessionId::requestId → parentId` 别名并补读源码。
- Worker 真正加载失败、detach 时仍无正文，或页面引用了 Worker 却采不到源码时，保持 PARTIAL，并保留明确原因。
- `http/capture-status.json` 仍记录全部在途请求和 CDP pending 任务。`network.capture.complete` 只对登录、一次性 KVM Token/启动接口、Viewer/Worker 源码，以及 Worker/OOPIF `target-attach` 降级。同窗口内已成功采过的 **GET KvmService 资源查询**（XHR/Fetch）不会单独把整包打成 PARTIAL；POST/PUT/PATCH/DELETE 的 KvmService、重复登录、重复 token/h5viewercfg、不同窗口的 Worker 仍为 PARTIAL。
- 两个 Viewer 并存时仍按 `captureWindowId` / 祖先链关联启动 HTTP 与 `/kvm` WebSocket，不按请求数量串链。
- 现场 zip 离线回归改为读取环境变量 `KVM_RECON_FIELD_PACKS`，不再硬编码本机路径；未设置或目录不存在时跳过。

## [0.2.8] - 2026-09-15

- 根 CDP 会话读取 HTML/JS/`getRequestPostData` 时不再传入空 `sessionId`，避免 Electron 44 报 `Empty session id is not allowed` 导致源码正文全空。
- 采集窗口在 `Network.enable` 前先完成 `about:blank` 提交，避免 Electron 44 空窗口卡死在开始采集；`Network.enable` 另有超时保护。
- 新增生产 Adapter/Controller E2E：`controller.start()` 必须在时限内返回，并覆盖主窗口首个 Document、弹窗 Document/脚本正文、`sourceFiles`、窗口血缘、`target=_blank` POST、referrer 与导出 zip 自校验。
- `--e2e-capture-controller` 不再因全部窗口关闭而以 0 退出；外层必须看到成功标记才算通过。断言前关窗必须失败。
- `http/sources.json` 的 `referenced.required` 在 0.2.7+ 为必填布尔；旧包缺字段时按关键引用处理，不能当成非关键放过 YES。
- 源码预算维持 24 个文件 / 8 MiB 硬上限。触达上限时清单明确提示重新采集无效，不要反复重采。
- 同步文档、包内 README 生成器和主窗口截图：生产采集 E2E 覆盖范围、采集桶与 `productHints`、代表机试采闸门，以及 GitHub Release 必须先存在再上传附件。
- `productHints` 不再回退成 `unknown-h5`：该名字只作采集桶。已知 AMI 等桶即使有通用 KVM 字样，产品提示也为空。
- 现场说明区分铭牌 `observed` 与 `productHints`：人工填写的厂商名不是产品提示，H3C 缺少 HDM2 证据时提示可能为空。

## [0.2.7] - 2026-09-14

- Viewer/登录源码按清单与完整性判定：未知族要求可靠 Viewer 窗口内的第一方脚本（含惠普 `application.js` / `iLO.js` 等普通文件名）以及 main/polyfills/runtime/worker 与 kvm/viewer 等关键词；首页其余脚本完整与否不再挡住 YES。
- 从 `document.scripts` / `performance` / iframe 建立页面引用源码清单，并与 Network/`http/sources.json` 按窗口和规范化 URL（敏感 query 去值后比对）核对；只采到 worker、漏掉 Viewer 主脚本时未知族为 PARTIAL。
- HTTP(S) 弹窗保留原生 `window.open`（`allow`），以保留 Window 句柄、`window.opener`、frameName、referrer 和 `target=_blank` POST；弹窗首个 HTTP 触发时立即 attach CDP，且先注册监听再 `Network.enable`，避免漏采 Document/主脚本。
- `http/sources.json` 的 `referenced.required` 区分关键源码与信息性引用；YES 包重新打开时只阻断缺失的关键项。
- 打包链路 `js-yaml` 通过 overrides 固定到 `4.3.2`，修复 empty merge 的 High 级 DoS。
- JavaScript 识别同时看 CDP `resourceType=Script` 与 IIFE/`!function` 正文，错误 MIME 不再只留 512 字符。
- 导出独立源码文件 `http/sources/*.js|html` 与 `http/sources.json`（最长约 2 MiB），JSONL 仍只保留 64 KiB 摘要。
- 打开/对比 zip 时校验源码清单路径、字节数与 SHA-256；未知族 YES 必须含完整源码。
- 包内 README 增加 `http/sources.json` 与 `http/sources/` 阅读说明。
- 实时就绪纳入未完成请求/pending 任务；网络未静默时不能显示最终 YES。
- 窗口关联保存祖先链，三层弹窗可把主窗口 token 与 Viewer 子窗 WebSocket 关联，兄弟弹窗仍不关联。
- HAR comment 写入 `openerCaptureWindowId` / `ancestorCaptureWindowIds` 与源码哈希字段。
- 收紧 KVM WebSocket 可靠帧判定：静态 KVM 资源不再作为启动链，通用二进制 `/websocket` 的弱 AMI 帧必须关联同窗口、短时间内的成功 KVM 启动请求。
- 关键登录 POST / KVM 启动接口缺少请求或响应正文时降为 PARTIAL；CDP `hasPostData` 无内联 body 时调用 `Network.getRequestPostData`。
- 弱 AMI 帧只关联明确 token/启动接口，不再信任宽泛 `kvm-entry`（如 `/api/console/status`）。
- HTTP/WS/页面事件/截图按 `captureWindowId` 关联，并记录 `openerCaptureWindowId`；主窗口 token + 子窗口 WS 视为同一上下文，兄弟弹窗不关联。`main/popup` 仅作展示。
- `adapter-evidence.json` 与就绪判定共用同一套窗口/两分钟/成功请求关联。
- OOPIF auto-attach 使用 `waitForDebuggerOnStart`，先 `Network.enable` 再恢复目标；`Network.enable` 失败时仍解除暂停并记入 `attachFailures`，清单降为 PARTIAL。
- 自动 viewer 截图在指定 `captureWindowId` 时不再退回其他弹窗。
- 关键 KVM token/启动接口遇到 `loading-failed` 或 `response-too-large` 时降为 PARTIAL。
- 戴尔 iDRAC HTML5 同时识别 `/vmc/vconsole` 与 `/vnc/vconsole`，product hint 按实际路径输出。
- 手动补拍新协议 Viewer 时记录 `operatorConfirmed`并返回实际采集结果，操作员确认不会自动让 WebSocket 证据通过。
- Popup 页面的点击、storage、截图与 selector 绑定同一窗口；按窗口和页面角色聚合全部 storage/selector 快照，并支持 iframe/OOPIF Viewer 候选。
- 登录后复验按每个实际探测 URL 读取符合 domain/path 的 BMC Cookie，不再丢失 `/api` 或 `/redfish` 路径 Cookie。
- 对齐 randomtag `200` 命中语义、非默认端口 Host 和基础连接判定，并限制主动探测正文为 1 MiB。
- 修复 Adapter evidence 与 Schema 不一致，新增 Ajv 样例包契约测试和 `1–65535` 端口双重校验。
- 华为虚拟媒体端口 `8208` 不再当作 KVM 视频 WebSocket；KVM 只认 `2198`/`2199`。
- 可靠 KVM WebSocket 至少要求一条下行帧，仅客户端上行认证/控制包不再判 YES。
- 弹窗 `debugger.attach` / `Network.enable` 失败记入 `attachFailures`，不再形成未处理拒绝。
- 弹窗 URL/opener 直接使用 Electron `did-create-window` 详情，去掉全局 `pendingPopup`，避免并发/嵌套弹窗串窗。
- 自动截图按最新可靠 KVM WebSocket 选择窗口；已关闭的旧 Viewer 失败后继续尝试新窗口。
- 主界面实时就绪纳入当前 `attachFailures`，不再等导出时才从 YES 变成 PARTIAL。

## [0.2.6] - 2026-09-13

- 探测改为无副作用路径，不再主动领取 AMI 一次性 KVM Token 或调用 KVM Action。
- 登录就绪要求成功 POST 与会话证据；完整保留 HTTP 重定向 hop 和 CDP ExtraInfo 请求/响应头。
- 对齐生产协议族优先级与 AMI/OpenBMC/Huawei 强指纹，扩展受控响应体、WS 帧采样和流式请求边界。
- 使用 CDP ExtraInfo 标志精确关联请求与响应的重定向 hop，保证原始响应状态/头优先并在请求头补全后重算链路标签；TLS、Redfish 与两个 randomtag 探针并发启动，并收紧 TLS subject 字段语义。
- Capture Pack 增加 Git build ID、网络采集状态与响应体跳过原因，便于现场确认版本和资料完整性。
- Electron 烟测在二进制缺失时快速失败，避免依赖加载阶段无限等待。
- CI 显式安装 Electron 44 懒下载二进制，确保快速失败保护不会跳过真实启动烟测。

## [0.2.5] - 2026-08-25

- 说明：采集桶（含 `unknown-h5` / `not-h5`）不是网关 Adapter 主键；包内 README 增加「核对真实族再动手」；新增 `docs/kvm-family.md`（市面 BMC 产品名如 `dell-idrac-h5`，未知族默认新建 Adapter、不要先改现网三族）
- 清单：未识别桶的「协议族指纹」为不适用，不再当成已通过，也不再因此挡住 YES；主窗口打开 zip 时显示「采集桶」
- README 主窗口截图换成当前空闲态（现场厂商占位「不作为采集桶」，补拍默认登录页）

## [0.2.4] - 2026-08-25

- 路径探测：HTML 200 不算命中（含 UTF-8 BOM）；2xx 需为 JSON 或短非 HTML 文本；401/403/405 仍算接口存在。`/kvm/video` 的匿名 GET 401 不算
- 登录后复验为 false 的路径覆盖匿名结果，不再用 OR 合并把假阳性留下
- 取消「有 AMI `/api` 就禁止 OpenBMC」；证书 `O=OpenBMC`、`/xyz/openbmc_project` 订阅、真实 `/kvm/video` WebSocket 参与打分
- AMI 只靠路径存在不再给 0.9；页面 document 导航不计入 AMI HTTP 证据
- 现场清单、作业列表和导出包用同一套 TLS + 真实 HTTP/WS 重判 `kvmFamily`

## [0.2.3] - 2026-08-25

- 主窗口标题旁显示当前工具版本，与 `package.json` / 导出包 `manifest.tool.version` 一致
- README 改为英文默认入口，并提供 [简体中文](README.zh-CN.md)；补充主窗口整页截图
- `schema/` 增补 `page/timeline.jsonl`、`tls/certificate.json` 及页面/探测等导出文件的独立 JSON Schema
- 导出包根目录改为中文 `README.md`（阅读地图 + 适配前裁定），不再写 `artifacts/handover.md`
- 精简 `docs/development-plan.md` 为当前状态与边界，不再展开已完成阶段清单
- KVM 画面截图只认 `role=viewer`；仅登录页/异常页截图不再算已采集、不会因此升 YES
- 包内 `report.md` / `report.html` 只保留检查项，阅读说明指向根目录 `README.md`
- 补拍画面默认改为登录页；本地打开 zip 会检查截图是否带 role
- 包内 README 摘要改为「KVM 画面截图」（只计 viewer）；架构文档改名为 `docs/architecture.md`
- 普通导出失败：修复目录/磁盘问题后重新导出；脱敏检查失败：重新采集，不能直接重复导出同一份内存数据。提示改为「重新导出 Capture Pack」，不再点名「停止采集并导出」（YES 时主按钮文案不同）
- 现场说明导出步骤同时写出「导出 Capture Pack」与未齐时的「停止采集并导出」

## [0.2.2] - 2026-08-25

- 用 IP 打开 BMC 时采集窗口自动信任自签证书，避免 Chrome 能过「高级」而采集窗白屏；IP 访问不再设置 TLS SNI
- 「查看 → 采集窗口诊断」可显示加载失败与页面报错；采集窗口因 CDP 占用无法打开开发者工具
- 打开 HTML5 KVM 并收到画面数据后自动截图；已有画面时导出/补拍不再重复截
- 采集进度项名称不再带「已采集」，结果只显示在右侧状态列
- 下一步提示（登录 / 打开 KVM / 导出）改到操作按钮下方；就绪后显示「可导出」，导出后显示「已导出」

## [0.2.1] - 2026-08-25

- 修复安装包因 `"type": "module"` 把预加载脚本当成 ESM，导致无法新建采集、打开/对比/导出 Capture Pack 的问题
- 主界面铭牌改为厂商/型号一行、固件/位置一行，避免型号被截断

## [0.2.0] - 2026-08-25

- 使用项目图标替换 Electron 默认图标（macOS / Windows）
- macOS：ad-hoc 签名，Gatekeeper 提示「无法验证开发者」而非「已损坏」；在「隐私与安全性」中允许
- Windows：安装包无 Authenticode 签名；SmartScreen 可能提示未知发布者，选择「更多信息 → 仍要运行」
- 修复已创建的 GitHub Release 无法挂上安装包、SHA256SUMS 步骤报 `no assets to download` 的问题

## [0.1.0] - 2026-08-24

- 离线采集客户端：探测、手工登录采集、HTTP/WS、脱敏导出 Capture Pack
- 暂停/继续、多作业、独立 JSON Schema、本地打开/对比 Capture Pack、现场铭牌备注
- 登录后 Cookie 复验（值不落盘）、HTTP/WS `windowRole`
- GitHub Actions CI 与安装包发布 workflow
