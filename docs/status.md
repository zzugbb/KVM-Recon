# 项目状态与维护范围

当前源码版本为 **0.3.3**，使用 **Capture Pack 2.0**。本文集中说明当前能力、验证基线与维护范围；数据契约见[采集与数据契约](v0.3-development-spec.md)。

## 产品定位

面向无公网机房的 macOS / Windows 桌面客户端，记录操作员从登录 BMC 到打开 HTML5 KVM 的浏览器可观察事实，并由用户手动导出采集包。包内原始资料不脱敏，供离场后工程师或获授权的 AI 研究适配。

设备说明是自由文本，不参与采集或完整度判断。产品范围止于导出 Capture Pack：不分类厂商或协议族，不自动登录、不做 MITM、不调用机房外 AI、不生成 Adapter，也不解码完整视频协议。

## 当前实现

| 能力 | 实现入口 | 行为 |
| --- | --- | --- |
| 单作业与恢复 | `src/core/job-workspace/` | 跨进程互斥、磁盘水位、收尾不可变；异常作业可手动导出或保留原始资料 |
| 原始正文 | `src/core/body-store/` | SHA-256 内容寻址、去重与流式写入 |
| 浏览器采集 | `src/core/collector/` | CDP / NetLog、HTTP / HAR、脚本 / Worker / WASM、浏览器状态、截图与实时通道；不可观察内容记缺口 |
| 证据与完整度 | `src/core/capture-pack-v2/` | 工作流状态、十项门禁、包内事实读取、Schema 与一致性校验 |
| 证据导航与 Replay | `src/core/collector/` | 依据实际事实生成候选请求链、值传播、缺失证据与回放计划，不输出协议分类 |
| 导出 | `src/core/export/` | 手动触发流式 ZIP64，校验引用和 checksum 后生成正式文件 |
| 桌面工作台 | `src/main/`、`src/renderer/` | 单屏单作业、当前状态与主操作、计数器、最近事实、高级诊断与崩溃恢复 |

Viewer 活动稳定后自动收尾，持续绘帧不重置稳定等待；收尾只停止采集，导出仍由用户触发并完成 ZIP 自校验。操作步骤与等待条件见[现场指南](field-guide.md)，完整规则见[数据契约 §7](v0.3-development-spec.md#7-采集生命周期)。

`COMPLETE` 只能与 `KVM_REACHED` 组合，说明定义范围内的观察证据通过门禁，不保证任何设备必然采集完整，也不保证仅凭一包能完成 Adapter。

## 系统架构与技术实现

```mermaid
flowchart TD
  UI[React / TypeScript 桌面工作台] -->|preload 受限 IPC| Main[Electron 主进程 / 作业编排]
  Main -->|管理窗口与会话| Browser[隔离 Chromium / page、popup、Worker]
  Operator[现场人员] -->|手工登录与打开 KVM| Browser
  Browser <-->|现场网络| BMC[BMC / HTML5 KVM]
  Browser -->|CDP / NetLog 与可观察内容| Collector[Collector / 原始事实采集]
  Main --> Probe[TLS / Redfish 补充探测]
  Probe --> Workspace[JobWorkspace / BodyStore 磁盘工作区]
  Collector --> Workspace
  Workspace --> Derive[证据索引 / AI 导航 / Replay 计划 / 完整度]
  Derive --> Export[流式 ZIP64 / Schema 与引用、checksum 校验]
  Main -->|用户手动触发| Export
  Export --> Pack[Capture Pack 2.0 / 离场后研究]
```

这是模块职责与数据关系图，观测、写入与派生会持续协作，不表示所有模块按图严格串行执行。`src/preload/index.ts` 通过 `contextBridge` 暴露作业操作；`src/main/capture/productionCaptureController.ts` 管理窗口、采集会话、收尾和手动导出；正文和事件保留在磁盘工作区，派生资料不能替代原始证据。

技术栈以仓库源码和 `package.json` 为准：Electron / Chromium 承载桌面与浏览器观测；React / TypeScript 实现工作台与类型契约；Node.js 处理文件与流；AJV 校验 JSON Schema；yazl / yauzl 写入并重新打开 ZIP 复核。展示站是独立静态页面，不属于这条运行链路。

设计取舍：先留事实再判断，以覆盖未知架构；内容寻址和流式落盘控制重复存储与内存占用；完整度与工作流进展分开，避免“看到了 Viewer”掩盖采集缺口；收尾与导出分开，让现场人员决定交接时机。相关实现入口见上表，数据与执行边界仍以[采集与数据契约](v0.3-development-spec.md)为准。

## 验证基线

本基线适用于已发布的 **0.3.3 正式安装版**，核验日期为 **2026-11-07**。本轮使用 GitHub Release 的 macOS arm64 DMG 安装、启动并完成 24 台真机采集与导出；采集包版本均为 `0.3.3`，buildId 均为 `6b2f6d8ec1e3d604`，与发布提交一致。复验命令见[贡献指南](../CONTRIBUTING.md)，打包与发布门禁见[发布指南](releasing.md)。

| 验证面 | 当前结论 | 覆盖范围 |
| --- | --- | --- |
| 修复源码与契约 | 通过 | 发布前 661 项测试、类型检查与构建通过；包括截图超时后迟到成功 / 失败不再写入已封存日志的回归 |
| 采集与导出自动化 | 通过 | 发布前 Electron E2E：启动、popup、生产采集、异常关窗、Mock 登录 / Viewer / 双向 WS、ZIP 自校验与动态值 Replay |
| 导航与收尾 | 通过 | 页内导航、快速跳转、XHR / fetch 响应后跳转、在途弹窗入口正文、明确取消证据关联及歧义保守处理；正式安装版 24 台全部自动收尾 |
| 正式安装版真机复采 | 通过 | 原不完整的 OpenBMC H5 KVM 14 台、Byosoft H5 KVM 4 台全部复采完整；另 6 台原完整设备复采也通过，共 24 份 `COMPLETE + KVM_REACHED`，十项门禁全部通过、已记录缺口为 0 |
| 实采包独立复核 | 通过 | 24 份包的 ZIP CRC、文件清单与 SHA-256、正文和脚本引用、通道帧索引、原始日志及已注册 Schema 校验通过；此前缺失的页面 / 脚本正文已取得，页面主动取消请求有明确浏览器证据，两份再次触发截图超时且超时记录已封存 |
| 现场语料回放 | 通过 | 现场第二批 16 份 HAR、原先完整的 7 台设备 HAR 均通过离线 HTTP 回放；不证明真实视频通道兼容 |
| 发布资料与公开展示 | 通过 | 版本、更新日志、下载入口、公开样例及展示数据一致；展示站 8 项测试及构建通过，19 份 Markdown 本地链接核对通过；本地根路径与 Pages 子路径的流程、两类案例、11 个文件浏览及移动端布局检查通过 |
| macOS arm64 正式安装包 | 通过 | 下载 DMG 的 SHA-256 与 GitHub 发布附件一致，镜像校验及镜像内应用 ad-hoc 签名通过；安装后 283 个文件及链接与原包一致，随包文档链接检查通过；用户完成安装、启动、真机采集和导出 |

**验收边界：**以上结论覆盖本轮 macOS arm64 安装版与 24 台设备 / 固件，不代表 Windows、macOS x64 或其他设备均已验收。采集包内容已独立核对，未逐台回看导出后界面。安装目录的 Finder 元数据会触发严格签名检查提示，但目录内文件与原包一致，原始安装包签名通过；本次核验未修改已安装应用。现场原包保留在仓库外，不进入公开样例。Pages 线上交互与历史视频未重新验收，素材范围见[视频说明](assets/README.md)。

其他设备 / 固件、复杂 popup / OOPIF / ServiceWorker 及真实 WebRTC / WebTransport 尚无同等级真机验证。WebTransport 只记录生命周期并报告 payload 缺口，通道目录存在不代表完整采集。

## 维护与交接

- 围绕可复现的采集、恢复、导出、契约及打包问题维护；变更同步受影响文档和验证范围。
- 旧 0.2.x 链路、协议分类、旧格式 Schema、多作业与包对比不在当前实现中；历史从 Git 标签查阅。
- 现场语料和 InManage 是仓库外资产，文档整理和回归不修改它们，也不提交其中的凭据。
- 下游从[采集包阅读指南](capture-pack-guide.md)进入证据，协议归属与 Adapter 实现由下游项目判断。
- 安装包构建、签名和发布见[发布指南](releasing.md)。

## 公开展示

独立静态站位于 `showcase/`，展示定位、能力、系统架构、内部工作流程与合成案例，不连接真实 BMC。完整样例与故障 Fixture 的素材边界见[展示说明](../showcase/README.md)。展示站不属于桌面安装包，不改变采集与导出契约。
