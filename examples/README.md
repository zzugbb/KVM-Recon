# Capture Pack 样例版本说明

`capture-pack-v2/` 是唯一维护的样例包，由固定 seed 的随机 URL Mock KVM 实际驱动生成。它不依赖任何厂商或协议族规则，仍可得到 **COMPLETE + KVM_REACHED**。生成器是 `src/core/capture-pack-v2/createSampleCapturePackV2.ts`，测试保证磁盘文件与生成器逐字节一致；开发期再生成：

```bash
KVM_RECON_WRITE_SAMPLE_PACK_V2=1 npx vitest run src/core/capture-pack-v2/createSampleCapturePackV2.test.ts
```

0.2.x 样例不再随当前源码维护；已发布版本可从相应 Git 标签查看。现场历史包仍保留在原来的资料目录，用于后续回归，不属于本仓库样例。
