# 文档导航

按任务选择入口：

- **了解项目与下载**：[中文首页](../README.md) / [English](../README.en.md) → [安装包](https://github.com/zzugbb/KVM-Recon/releases/tag/v0.3.0)。
- **现场采集**：[现场指南](field-guide.md) → 采集、收尾、手动导出与异常恢复。
- **离场后分析**：[采集包阅读指南](capture-pack-guide.md) → 包内 `00_START_HERE.md` → 完整度与证据索引。
- **开发与贡献**：[贡献指南](../CONTRIBUTING.md) → [开发规范](v0.3-development-spec.md) → [Schema](../schema/2.0/README.md) / [合成样例](../examples/README.md)。
- **核对项目状态**：[项目状态与验证基线](status.md)。
- **构建与发布**：[发布指南](releasing.md) → [版本记录](../CHANGELOG.md)。
- **反馈与安全**：[普通问题](https://github.com/zzugbb/KVM-Recon/issues/new/choose) / [安全说明](../SECURITY.md)；协作遵循[行为准则](../CODE_OF_CONDUCT.md)。

## 维护约定

当前文档适用于 KVM-Recon 0.3.0 / Capture Pack 2.0。已发布 0.2.x 的源码、旧格式说明与样例从对应 Git 标签查阅；版本记录中的旧行为只描述当时版本。现场历史资料保留在仓库外，不属于公开样例。

README 保持简短，稳定行为在专题文档维护；验证基线保留日期和实际范围，不把旧测试结果当作当前提交已验证。契约变更同步规范、类型、Schema、测试和样例；计划随安装包发布的功能、行为修复或安全变化写入 `[Unreleased]`；纯文档整理及不改变应用行为的依赖维护从 Git 历史查询，不要求逐项记入 CHANGELOG 或更新版本号。开发经过从 Git 历史查询，避免在多个文档重复维护修复流水账。

项目采用 [MIT License](../LICENSE)。
