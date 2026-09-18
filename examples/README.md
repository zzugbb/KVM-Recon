# Capture Pack 样例版本说明

`sample-capture-pack/` 是 KVM-Recon 0.2.x / Capture Pack 1.x 的当前样例，并由现有测试和样例生成器使用。它不是 0.3.0 的目标格式，现阶段不能删除或手工改写成 Capture Pack 2.0。

0.3.0 阶段 0 应新增版本化样例目录，并在迁移测试后形成：

```text
examples/
  capture-pack-v1/
  capture-pack-v2/
```

旧样例用于 1.x 导入兼容与 `LEGACY_UNVERIFIED` 回归；新样例用于 Capture Pack 2.0 Schema、AI 索引、完整度和 Replay 验收。
