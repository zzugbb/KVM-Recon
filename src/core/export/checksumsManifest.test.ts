import { describe, expect, it } from 'vitest';

import { buildChecksumsManifest, parseChecksumsManifest, sha256OfContent } from './checksumsManifest';
import { createSampleCapturePackV2 } from '../capture-pack-v2/createSampleCapturePackV2';

describe('checksums 清单', () => {
  it('按路径排序，行格式 `<sha256>  <path>`，以换行结尾', () => {
    const content = buildChecksumsManifest([
      { path: 'b.json', sha256: 'b'.repeat(64) },
      { path: 'a.json', sha256: 'a'.repeat(64) },
    ]);
    expect(content).toBe(`${'a'.repeat(64)}  a.json\n${'b'.repeat(64)}  b.json\n`);
  });

  it('parse 往返一致', () => {
    const entries = [
      { path: 'raw/http/bodies/abc', sha256: 'c'.repeat(64) },
      { path: 'manifest.json', sha256: 'd'.repeat(64) },
    ];
    const parsed = parseChecksumsManifest(buildChecksumsManifest(entries));
    expect([...parsed.entries()].sort()).toEqual(
      entries.map(entry => [entry.path, entry.sha256] as [string, string]).sort(),
    );
  });

  it('非法行（哈希长度不符 / 缺少双空格分隔）被拒绝', () => {
    expect(() => parseChecksumsManifest(`short  a.json\n`)).toThrow();
    expect(() => parseChecksumsManifest(`${'a'.repeat(64)} a.json\n`)).toThrow();
    expect(() => parseChecksumsManifest('not-a-checksum-line')).toThrow();
  });

  it('sha256OfContent 对字符串与等价字节一致', () => {
    expect(sha256OfContent('hello')).toBe(sha256OfContent(new TextEncoder().encode('hello')));
  });

  it('与样例生成器的 checksums.sha256 逐字节一致（两处实现不得漂移）', async () => {
    const sample = await createSampleCapturePackV2();
    const artifactsWithoutChecksums = sample.artifacts.filter(
      artifact => artifact.path !== 'checksums.sha256',
    );
    const rebuilt = buildChecksumsManifest(
      artifactsWithoutChecksums.map(artifact => ({
        path: artifact.path,
        sha256: sha256OfContent(artifact.content),
      })),
    );
    const original = String(
      sample.artifacts.find(artifact => artifact.path === 'checksums.sha256')!.content,
    );
    expect(rebuilt).toBe(original);
  }, 30000);
});
