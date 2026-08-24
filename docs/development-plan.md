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

## 3. 阶段 0：项目初始化

目标：形成可启动的桌面客户端骨架。

任务：

- 初始化 Electron + TypeScript 项目。
- 增加 renderer 页面：新建采集、采集中、导出结果。
- 增加 main process 作业生命周期管理。
- 增加本地数据目录与临时作业目录。
- 增加基础日志，但默认不记录敏感值。

验收：

- macOS 本地可启动应用。
- Windows 可构建安装包或便携包。
- 能新建一次空采集作业并导出空 Capture Pack。

## 4. 阶段 1：Capture Pack Schema 与脱敏器

目标：先固定导出契约，避免后续采集逻辑散乱。

任务：

- 定义 `manifest.json`、`http/requests.jsonl`、`ws/frames.jsonl`、`page/timeline.jsonl`、`tls/certificate.json`、`checklist.json` schema。
- 实现字段级脱敏器。
- 实现 URL、Header、Cookie、JSON body、storage 的敏感字段识别。
- 实现导出前脱敏检查。

验收：

- 给定模拟 HTTP/WS/storage 数据，导出包不包含明文密码、Token、Cookie、CSRF。
- 脱敏检查失败时阻止默认导出。

## 5. 阶段 2：BMC 基础 Probe

目标：在不登录的情况下采集基础指纹。

任务：

- 实现 TLS 证书和协议探测。
- 实现 `/redfish/v1` 基础探测。
- 实现 AMI MegaRAC 路径指纹：`/api/randomtag`、`/api/session`、`/api/kvm/token`。
- 实现 OpenBMC H5 路径指纹：`/randomtag`、`/kvm/video`、`/redfish/v1/SessionService`。
- 实现华为 iBMC 路径指纹：`KvmService`、`SetKvmKey` 可达性。
- 输出 `family-signatures.json`。

验收：

- 对已知 AMI/华为/OpenBMC 样本能输出候选 `kvmFamily` 和证据。
- 对未知 BMC 输出 `unknown-h5` 或 `not-h5`，不默认误判为某个已知族。

## 6. 阶段 3：内嵌浏览器采集

目标：支持现场人员手工登录，并采集页面事实。

任务：

- 创建隔离 Chromium session。
- 支持受控忽略 BMC 自签证书。
- 打开 BMC 首页。
- 捕获导航、hash 变化、popup/new window。
- 捕获 localStorage/sessionStorage 变化。
- 支持关键截图。
- 记录 DOM 选择器候选。

验收：

- 现场人员可在采集窗口登录 BMC。
- popup/new window 不丢失，仍归属当前采集作业。
- Capture Pack 包含登录页、登录后页面、KVM 入口或 viewer 截图。

## 7. 阶段 4：HTTP 与 WebSocket 记录

目标：采集适配 KVM 网关所需的 HTTP/WS 事实。

任务：

- 通过 CDP 记录 HTTP 请求、响应、Header、状态码和 body 摘要。
- 生成 HAR 或结构化请求列表。
- 标记疑似登录、疑似 token、疑似 KVM 入口 API。
- 捕获 WebSocket 创建、URL、子协议、Header。
- 捕获 WebSocket frame 元数据、方向、时间戳、长度、前 N 字节 hex、是否二进制。
- 对持续视频帧做采样和计数，不保存完整流。

验收：

- AMI 场景能看到 `/api/kvm/token` 和 `/kvm` WS 元数据。
- 华为场景能看到 `KvmService`、`SetKvmKey`、`/websocket` 元数据。
- OpenBMC 场景能看到 Redfish Session 和 `/kvm/video` 元数据。

## 8. 阶段 5：离场验收清单

目标：导出前告诉现场人员资料是否足够。

任务：

- 实现基础连接、BMC 指纹、登录链路、KVM 入口、HTTP 关键 API、WebSocket、页面截图、脱敏检查等检查项。
- 每项输出 `pass/fail/unknown/missing/not_applicable/needs_user_action`。
- 每项输出 `blocking/warning/info` 影响级别。
- 生成 `checklist.json`、`report.md`、`report.html`。
- 导出前给出 `YES/PARTIAL/NO` 离场结论。

验收：

- 未捕获 KVM WebSocket 时给出 `NO` 或 blocking 提示。
- 缺截图但 HTTP/WS 完整时给出 `PARTIAL`。
- 关键资料完整且脱敏通过时给出 `YES`。

## 9. 阶段 6：已知族 Profile 草稿

目标：对已知协议族生成可人工审核的适配草稿。

任务：

- AMI：提取 Cookie 名、CSRF 名、token API、WS 路径、子协议、权限字段、登录能力指纹。
- 华为：提取 Redfish 登录、KvmService、SetKvmKey、KVM 端口、加密开关、WS 魔数。
- OpenBMC：提取 SessionService、UNIQUEID、X-Auth-Token、`/kvm/video`、WS 子协议。
- 输出 `artifacts/oem-profile.yaml`。
- 对未知族不输出 profile，只输出分析备注。

验收：

- 已知族 profile 草稿字段能映射到下游 KVM 网关 Adapter/Profile 开发所需事实。
- 未知族不会生成空壳 Adapter。

## 10. 阶段 7：打包与现场交付

目标：让非开发人员可安装、采集、导出。

任务：

- macOS 打包。
- Windows 打包。
- 增加离线使用说明。
- 增加导出包命名规则。
- 增加采集失败时的可读错误提示。
- 增加样例 Capture Pack。

验收：

- 无公网环境中可安装和启动。
- 没有管理员权限时能给出明确限制提示。
- 采集完成后能导出 zip，并可在另一台电脑离线打开报告。

## 11. 第一版 MVP 范围建议

第一版只做以下闭环：

- Electron 桌面客户端。
- 手工登录采集。
- 基础 probe。
- HTTP/WS 元数据记录。
- 截图和 storage。
- 脱敏导出。
- 离场验收报告。

暂不做：

- 自动登录脚本生成。
- 完整 MITM。
- 在线分析服务。
- 自动写下游网关 Adapter。
- 完整视频解码。

## 12. 与下游适配开发的交接

离场后，工程师或离线分析流程读取 Capture Pack，并结合目标网关代码完成：

- 判断 `kvmFamily`。
- 判断是 OEM Profile 还是新 Adapter。
- 补充或修正网关注册、OEM Profile、OpenBMC/Huawei Adapter。
- 根据 `checklist.json` 判断是否需要二次进场补采。
- 将成功适配经验回写到 KVM-Recon 签名库和 checklist 规则。
