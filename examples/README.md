# Capture Pack 样例版本说明

`capture-pack-v2/` 是 Capture Pack 2.0 的版本化样例（0.3.0 阶段 0 起提供）：由固定 seed 的随机 URL Mock KVM 实际驱动生成，状态为 **COMPLETE + KVM_REACHED + UNKNOWN**（协议未知但资料完整）。生成器是 `src/core/capture-pack-v2/createSampleCapturePackV2.ts`，测试保证磁盘文件与生成器逐字节一致；开发期再生成：

```bash
KVM_RECON_WRITE_SAMPLE_PACK_V2=1 npx vitest run src/core/capture-pack-v2/createSampleCapturePackV2.test.ts
```

`sample-capture-pack/` 是 KVM-Recon 0.2.x / Capture Pack 1.x 的当前样例，并由现有测试和样例生成器使用。它不是 0.3.0 的目标格式，现阶段不能删除或手工改写成 Capture Pack 2.0。

后续测试迁移后，目录将形成：

```text
examples/
  capture-pack-v2/
  sample-capture-pack/   # 1.x 样例；迁移测试后可改名 capture-pack-v1/
```

旧样例用于 1.x 导入兼容与 `LEGACY_UNVERIFIED` 回归；新样例用于 Capture Pack 2.0 Schema、AI 索引、完整度和 Replay 验收。
