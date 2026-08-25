# KVM-Recon 开发计划

本文说明产品边界和当前状态。已完成阶段不再逐条展开；现场看 `docs/offline-field-guide.md`，出机房后看**包内** `README.md`。

## 1. 目标

机房离线运行的 macOS / Windows 桌面客户端：采集 BMC HTML5 KVM 适配所需资料，导出脱敏 Capture Pack，并用离场清单判断资料是否够离开机房后做网关适配。

## 2. 全局约束

- 不依赖公网，不在现场调用外部分析服务。
- 不保存明文密码、Cookie 值、完整 KVM 视频码流。
- 不实现生产 KVM 网关，不实现浏览器插件。
- 厂商/型号只作铭牌，不能覆盖采集桶；`unknown-h5` / `not-h5` 不能当网关 registry 名。下游裁定见 `docs/kvm-family.md`。
- 未知族只导出资料包，不自动生成 Adapter。

## 3. 当前状态（2026-08-25）

**采集侧代码已收口。本文件不是待办清单，默认不再新增采集功能。**

已具备：探测与 TLS、手工登录采集、HTTP/WS（含 popup）、自动 KVM 画面截图、脱敏导出、YES / PARTIAL / NO 清单、暂停/多作业、登录后复验、现场铭牌、本地打开/对比 zip。每个导出包根目录有中文 `README.md`（阅读地图 + 适配前裁定）。

安装包由 GitHub Actions 构建：macOS 为 ad-hoc 签名，Windows 无 Authenticode。

**下一步不在本仓库写代码：** 用真实 YES Capture Pack 出机房后做网关适配实验；缺什么再决定是否补采集字段。三族真机闸门与付费签名按产品安排，见第 5、8 节。

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
- 运行时引入 ajv；为 README / yaml / HAR 再补项目内 Schema。

## 8. 开源治理与发布

已有 MIT 许可、CONTRIBUTING、CI（typecheck / 单测 / 构建 / Electron 烟测）、Build installers、Release 挂包。步骤见 `docs/releasing.md`。

不做：把证书写入仓库；对真实 BMC 做在线 e2e（没有公开 BMC，也不自动登录）。
