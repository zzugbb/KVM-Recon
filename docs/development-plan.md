# KVM-Recon 开发计划

本文说明产品边界和当前状态。已完成阶段不再逐条展开；现场看 `docs/offline-field-guide.md`，出机房后看**包内** `README.md`。

> **0.3.0 目标设计提示：** 主分支已进入 0.3.0 开发（Capture Pack 2.0，协议无关、证据优先、不脱敏、单作业）。产品流程、无脱敏策略、单作业界面、手动导出、包格式和完整度门禁以 [`docs/v0.3-development-spec.md`](v0.3-development-spec.md) 为唯一权威规范。本文第 2 节之后描述的 8 作业、包对比、大小限制、脱敏与 YES/PARTIAL/NO 清单只对**已发布的 0.2.10 安装包**有效，不要带入新架构。

## 1. 目标

机房离线运行的 macOS / Windows 桌面客户端：采集 BMC HTML5 KVM 适配所需资料，导出 Capture Pack，并用完整度门禁判断资料是否够离开机房后做网关适配。

## 2. 全局约束

- 不依赖公网，不在现场调用外部分析服务。
- 采集不脱敏：POST 口令 / Cookie 值 / 帧正文必须逐字节在包（规范 §13），包 manifest 显式声明 `UNREDACTED`。
- 不实现生产 KVM 网关，不实现浏览器插件。
- 厂商/型号只作设备说明铭牌，不能覆盖采集桶；`unknown-h5` / `not-h5` 不能当网关 registry 名。下游裁定见 `docs/kvm-family.md`。
- 未知族只导出资料包，不自动生成 Adapter。

## 3. 当前状态（2026-09-23）

**0.3.0 阶段 0–4 已在主分支落地；运行版本仍是 0.2.10（未发新安装包）。**

- 阶段 0（契约）：Capture Pack 2.0 类型与三正交状态、`schema/2.0/`（33 个 Schema，包内自校验）、随机 URL Mock KVM、完整度失败 Fixture 与样例包一致性验证器。
- 阶段 1（工作区）：单作业 `JobWorkspace`（跨进程互斥、磁盘水位、finalize 不可变）、SHA-256 内容寻址 `BodyStore`、流式 ZIP64 导出。
- 阶段 2（采集）：`src/core/collector/` 协议无关全量采集（CDP journal、HTTP/HAR、WS 全帧、WebCrypto、脚本/Worker/WASM、NetLog、截图/DOM 快照/时间线、Storage、实时通道）；生产 Controller + 单作业 Electron 壳 + 崩溃恢复（保守证据摘要；恢复只提示不自动导出，恢复卡手动选择目录导出，成功才 markExported）。
- 阶段 3（证据图与完整度）：`workflowStatusEngine` 从只读事实快照派生三态（`LOGIN_REACHED` 要求观察到的 Set-Cookie 传播、`KVM_REACHED` 要求“动作 → 打开/导航 → 新渲染/执行表面 → 双向通道”的严格时序）；popup 与 iframe/OOPIF/Worker 均按 opener/parent target 血缘归属，初始截图与手动/自动收尾无竞态，popup 的 sessionStorage/IndexedDB/CacheStorage 独立留存；脚本源码取不到时仅允许用相同 CDP hash 的已采正文补全，否则降级完整度，采集器自身带 `kvm-recon-internal://` 标记的探针不进入目标脚本门禁。`valueFlowEngine` + `catalog/relations.jsonl` 只记字节级观察背书的值传播边与结构关系（knownIds 闭环门禁，响应到达时间含 `receiveMs`）；浏览器状态与证据图失败显式记入缺口；Viewer 检出后的 15s 稳定窗口只自动 `controller.stop()`，绝不自动导出/关窗。
- 阶段 4（AI/Replay 生成器）：`readPackFacts` 装配时从包内工件重建 `WorkflowFacts`（主框架导航从 `raw/cdp/events.jsonl` 重放 `Page.frameNavigated`，缺文件记派生缺口不阻断导出）；`dossierEngine` 七角色候选链与 `ai/index.json` 候选（复用 loginChainOf / detectViewerActivity 同一判定）；`replayEngine` 派生 `replay/manifest.json` + `http.jsonl` + `channels.json`（`requiresDynamicValueIds` 引用值传播图 replaySubstitution 边来源值，不可回放时 `notReplayableReasons` 逐条说明缺什么）；值传播图新增 storage 值链（响应正文 ⊇ sessionStorage/localStorage 值 → 后续头/查询参数）；协议 Fixture 回放 E2E（全新实例按 manifest 动态值替换重放，服务端接受 + 4 组陈旧值负向对照）；样例包 dossier/replay/value-flow 全部换真实引擎，附离线再生契约测试（§15 只凭包内工件重新派生结果相等）。
- 0.2.x 运行链路与五项大小上限已删除；新链路无上限、不脱敏；workflowStatus 由阶段 3 派生引擎从观察事实给出（可达 `KVM_REACHED`），完整度由十项门禁从证据摘要派生——`COMPLETE` 只与 `KVM_REACHED` 组合，未到达 KVM 时 `INCOMPLETE + INCOMPLETE_WORKFLOW_NOT_REACHED`。
- 验证：vitest + E2E 全绿，含 Mock KVM 真实浏览器对照、协议 Fixture 回放与现场 HAR 回放（`KVM_RECON_FIELD_COLLECTION_2` 指向语料目录，只读）；真机验收按产品安排最后统一进行。

未开始：阶段 5（界面收口）、阶段 6（全量验收）。

**下一步：** 阶段 5——界面收口（单屏单作业工作台，删除多作业/包对比入口）。

安装包由 GitHub Actions 构建：macOS 为 ad-hoc 签名，Windows 无 Authenticode。

**产品边界止于导出 Capture Pack。** 自动写 Adapter、机房内 AI、MITM、自动登录、完整视频解码不属于本项目。

## 4. 已发布 0.2.10 能力（历史，主分支已由 0.3.0 链路替换）

| 能力 | 说明 |
| --- | --- |
| 探测 | TLS、Redfish、路径形态 + 真实 HTTP/WS 族判定、`unknown-h5` / `not-h5` |
| 采集窗口 | 隔离 Chromium、自签证书、popup、选择器、storage key |
| 网络 | CDP 记 HTTP/HAR、WS 元数据与采样帧、`windowRole` |
| 画面 | 打开 HTML5 KVM 并收到画面后自动截 `role=viewer`；清单/包 README 只认 viewer。可选补拍登录页/异常画面 |
| 导出 | 脱敏检查、清单、`report.html`、包内中文 `README.md`、已知族 Profile 草稿 |
| 作业 | 暂停/继续、最多 8 份、关窗后仍可导出、再次导出 |
| 复核 | 本机打开/对比 zip；独立 JSON Schema 在 `schema/`（权威仍是 TypeScript） |
| 铭牌 | 现场厂商/型号/固件/位置，不改写 `kvmFamily` |

故意保持：storage 只导出 key；不采集 Cookie 写入调用来源；铭牌只在新建作业时填写。

## 5. 真机验收闸门

按产品安排进行，不阻塞采集侧收口。最低证据：

1. AMI MegaRAC：登录 → HTML5 KVM（含 popup）→ 包内可见 token API 与 KVM WS。
2. 华为 iBMC：可见 `KvmService` / `SetKvmKey` / WS 元数据。
3. OpenBMC H5：可见 Session 与 `/kvm/video` 或等价 WS。
4. 未知或非 H5：`unknown-h5` 或 `not-h5`，不生成空壳 Adapter。
5. 导出 zip 可在另一台离线电脑打开 `report.html`，并阅读根目录 `README.md`。
6. Windows 安装包由 GitHub Actions 构建即可，本机交叉打包非必须。

## 6. 与下游适配

KVM-Recon 交出 Capture Pack，不写 Adapter。出机房联网后，工程师或 AI 只读本包：

- 先看根目录 `README.md`，再按文件地图打开 `manifest.json`、checklist、HTTP/WS。
- 按 `docs/kvm-family.md` 判断：流量是否与现网三族同构；`unknown-h5` / `not-h5` 默认新建 Adapter，用市面 BMC 产品名，不要先改现网三个。
- `artifacts/oem-profile.yaml` 只供审核，不是可上线 Adapter。

上述工作不在本仓库实现。

## 7. 故意不做

- 自动登录、MITM、机房内调用 AI、根据 Capture Pack 自动写 Adapter、完整 KVM 视频解码。
- 界面英文化、为窗口标题再挂版本（页面已有 `vX.Y.Z`）。
- Apple / 微软付费代码签名与公证（当前 ad-hoc / 无 Authenticode 足够内部分发）。
- ~~运行时引入 ajv~~（0.2 曾刻意不做；0.3.0 起 Capture Pack 2.0 导出完整度门禁要求按包内 Schema 副本执行自校验，`ajv` 已移入运行时依赖，0.2.x 行为不变）；为 README / yaml / HAR 再补项目内 Schema。

## 8. 开源治理与发布

已有 MIT 许可、CONTRIBUTING、CI（typecheck / 单测 / 构建 / 生产采集 E2E）、Build installers、Release 挂包。步骤见 `docs/releasing.md`。

不做：把证书写入仓库；对真实 BMC 做在线 e2e（没有公开 BMC，也不自动登录）。
