# KVM-Recon

Offline BMC/KVM Discovery & Compatibility Toolkit / KVM 离线探测与兼容性采集工具。

KVM-Recon 是一个面向机房现场的离线客户端工具，用于采集“登录 BMC → 打开 HTML5 KVM → 建立 KVM 相关 HTTP/WebSocket 链路”的事实资料，并导出脱敏 Capture Pack，供离开机房后进行 KVM 网关兼容性分析。

## 项目定位

- KVM-Recon 是离线采集工具，不是生产 KVM 网关。
- KVM-Recon 不直接提供用户远程控制台，不替代下游平台的 KVM 网关链路。
- KVM-Recon 不依赖公网，不在机房内调用外部分析服务。
- 现场人员可以辅助登录、点击菜单、打开 HTML5 KVM；工具负责记录适配所需资料。
- 导出的 Capture Pack 供离开机房、联网之后给工程师或 AI 做兼容分析；本工具不写 Adapter。

## 核心原则

- 主键使用 `kvmFamily`，不是厂商 Logo 或型号字符串。
- 已知协议族可附带 OEM Profile **草稿**（需离场审核）；未知协议族只导出资料包。本工具不生成 Adapter。
- 不保存明文密码到导出包。
- 不保存完整 KVM 视频码流，只保存 WebSocket 元数据和首包特征。
- 采集结果最终服务于 `ami-megarac`、`openbmc-h5`、`huawei-ibmc` 等 KVM 网关兼容开发。

## 目标用户流程

1. 在机房内安装并打开 KVM-Recon 桌面客户端。
2. 输入目标 BMC 地址、端口和作业备注。
3. 开始采集，工具执行基础探测与 TLS/指纹采集。
4. 内嵌浏览器打开 BMC，现场人员按需手工登录。
5. 现场人员点击 HTML5 KVM 入口，等待 viewer 页面和 WebSocket 建立。若 KVM 开在新窗口，把新窗口留在前台至少 10 秒。
6. 工具记录 HTTP、WebSocket、页面、截图、storage、TLS、指纹和 checklist。主窗口进度会自动收录点击摘要。
7. 可先关闭采集窗口再导出，或直接停止采集并导出。工具执行脱敏与离场验收检查。
8. 导出 Capture Pack。出机房联网后，把 zip 交给工程师或 AI 做适配；阅读包内 `artifacts/handover.md`。

## 文档

- `docs/development-plan.md`：分阶段开发计划、完成度、真机验收闸门（延后）与项目边界。本工具不写 Adapter。
- `docs/mvp-architecture.md`：MVP 技术架构与模块边界。
- `docs/capture-pack-spec.md`：Capture Pack 目录、数据契约与离场验收清单。
- `docs/offline-field-guide.md`：离线安装、现场采集、导出命名和错误提示。

## 当前进度

阶段 0–11 的代码与单测已闭环：离线采集、作业生命周期、出机房交接资料，以及登录后复验探测 / popup 窗口归属 / 再次导出。尚未做真实 BMC 验收，本轮不打 Windows 安装包。

本项目不会做自动写 Adapter、机房内在线分析、MITM 或自动登录。暂停采集、多作业、本地 Pack 对比等仍属采集工具，尚未做。

## 打包与交付

```bash
npm run package:mac
npm run package:win
```

打包产物输出到 `release/`。导出 Capture Pack 默认命名为：

```text
KVM-Recon_<YYYYMMDD-HHmmss>_<BMC_HOST>_<kvmFamily>_<YES|PARTIAL|NO>.zip
```

可离线查看的样例资料位于 `examples/sample-capture-pack/`。

## MVP 成功标准

代码与单测已覆盖（模拟数据）：

- 导出包不包含明文密码和完整视频流。
- 能标记 `kvmFamily` 候选、采集完整度和缺失项。
- 已知族可生成 OEM Profile 草稿（需离场审核）；未知族只出 Capture Pack 与备注。本工具不写 Adapter。

现场成功标准（真机闸门）：

- 在无公网环境中完成一次 BMC 登录到 HTML5 KVM 打开的采集。
- 对已知 AMI/华为/OpenBMC 族输出可用于后续网关适配的关键事实资料。
- 对未知族或非 H5 输出可带离现场的 Capture Pack，并明确下一步需要人工分析的项目。
