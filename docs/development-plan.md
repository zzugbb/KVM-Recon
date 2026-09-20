# KVM-Recon 开发计划

本文说明产品边界和当前状态。已完成阶段不再逐条展开；现场看 `docs/offline-field-guide.md`，出机房后看**包内** `README.md`。

> **0.3.0 目标设计提示：** 本文主体记录 0.2.x 当前实现。下一阶段将重构为协议无关、证据优先的 Capture Pack 2.0 采集器；产品流程、无脱敏策略、单作业界面、手动导出、包格式和完整度门禁以 [`docs/v0.3-development-spec.md`](v0.3-development-spec.md) 为唯一权威规范。开发时不要把本文的 8 作业、包对比、大小限制、脱敏或 YES/PARTIAL/NO 继续带入新架构。

## 1. 目标

机房离线运行的 macOS / Windows 桌面客户端：采集 BMC HTML5 KVM 适配所需资料，导出脱敏 Capture Pack，并用离场清单判断资料是否够离开机房后做网关适配。

## 2. 全局约束

- 不依赖公网，不在现场调用外部分析服务。
- 不保存明文密码、Cookie 值、完整 KVM 视频码流。
- 不实现生产 KVM 网关，不实现浏览器插件。
- 厂商/型号只作铭牌，不能覆盖采集桶；`unknown-h5` / `not-h5` 不能当网关 registry 名。下游裁定见 `docs/kvm-family.md`。
- 未知族只导出资料包，不自动生成 Adapter。

## 3. 当前状态（2026-09-20）

**0.3.0 阶段 0（契约先行）与阶段 1（磁盘工作区与流式导出）已实现，运行版本仍是 0.2.10。** 已落地：`src/core/capture-pack-v2/` 的 Capture Pack 2.0 类型、三正交状态（captureIntegrity / workflowStatus / classificationStatus）与 11 个 `INCOMPLETE` 稳定原因代码（十项门禁失败全部映射显式原因，门禁集合必须恰好覆盖十个唯一 ID）；`schema/2.0/`（30 个 Schema，与类型同步，含状态关系约束、包内 Schema 自校验（缺任一副本或 `$id` 与文件名不符均拒绝）与正负向 Ajv 测试，`ajv` 移入运行时依赖）；随机 URL 未知 Mock KVM（`src/core/mock-kvm/`，登录走 SHA-256 摘要凭据链（服务端验证用户名与摘要），KVM 启动接口校验 CSRF 头（缺失/错误 403），WS 握手与会话严格校验签发的 sessionToken 与 viewerToken，页面脚本可在真实浏览器走通登录 → 控制台 → Viewer → Worker → WebSocket 全链，含 Electron 真实输入浏览器流程 E2E）；11 个完整度失败 Fixture 与正向（COMPLETE + KVM_REACHED + UNKNOWN）、legacy（`LEGACY_UNVERIFIED`）Fixture；独立样例包一致性验证器（负向测试 36 项：删除正文/删除截图/删除 Schema 副本/篡改 Schema `$id`/悬空引用/篡改哈希/状态不一致/Schema 违约/空 journal/重复路径/非法顶层条目/门禁 ID 非法/重复 replay ID/通道动态值集合不一致/正文指向另一现存正文等）；`examples/capture-pack-v2/` 样例包（完整度从观察事实与预验证派生，含双占位截图、crypto 调用、SSE/下载/WebRTC/WebTransport 消息契约；Replay 与 value-flow 只记录实际协议事实——启动请求依赖 CSRF 头、WS 握手携带 Cookie 与 token 查询参数，replay 通道显式声明动态值依赖（三方对齐 + ID 唯一 + 通道完整语义（含动态值集合相等）+ 正文路径与 catalog BodyRef 逐项一致），无编造关系）。**阶段 1 已落地**：`src/core/job-workspace/` 单作业磁盘工作区（单 active 作业；`workspace.json` 含 `workspaceId`/`exported`；读写/导出/清理核验实例身份；跨进程互斥为 OS 内核独占——Windows 版本化命名管道、Linux 抽象 socket、macOS `O_EXLOCK` 版本化锁文件，旧 unix socket 失败关闭不自动 unlink；`waitMs` 有限非负数；`current/.owner` 只创建不偷取，close 先释放 owner 再 closed；空/损坏 `current` 失败关闭保留证据；finalized-unexported 可恢复，仅 markExported 后允许清理；磁盘水位 5 GiB、`storageLimited` 粘性；标记原子写；finalize 不可变边界；JSONL 周期 fsync）。`src/core/body-store/` SHA-256 内容寻址流式正文（finish/abort 清理失败不释放租赁，可 abort 重试；零大小上限）。`src/core/export/` checksums 与流式 ZIP64（DOM `.html` 只走流式哈希，不整文件载入）。遗留 0.2.x 链路（内存型 recorder 的大小上限、JSZip 整包内存导出）按规范 §18 于阶段 2 采集器替换时一并删除，阶段 1 未改动 0.2.x 链路。未开始：协议无关采集器（阶段 2）、证据图与完整度引擎（阶段 3）、AI/Replay 生成器（阶段 4）、单屏新界面（阶段 5）、全量验收（阶段 6）。0.2.x 运行文档（architecture / capture-pack-spec / offline-field-guide）未改写。

**0.2.10 自动化门禁需要 typecheck / 单测 / 构建 / 生产采集 E2E。第二批现场语料可通过 `KVM_RECON_FIELD_COLLECTION_2` 运行 27 个 ZIP + 16 份 HAR 的只读离线回归；新构建仍应先做代表机验证，不要直接批量重采。**

已具备：无副作用探测与 TLS、手工登录采集、HTTP 重定向 hop/ExtraInfo/受控正文、WS 握手与有界帧采样（含 popup/OOPIF）、自动 KVM 画面截图、脱敏导出、YES / PARTIAL / NO 清单、暂停/多作业、登录后复验、现场铭牌、本地打开/对比 zip。每个导出包根目录有中文 `README.md`（阅读地图 + 适配前裁定），manifest 同时记录版本和 build ID。

安装包由 GitHub Actions 构建：macOS 为 ad-hoc 签名，Windows 无 Authenticode。

**下一步：** 先用 H3C HDM2、Dell iDRAC、HPE iLO、Huawei legacy 和真实 OpenBMC H5 代表机试采，当场核对版本/build ID、登录链、KVM 启动链、WS 帧和 viewer 截图；通过后再批量重采。三族真机闸门与付费签名按产品安排，见第 5、8 节。

**产品边界止于导出脱敏 Capture Pack。** 自动写 Adapter、机房内 AI、MITM、自动登录、完整视频解码不属于本项目。

## 4. 已完成能力（摘要）

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
