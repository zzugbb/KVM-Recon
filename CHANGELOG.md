# Changelog

本文件记录用户可见变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 和 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

- **日常开发**：把尚未随安装包发出的改动写在 `[Unreleased]`。
- **发布新版本**：把 `[Unreleased]` 里的条目移到新版本标题下（如 `[0.1.1] - YYYY-MM-DD`），同步 `package.json` 的 `version`，再打 `v*` 标签。GitHub Release 说明可从该版本章节复制。

## [Unreleased]

- 0.3.0 阶段 1（磁盘工作区与流式导出）落地：`src/core/job-workspace/` 单作业磁盘工作区——同一时刻仅一个 active 作业；`workspace.json` 持久化 `workspaceId` 与 `exported`；读写/导出/清理前核验实例身份。跨进程互斥为 OS 内核独占（Windows 版本化命名管道 / Linux 抽象 socket / macOS `O_EXLOCK` 版本化锁文件），不自动 unlink/迁移陈旧 unix socket；`waitMs` 必须是有限非负数，供 close/finalize/cleanup/markExported 等待，start/recover 立即失败。`current/.owner` 只创建不偷取；close 先成功释放 owner 再提交 closed。空 `current/` 与损坏标记失败关闭并保留现场。`finalized` 且未导出可恢复只读导出，仅 `markExported`（ZIP 自校验成功）后允许清理或启动下一作业。`writeArtifact` / `appendJsonl` / BodyStore namespace 统一拒绝 `.owner`、`workspace.json`、`.tmp/`。磁盘水位默认预留 5 GiB，`storageLimited` 粘性持久化。finalize 是不可变边界。JSONL 追加 + 周期性 fsync。新增 `src/core/body-store/` SHA-256 内容寻址流式正文；finish/abort 失败走可重试 `cleanupPart()`，close 与 rm 都成功后才释放租赁。新增 `src/core/export/` checksums 与流式 ZIP64 导出（DOM 快照 `.html` 只带流式 sha256/bytes，不整文件载入）。遗留 0.2.x 运行链路未改动。
- 0.3.0 阶段 0（契约先行）落地：新增 `src/core/capture-pack-v2/` 的 Capture Pack 2.0 类型契约——三正交状态（`captureIntegrity` COMPLETE/INCOMPLETE/LEGACY_UNVERIFIED、`workflowStatus` KVM_REACHED/LOGIN_REACHED/TARGET_OPENED、`classificationStatus` KNOWN/UNKNOWN，`COMPLETE + KVM_REACHED + UNKNOWN` 为合法组合）、11 个 `INCOMPLETE` 稳定原因代码（十项完整度门禁失败全部映射显式原因；`COMPLETE` = 无原因且十项门禁全过，门禁集合必须恰好覆盖十个唯一 ID）、`derivePackIntegrity` 完整度派生、`manifest.security` 固定 `UNREDACTED` / `containsSensitiveData=true`、`job.deviceLabel` 自由文本设备说明、§11 目录契约与 `00_START_HERE.md` 内容契约、§10 ZIP 命名（不含协议族，非法时间拒绝），以及 Capture Pack 1.x 导入固定 `LEGACY_UNVERIFIED` 且不可升级 `COMPLETE`。
- 新增 `schema/2.0/`：30 个 JSON Schema 与 TypeScript 类型同步，含字段关系约束（`COMPLETE` 必须 `KVM_REACHED`；`COMPLETE` 的 reasons 为空且十项门禁全过；`INCOMPLETE` 至少一个原因；gates 恰好覆盖十个唯一门禁），Ajv 正负向测试校验；`ajv` 移入运行时依赖，导出时按包内 Schema 副本执行自校验。
- 新增 `src/core/mock-kvm/createMockKvmServer.ts`：完全未知、随机 URL 的本地 Mock KVM（登录页 → 登录 API → 控制台 → KVM 启动 → Viewer 页 + Worker → 双向 WebSocket）；固定 seed 可复现；对现有全部厂商 URL/路径/帧签名零命中；样例驱动走 SHA-256 摘要凭据登录链。
- 新增 11 个完整度失败 Fixture（每个 `INCOMPLETE` 原因一个）与正向 / legacy Fixture；新增独立样例包一致性验证器 `packV2Consistency.ts`：checksums 覆盖与重复条目、包内 Schema 自校验（30 个预期 Schema 必须全部在场，缺任一副本即 `PACK_SCHEMA_MISSING`；每个副本的 `$id` 必须与文件名对应，验证函数按文件名保存与调用，缺失即报错——不因缺 Schema、篡改 `$id` 或缺验证函数静默跳过）、状态一致与门禁 ID 合法性、正文/脚本/实时消息/下载/crypto/通道引用闭环（按 `channel.kind` 分派，WebSocket 必须有 payloadPath，catalog 通道与实时事件按 ID/URL 关联）、帧偏移、Viewer 双截图、空 journal 检测、00_START_HERE 契约、非法顶层条目、重复路径、relations/value-flow 节点与边的 evidencePath、value-flow 节点 evidenceId、replay 动态值节点与 `replay/http.jsonl` 引用，负向测试 36 项（另含 replay manifest ↔ replay/http ↔ catalog、replay channels ↔ catalog 逐项对齐、通道动态值集合相等、replay 各文件 ID 唯一、正文路径与 catalog BodyRef 逐项一致校验）。
- Mock KVM 登录链改为真实摘要验证：登录页内联脚本通过 WebCrypto 计算 `SHA-256(passphrase:nonce)` 并提交，登录接口校验摘要（错误凭据返回 401）；阶段 2 的 Collector 必须从真实浏览器捕获该运行时加密链才能复现登录。
- Mock KVM 登录验证用户名与摘要，会话严格校验：登录接口同时验证用户名（operator）与摘要凭据；console / launch / viewer / WS 握手统一 `hasValidSession()`，Cookie 值必须等于签发的 sessionToken（伪造同名 Cookie 一律 401/拒绝）。
- Mock KVM 浏览器链路真实可走通：登录成功后脚本存 csrfToken 并跳转控制台；控制台按钮点击真实发起带 CSRF 头的启动请求（服务端校验，缺失/错误 403）后跳转 Viewer；Viewer 页脚本创建 Worker 并以查询参数携带 viewerToken 建立 WebSocket（服务端在升级握手校验会话 Cookie 与 token）。新增 Electron 真实浏览器流程 E2E（`e2e/mock-kvm-browser-flow.mjs`，真实键盘输入与鼠标点击走通登录 → 控制台 → Viewer → Worker → WebSocket，断言全部来自服务端观察到的请求与帧），已并入 `npm run test:e2e`。
- Replay 通道契约闭环：`PackV2ReplayChannel` 与两个 replay Schema 增加 `requiresDynamicValueIds`（必填）；样例 WS 通道声明 value-0002（Session Cookie）与 value-0005（viewerToken）；一致性验证器新增 `REPLAY_MISMATCH`——manifest 请求必须逐项存在于 replay/http.jsonl 且 URL/method 与 replay/http.jsonl、catalog resources 一致（双向，不允许单侧删行）、manifest 通道与 replay/channels.json、catalog channels 三方对齐。
- 样例包证据与 Mock 实际协议逐项一致：KVM 启动请求携带 CSRF 头；WS 握手 URL 含 viewerToken 查询参数且 Cookie 头为实际发送值；value-flow 记录 viewerToken → WS 查询参数的真实传播；删除无法从采集事实证明的 Worker↔WS `attached` 关系；storage 记录页面脚本实际写入 sessionStorage 的 csrfToken / viewerToken。
- 实时消息字段进入 Schema 条件约束：WebRTC `datachannel-message` 必须携带方向/通道标识/消息序号/FIN/正文引用；WebTransport `stream-message`/`datagram` 必须携带正文引用；`completed=true` 的下载必须有 `fileRef`；成功的 crypto 调用必须有输入、输出或异常之一；SSE 行增加生命周期 `kind`（connected/event/error/closed）。
- 数据契约补齐原始资料要求：NetLog 未识别字段与常量原样透传；WebRTC / WebTransport 消息行带方向、消息序号、通道/stream 标识、FIN 边界与正文引用；新增 `raw/realtime/sse.jsonl`（EventSource 事件与 dataRef）与 `raw/realtime/downloads.jsonl`（下载触发链与文件引用）；新增 `raw/runtime/crypto.jsonl` 运行时算法调用契约（算法、参数、输入输出 BodyRef、调用脚本位置、异常）；浏览器 Storage 增加 IndexedDB / CacheStorage；WebSocket metadata 增加协商扩展、关闭码与关闭原因，帧索引增加 continuation/FIN 边界；HTTP 事务增加发起栈（initiator/stackTrace）、Referer、frameId/windowId、内容编码、时序与连接信息。
- 新增 `examples/capture-pack-v2/` 版本化样例包：COMPLETE + KVM_REACHED + UNKNOWN，由固定 seed Mock 驱动生成；完整度从观察事实与预验证派生（非预先声明），含 Viewer 初始与稳定双占位截图（真实画面由阶段 2 采集器生成）与摘要凭据登录链的 crypto 事实。
- 当前版本仍为 0.2.10：阶段 0 与阶段 1 已落地；阶段 2-6（采集器 / 完整度引擎 / AI 索引 / 新界面 / 全量验收）未实现，0.2.x 运行链路行为不变。

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
