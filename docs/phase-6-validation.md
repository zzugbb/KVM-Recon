# 阶段 6 验证记录

状态：**进行中，不能据此发布 0.3.0**。本记录只陈述本机已执行的验证；历史包和现场 HAR 均只读，未修改仓库外资料，也未把 1.x 包冒充 2.0 包。

## 已验证（2026-09-24）

| 范围 | 结果 | 边界 |
| --- | --- | --- |
| 类型检查、单测、构建 | `npm run typecheck`、`npm test`、`npm run build` 通过 | 单测含纯函数和故障注入，不等于现场设备测试 |
| Electron E2E | `npm run test:e2e` 通过：浏览器 Mock 登录/Viewer/WS、采集导出、动态值新会话 Replay | Mock 不代表所有 BMC 固件 |
| 第二批现场 HAR | `KVM_RECON_FIELD_HAR_ALL=1` 全量 16/16 离线 HTTP 回放通过 | 同 method/path 只取首条；101 WS 握手不能用 HTTP fetch 回放，已单独计数且未声称验证其帧；304 缓存正文在本地以 200 重放；不执行真实 BMC 登录 |
| 历史 ZIP | 第一批现场 28、第二批现场 27、两组家庭临时包各 4，共 63 个：`unzip -tqq`、manifest/HAR/HTTP JSONL 解析通过；每包 HAR 事务数与 HTTP JSONL 行数相等 | 只验证旧资料可读和内部计数；不导入成 2.0，也不能证明新采集器覆盖旧资料 |
| macOS 产物 | x64/arm64 DMG 与 ZIP 均生成，DMG 校验、ZIP 解压测试、应用签名校验通过；arm64 已打包应用在隔离用户目录完成启动烟测 | 未在断网现场安装；ad-hoc 签名且未公证 |
| 同一家庭设备实测 | 当前采集器从登录到 Viewer 手动导出 2.0 包；308 个条目逐项 SHA-256 校验通过，包内一致性验证器零问题；`COMPLETE + KVM_REACHED`、十门禁全过、67 条 WS 帧。与该设备旧版 YES 包对照：旧包 22 份 JS 源码全部按 SHA-256 命中新包；旧 HAR 的 66 个不同 method/path 全部在新资源索引中出现 | 用户确认 `No Signal` 就是该设备正常显示的 KVM 画面，截图、连接与现场一致，本设备采集验收通过。同一设备两次会话的动态正文不能宣称逐字节相同；本产品也不负责解码视频协议 |

现场 HAR 默认 E2E 仍只跑三份代表文件。全量模式需显式设置 `KVM_RECON_FIELD_COLLECTION_2` 与 `KVM_RECON_FIELD_HAR_ALL=1`，仅供持有现场资料的本地验收使用。所有 1.x 语料保持在仓库外。

## 待完成验收

- Windows runner 生成安装包，并在 Windows 上验证安装、启动、手动导出和校验；本机 macOS 构建不覆盖它。
- macOS/Windows 断网安装与现场 BMC 访问、磁盘不足/进程崩溃后的人工恢复流程。单测和 Mock 故障注入已覆盖部分规则，但不能替代现场操作。

其他厂商/固件、复杂 popup/OOPIF/ServiceWorker 及真实 WebRTC/WebTransport 未取得同等级真机证据，属于已记录的覆盖边界，不额外要求这台 `No Signal` 设备重采。对 Chromium 不可观察的资料仍须显式记录缺口，不能承诺所有设备必然 COMPLETE。

验收依据为 [开发规范 §20](v0.3-development-spec.md)。安装与断网验收完成前，阶段 6 保持进行中；不推断适配任何具体协议族，也不改 InManage 或历史资料。
