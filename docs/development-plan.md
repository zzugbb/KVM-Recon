# KVM-Recon 开发计划

本文说明产品边界和当前状态。现场操作见 [现场指南](field-guide.md)，离场后首先阅读导出包内的 `00_START_HERE.md`。

Capture Pack 2.0 的详细契约见 [0.3 开发规范](v0.3-development-spec.md)。历史 0.2.x 实现和格式可从已发布 Git 标签查阅，不再作为当前源码的兼容目标。

## 1. 目标

机房离线运行的 macOS / Windows 桌面客户端：采集登录 BMC 至打开 HTML5 KVM 的可观察证据，手动导出 Capture Pack。完整度门禁说明采集事实是否闭合，不保证任何具体 Adapter 一定能离线完成。

## 2. 全局约束

- 不依赖公网，不在现场调用外部分析服务。
- 采集不脱敏：POST 口令 / Cookie 值 / 帧正文必须逐字节在包（规范 §13），包 manifest 显式声明 `UNREDACTED`。
- 不实现生产 KVM 网关，不实现浏览器插件。
- 设备说明是自由文本，不参与采集或完整度判断。采集器不做协议族或厂商分类，也不生成 Adapter。

## 3. 当前状态（2026-09-23）

**0.3.0 阶段 0–5 已在主分支落地；运行版本仍是 0.2.10（未发新安装包）。**

- 阶段 0（契约）：Capture Pack 2.0 的完整度与工作流状态、`schema/2.0/`（包内自校验）、随机 URL Mock KVM、完整度失败 Fixture 与样例包一致性验证器。
- 阶段 1（工作区）：单作业 `JobWorkspace`（跨进程互斥、磁盘水位、finalize 不可变）、SHA-256 内容寻址 `BodyStore`、流式 ZIP64 导出。
- 阶段 2（采集）：`src/core/collector/` 协议无关全量采集（CDP journal、HTTP/HAR、WS 全帧、WebCrypto、脚本/Worker/WASM、NetLog、截图/DOM 快照/时间线、Storage、实时通道）；生产 Controller + 单作业 Electron 壳 + 崩溃恢复（保守证据摘要；恢复只提示不自动导出，恢复卡手动选择目录导出，成功才 markExported）。
- 阶段 3（证据图与完整度）：`workflowStatusEngine` 从只读事实快照派生三态（`LOGIN_REACHED` 要求观察到的 Set-Cookie 传播、`KVM_REACHED` 要求“动作 → 打开/导航 → 新渲染/执行表面 → 双向通道”的严格时序）；popup 与 iframe/OOPIF/Worker 均按 opener/parent target 血缘归属，初始截图与手动/自动收尾无竞态，popup 的 sessionStorage/IndexedDB/CacheStorage 独立留存；脚本源码取不到时仅允许用相同 CDP hash 的已采正文补全，否则降级完整度，采集器自身带 `kvm-recon-internal://` 标记的探针不进入目标脚本门禁。`valueFlowEngine` + `catalog/relations.jsonl` 只记字节级观察背书的值传播边与结构关系（knownIds 闭环门禁，响应到达时间含 `receiveMs`）；浏览器状态与证据图失败显式记入缺口；Viewer 检出后的 15s 稳定窗口只自动 `controller.stop()`，绝不自动导出/关窗。
- 阶段 4（证据导航与 Replay）：`readPackFacts` 从包内工件重建事实；`dossierEngine`、`valueFlowEngine` 与 `replayEngine` 派生适配研究所需的候选请求、值传播、缺口与回放计划。它们不输出协议族或厂商判定；回放不可执行时逐条说明缺失资料。
- 阶段 5（界面收口）：`stage.ts` 八阶段纯函数派生（idle/launching/capturing-login/capturing-viewer/finalizing/complete/incomplete/exported + 四步阶段条三态；已收尾但未派生 COMPLETE 一律按 incomplete，不主张未验证的完整）；界面重排为规范 §5 单屏单作业工作台（深石墨色板、稳定宽度计数器、最近事实 feed、高级诊断 `<details>` 默认折叠、lucide-react 图标）；`capture:status` 载荷扩展（计数器 / 包工件字节记账 / 收尾后预导出完整度 / 最近事实 / 磁盘余量与日志尾部）；导出收口（INCOMPLETE 按钮明确「导出未完整包」、「打开所在文件夹」路径由主进程决定、「采集下一台」丢弃清理）；删除 0.2.x 死 CSS 选择器。
- 阶段 5 之后的修正：原始日志与正文流式读取，Replay 动态值闭环，启动失败和崩溃恢复的证据保留；曾加入的离线协议分类 Analyzer 已移除，协议分类不属于采集器职责。
- 0.2.x 运行链路与五项大小上限已删除；新链路无上限、不脱敏；workflowStatus 由阶段 3 派生引擎从观察事实给出（可达 `KVM_REACHED`），完整度由十项门禁从证据摘要派生——`COMPLETE` 只与 `KVM_REACHED` 组合，未到达 KVM 时 `INCOMPLETE + INCOMPLETE_WORKFLOW_NOT_REACHED`。
- 当前分支需要重新跑完整门禁；现场 HAR 回放依赖 `KVM_RECON_FIELD_COLLECTION_2`，未设置则跳过。真机与安装包验收仍属阶段 6，尚未执行。

未开始：阶段 6（全量验收）。

**下一步：** 阶段 6——全量验收（按规范 §20 验收场景与真机安排统一进行）。

安装包由 GitHub Actions 构建：macOS 为 ad-hoc 签名，Windows 无 Authenticode。

**产品边界止于导出 Capture Pack。** 自动写 Adapter、机房内 AI、MITM、自动登录、完整视频解码不属于本项目。

## 4. 阶段 6 验收边界

- 用 Mock KVM 检查随机路径、动态凭据、Viewer、Worker、WebSocket 和导出包引用闭环；未知架构不能因缺少签名被降级。
- 用历史现场与家庭语料回放核对原始 HTTP/WS/脚本/画面是否保留，不把厂商名称作为成功条件。
- 在可用真机上从登录到 KVM 画面验证，再独立检查 ZIP、checksum、完整度原因和离线阅读顺序。
- 现场语料和 InManage 属于仓库外资产，本项目的清理不修改它们；无法真机验证的部分必须作为未完成验收记录。

## 5. 下游交接与发布

KVM-Recon 只交付 Capture Pack。工程师或 AI 先看包内 `00_START_HERE.md`、`manifest.json`、`integrity.json`、`ai/index.json`，再沿 catalog、raw、value-flow 和 replay 追踪证据。是否属于某个现有网关协议族、如何实现 Adapter，由下游项目判断，不在本仓库编码。

CI、安装包签名和发布步骤见 [发布指南](releasing.md)。不自动登录、不做 MITM、不在机房调用外部 AI，也不把现场凭据提交到仓库。
