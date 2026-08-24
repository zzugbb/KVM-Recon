# KVM-Recon 离线现场使用说明

本文面向机房现场人员，说明如何在无公网环境中安装、采集、导出和交接 Capture Pack。

## 1. 安装包

构建人员在联网环境中提前生成安装包：

```bash
npm run package:mac
npm run package:win
```

产物输出到 `release/` 目录：

- macOS：`KVM-Recon-<version>-<arch>.dmg` 或 zip。
- Windows：`KVM-Recon Setup <version>.exe` 或 zip。

现场机器不需要公网。若无法安装或启动，请确认当前用户是否有应用安装、解压和写入导出目录的权限。

## 2. 现场采集步骤

1. 打开 KVM-Recon。
2. 输入目标 BMC 地址、端口和作业备注。
3. 点击“新建采集作业”。若上一作业窗口还开着，会被关掉。
4. 在弹出的采集窗口中访问 BMC。
5. 现场人员按需手工登录。
6. 点击“远程控制台 / HTML5 KVM”入口。若打开了新窗口，请把新窗口留在前台至少 10 秒。
7. 主窗口「采集进度」中「KVM WebSocket」变为已采集后再导出。点击操作会随进度刷新写入时间线，不必只靠「采集当前页面」。
8. 选择截图角色（登录页 / 登录后 / KVM 入口 / viewer / 异常），在对应画面点击“采集当前页面”。截图会进入导出包的 `page/screenshots/`。
9. 导出前可点“关闭采集窗口”：窗口关掉后作业数据仍保留，可继续导出。也可直接点“停止采集并导出”。
10. 导出前会显示离场结论和脱敏摘要，确认后再选择保存位置。导出成功后采集窗口会关闭。
11. 打开 `report.html` 或 `report.md`，确认离场结论。出机房后把 zip 交给工程师或 AI，并阅读 `artifacts/handover.md`。本工具不写 Adapter。

## 3. 离场判断

- `YES`：关键资料完整，可以离场后分析。
- `PARTIAL`：可以分析，但存在警告项，建议按报告补采。
- `NO`：缺少登录、KVM 入口、WebSocket 或脱敏检查失败，建议不要离场。

## 4. 导出包命名规则

默认导出文件名：

```text
KVM-Recon_<YYYYMMDD-HHmmss>_<BMC_HOST>_<kvmFamily>_<YES|PARTIAL|NO>.zip
```

示例：

```text
KVM-Recon_20260824-135500_10-0-0-10_ami-megarac_PARTIAL.zip
```

命名只保留时间、目标主机、协议族和离场结论，不包含账号、密码、Token、Cookie 等敏感信息。

## 5. 常见错误提示

- “无法连接目标 BMC”：检查 BMC 地址、端口、网线/VLAN、防火墙和本机网络。
- “当前权限不足”：将导出位置改到当前用户可写目录，或联系现场管理员授权。
- “证书策略阻止访问”：确认目标地址与采集配置一致，工具只允许目标 BMC 主机的自签证书例外。
- “Capture Pack 导出失败”：检查磁盘空间和导出目录写权限后重试。
- “脱敏检查未通过”：不要离场导出，重新采集并确认密码/Token 已被脱敏。

## 6. 样例 Capture Pack

仓库提供 `examples/sample-capture-pack/` 作为离线查看样例。该样例不是实际设备数据，仅用于说明目录结构、报告格式和交接内容。

## 7. 当前版本限制

- macOS 安装包默认未签名；Windows 包需在联网构建机执行 `npm run package:win`。本轮不打 Windows 包。
- 真实 BMC 验收见 `docs/development-plan.md` 第 13 节，当前按安排延后，不阻塞阶段 9。
- 日志只记录作业号、主机、就绪状态等非敏感字段。
- 同一时刻只保留一份可导出作业。关闭采集窗口后仍可导出；再点“新建采集作业”会丢掉未导出的上一份。
- 本工具不写 Adapter、不调用公网分析。出机房后把 Capture Pack 交给工程师或 AI，见包内 `artifacts/handover.md`。
