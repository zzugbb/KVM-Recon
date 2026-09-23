import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yazl from 'yazl';
import yauzl from 'yauzl';
import type { Entry } from 'yauzl';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PACK_V2_CHECKSUMS_PATH,
  PackV2ZipExportError,
  compressionForZipPath,
  exportPackV2Zip,
  isStructuredPath,
  verifyPackV2Zip,
  type ZipArtifact,
} from './exportPackV2Zip';
import { parseChecksumsManifest, sha256OfContent } from './checksumsManifest';
import { createSampleCapturePackV2 } from '../capture-pack-v2/createSampleCapturePackV2';
import { validatePackV2Consistency } from '../capture-pack-v2/packV2Consistency';

/**
 * 阶段 1 流式 ZIP64 导出测试（规范 §9）。一致性门禁无条件生效：
 * 机制类测试使用完整合法的样例包；verifyPackV2Zip 单元测试用 yazl
 * 直写 ZIP（不经导出器）；门禁负例验证悬空引用 / 损坏状态包在写 ZIP
 * 之前即被拒绝，不产生任何文件。
 */

const tempDirs: string[] = [];

async function newTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kvm-recon-export-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** 样例包（去掉自带 checksums，由导出器生成）→ bytes 源工件。 */
async function sampleBytesArtifacts(): Promise<ZipArtifact[]> {
  const sample = await createSampleCapturePackV2();
  return sample.artifacts
    .filter(artifact => artifact.path !== PACK_V2_CHECKSUMS_PATH)
    .map(artifact => ({
      path: artifact.path,
      source: { kind: 'bytes' as const, data: artifact.content },
    }));
}

/** 样例包写到磁盘 → file 源工件（流式导出，不整体载入内存）。 */
async function sampleFileArtifacts(): Promise<{ dir: string; artifacts: ZipArtifact[] }> {
  const dir = await newTempDir();
  const sample = await createSampleCapturePackV2();
  const artifacts: ZipArtifact[] = [];
  for (const artifact of sample.artifacts) {
    if (artifact.path === PACK_V2_CHECKSUMS_PATH) continue;
    const absolutePath = join(dir, artifact.path);
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, artifact.content);
    artifacts.push({ path: artifact.path, source: { kind: 'file', absolutePath } });
  }
  return { dir, artifacts };
}

async function readZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
  const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false });
  const entries = new Map<string, Buffer>();
  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry: Entry) => {
        void (async () => {
          const chunks: Buffer[] = [];
          const stream = await zipfile.openReadStreamPromise(entry);
          for await (const chunk of stream) chunks.push(chunk as Buffer);
          entries.set(entry.fileName, Buffer.concat(chunks));
          zipfile.readEntry();
        })().catch(reject);
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
  return entries;
}

async function zipCompressionMethods(zipPath: string): Promise<Map<string, number>> {
  const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false });
  const methods = new Map<string, number>();
  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry: Entry) => {
        methods.set(entry.fileName, entry.compressionMethod);
        zipfile.readEntry();
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
  return methods;
}

/** 测试内直写 ZIP（不经导出器，用于 verifyPackV2Zip 的单元隔离）。 */
async function writeTestZip(
  zipPath: string,
  entries: ReadonlyArray<{ path: string; data: Buffer | string }>,
): Promise<void> {
  const zipfile = new yazl.ZipFile();
  for (const entry of entries) zipfile.addBuffer(Buffer.from(entry.data), entry.path);
  zipfile.end({ forceZip64Format: false, comment: '' });
  await pipeline(zipfile.outputStream, createWriteStream(zipPath));
}

describe('isStructuredPath', () => {
  it('json/jsonl/md 需要载入内容；DOM 快照 html 只走流式哈希', () => {
    expect(isStructuredPath('manifest.json')).toBe(true);
    expect(isStructuredPath('catalog/resources.jsonl')).toBe(true);
    expect(isStructuredPath('ai/summary.md')).toBe(true);
    expect(isStructuredPath('report.html')).toBe(false);
    expect(isStructuredPath('raw/browser/dom-snapshots/0001-login.html')).toBe(false);
    expect(isStructuredPath('raw/http/bodies/abc')).toBe(false);
  });
});

describe('compressionForZipPath', () => {
  it('文本类扩展名 DEFLATE，图片/无扩展名 STORE', () => {
    expect(compressionForZipPath('manifest.json')).toBe('deflate');
    expect(compressionForZipPath('raw/http/transactions.jsonl')).toBe('deflate');
    expect(compressionForZipPath('report.html')).toBe('deflate');
    expect(compressionForZipPath('raw/browser/screenshots/0001-viewer-initial.png')).toBe('store');
    expect(compressionForZipPath('raw/http/bodies/abc123')).toBe('store');
    expect(compressionForZipPath('raw/websocket/ws-0001/frames.bin')).toBe('store');
    expect(compressionForZipPath('dir.d/edge')).toBe('store');
  });
});

describe('exportPackV2Zip（流式导出）', () => {
  it('bytes 源导出样例包：原子改名、.partial 清理、checksums 由导出器生成', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const artifacts = await sampleBytesArtifacts();
    const result = await exportPackV2Zip({ zipPath, artifacts });
    expect(result.entryCount).toBe(artifacts.length + 1);
    expect(result.zipBytes).toBeGreaterThan(0);
    await expect(readFile(`${zipPath}.partial`)).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await readZipEntries(zipPath);
    expect(entries.size).toBe(artifacts.length + 1);
    const parsed = parseChecksumsManifest(entries.get(PACK_V2_CHECKSUMS_PATH)!.toString('utf8'));
    expect(parsed.get('manifest.json')).toBe(
      sha256OfContent(entries.get('manifest.json')!.toString('utf8')),
    );
  }, 60000);

  it('file 源导出样例包：从磁盘流式读取，读回与样例逐字节一致', async () => {
    const { dir, artifacts } = await sampleFileArtifacts();
    const zipPath = join(dir, 'pack.zip');
    await exportPackV2Zip({ zipPath, artifacts });
    const entries = await readZipEntries(zipPath);
    expect(entries.size).toBe(artifacts.length + 1);
    for (const artifact of artifacts) {
      if (artifact.source.kind !== 'file') continue;
      const expected = await readFile(artifact.source.absolutePath);
      expect(entries.get(artifact.path)).toEqual(expected);
    }
  }, 60000);

  it('压缩选择：json DEFLATE（method 8）、png/无扩展名 STORE（method 0）', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    await exportPackV2Zip({ zipPath, artifacts: await sampleBytesArtifacts() });
    const methods = await zipCompressionMethods(zipPath);
    expect(methods.get('ai/index.json')).toBe(8);
    expect(methods.get('raw/browser/screenshots/0002-stop.png')).toBe(0);
    const bodyPath = [...methods.keys()].find(path =>
      /^raw\/http\/bodies\/[0-9a-f]{64}$/.test(path),
    );
    expect(bodyPath).toBeDefined();
    expect(methods.get(bodyPath!)).toBe(0);
  }, 60000);

  it('forceZip64 模式导出后仍可读回校验（ZIP64 记录可解析）', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const result = await exportPackV2Zip({
      zipPath,
      artifacts: await sampleBytesArtifacts(),
      forceZip64: true,
    });
    expect(result.entryCount).toBeGreaterThan(1);
    const entries = await readZipEntries(zipPath);
    const manifestContent = entries.get(PACK_V2_CHECKSUMS_PATH)!.toString('utf8');
    const expected = parseChecksumsManifest(manifestContent);
    expected.set(PACK_V2_CHECKSUMS_PATH, sha256OfContent(manifestContent));
    await verifyPackV2Zip(zipPath, expected);
  }, 60000);

  it('输入校验：重复路径 / checksums 工件 / 路径逃逸被拒绝且不产生任何文件', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    await expect(
      exportPackV2Zip({
        zipPath,
        artifacts: [
          { path: 'a.json', source: { kind: 'bytes', data: '1' } },
          { path: 'a.json', source: { kind: 'bytes', data: '2' } },
        ],
      }),
    ).rejects.toMatchObject({ name: 'PackV2ZipExportError' });
    await expect(
      exportPackV2Zip({
        zipPath,
        artifacts: [{ path: 'checksums.sha256', source: { kind: 'bytes', data: '' } }],
      }),
    ).rejects.toMatchObject({ name: 'PackV2ZipExportError' });
    await expect(
      exportPackV2Zip({
        zipPath,
        artifacts: [{ path: '../escape.json', source: { kind: 'bytes', data: '' } }],
      }),
    ).rejects.toMatchObject({ name: 'PackV2ZipExportError' });
    await expect(
      exportPackV2Zip({
        zipPath,
        artifacts: [{ path: '/abs.json', source: { kind: 'bytes', data: '' } }],
      }),
    ).rejects.toMatchObject({ name: 'PackV2ZipExportError' });
    await expect(readFile(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${zipPath}.partial`)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);

  it('导出失败时清理 .partial（rename 目标为已存在目录）', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    await mkdir(zipPath); // rename 到目录会失败
    await expect(
      exportPackV2Zip({ zipPath, artifacts: await sampleBytesArtifacts() }),
    ).rejects.toThrow();
    await expect(readFile(`${zipPath}.partial`)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60000);
});

describe('一致性门禁（正式写出前的包语义验证）', () => {
  it('悬空 BodyRef（删除被引用正文）→ 拒绝导出且不产生任何文件', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const sample = await createSampleCapturePackV2();
    const victim = sample.artifacts.find(artifact => artifact.path.startsWith('raw/http/bodies/'))!;
    const broken = sample.artifacts
      .filter(artifact => artifact.path !== PACK_V2_CHECKSUMS_PATH && artifact.path !== victim.path)
      .map(artifact => ({
        path: artifact.path,
        source: { kind: 'bytes' as const, data: artifact.content },
      }));
    await expect(exportPackV2Zip({ zipPath, artifacts: broken })).rejects.toThrow(
      /一致性验证未通过/,
    );
    await expect(readFile(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${zipPath}.partial`)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60000);

  it('raw journal 损坏（CDP seq 不递增）→ 流式门禁拒绝导出', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const sample = await createSampleCapturePackV2();
    const broken = sample.artifacts
      .filter(artifact => artifact.path !== PACK_V2_CHECKSUMS_PATH)
      .map(artifact => {
        if (artifact.path !== 'raw/cdp/events.jsonl') {
          return { path: artifact.path, source: { kind: 'bytes' as const, data: artifact.content } };
        }
        const lines = String(artifact.content).trimEnd().split('\n');
        return {
          path: artifact.path,
          source: { kind: 'bytes' as const, data: `${[...lines, lines[lines.length - 1]].join('\n')}\n` },
        };
      });
    await expect(exportPackV2Zip({ zipPath, artifacts: broken })).rejects.toThrow(
      /一致性验证未通过/,
    );
    await expect(readFile(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60000);

  it('manifest 损坏（非法 JSON）→ 拒绝导出', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const sample = await createSampleCapturePackV2();
    const broken = sample.artifacts
      .filter(artifact => artifact.path !== PACK_V2_CHECKSUMS_PATH)
      .map(artifact =>
        artifact.path === 'manifest.json'
          ? { path: artifact.path, source: { kind: 'bytes' as const, data: '{not-json' } }
          : { path: artifact.path, source: { kind: 'bytes' as const, data: artifact.content } },
      );
    await expect(exportPackV2Zip({ zipPath, artifacts: broken })).rejects.toThrow(
      /一致性验证未通过/,
    );
    await expect(readFile(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60000);
});

  it('空 WS 帧索引 + 非空 frames.bin → 拒绝导出（不允许清空索引仍导出 COMPLETE）', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const sample = await createSampleCapturePackV2();
    const framesIndexPath = 'raw/websocket/ws-0001/frames.index.jsonl';
    const framesIndex = sample.artifacts.find(a => a.path === framesIndexPath)!;
    // 帧计数在通道元数据里改为 0/0 也不许通过：总长必须无条件比较。
    const channels = sample.artifacts.find(a => a.path === 'catalog/channels.json')!;
    const parsedChannels = JSON.parse(String(channels.content));
    parsedChannels.channels[0].frameCounts = { up: 0, down: 0 };
    const broken = sample.artifacts
      .filter(artifact => artifact.path !== PACK_V2_CHECKSUMS_PATH)
      .map(artifact => {
        if (artifact.path === framesIndexPath) {
          return { path: artifact.path, source: { kind: 'bytes' as const, data: '' } };
        }
        if (artifact.path === 'catalog/channels.json') {
          return {
            path: artifact.path,
            source: { kind: 'bytes' as const, data: `${JSON.stringify(parsedChannels, null, 2)}\n` },
          };
        }
        return { path: artifact.path, source: { kind: 'bytes' as const, data: artifact.content } };
      });
    await expect(exportPackV2Zip({ zipPath, artifacts: broken })).rejects.toThrow(
      /一致性验证未通过/,
    );
    await expect(readFile(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60000);

  it('NetLog 文件源缺失 → 导出失败且不崩溃（pipeline 错误转正常失败）', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const sample = await createSampleCapturePackV2();
    const broken = sample.artifacts
      .filter(artifact => artifact.path !== PACK_V2_CHECKSUMS_PATH)
      .map(artifact =>
        artifact.path === 'raw/netlog/netlog.json'
          ? {
              path: artifact.path,
              source: { kind: 'file' as const, absolutePath: join(dir, 'missing-netlog.json') },
            }
          : { path: artifact.path, source: { kind: 'bytes' as const, data: artifact.content } },
      );
    // 缺失文件在哈希阶段以 ENOENT 正常失败（进程不崩溃），不产生任何产物。
    await expect(exportPackV2Zip({ zipPath, artifacts: broken })).rejects.toThrow();
    await expect(readFile(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${zipPath}.partial-`)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60000);

describe('verifyPackV2Zip（重开校验）', () => {
  it('期望清单多一条 → 报缺少声明的条目', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    await writeTestZip(zipPath, [{ path: 'a.json', data: 'x' }]);
    const expected = new Map([['a.json', sha256OfContent('x')]]);
    expected.set('missing.json', '0'.repeat(64));
    await expect(verifyPackV2Zip(zipPath, expected)).rejects.toThrow('缺少声明的条目');
  }, 30000);

  it('期望 SHA 不符 → 报 SHA-256 不一致', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    await writeTestZip(zipPath, [{ path: 'a.json', data: 'x' }]);
    await expect(
      verifyPackV2Zip(zipPath, new Map([['a.json', '0'.repeat(64)]])),
    ).rejects.toThrow('SHA-256 不一致');
  }, 30000);

  it('ZIP 中出现未声明条目 → 报未声明的条目', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    await writeTestZip(zipPath, [{ path: 'a.json', data: 'x' }]);
    await expect(verifyPackV2Zip(zipPath, new Map())).rejects.toThrow('未声明的条目');
  }, 30000);

  it('数据被篡改 → 校验失败', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    await writeTestZip(zipPath, [{ path: 'raw/http/bodies/abc', data: 'x'.repeat(64) }]);
    // 精确定位第一个条目（STORE，无压缩）的数据区：本地文件头 30 字节 +
    // 文件名 + 扩展字段，然后篡改数据区中间一个字节。
    const raw = await readFile(zipPath);
    const fileNameLength = raw.readUInt16LE(26);
    const extraFieldLength = raw.readUInt16LE(28);
    const dataStart = 30 + fileNameLength + extraFieldLength;
    raw[dataStart + 32] ^= 0xff;
    const corrupted = join(dir, 'corrupted.zip');
    await writeFile(corrupted, raw);
    await expect(
      verifyPackV2Zip(corrupted, new Map([['raw/http/bodies/abc', sha256OfContent('x'.repeat(64))]])),
    ).rejects.toThrow();
  }, 30000);
});

describe('样例包导出集成（阶段 1 验收）', () => {
  it('样例包导出 → 读回 → checksums 与样例一致 → 通过独立一致性验证器', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const sample = await createSampleCapturePackV2();
    const artifacts = await sampleBytesArtifacts();
    const result = await exportPackV2Zip({ zipPath, artifacts });
    const entries = await readZipEntries(zipPath);
    expect(entries.size).toBe(sample.artifacts.length);
    // 导出器生成的 checksums 与样例自带清单逐字节一致。
    const sampleChecksums = String(
      sample.artifacts.find(artifact => artifact.path === PACK_V2_CHECKSUMS_PATH)!.content,
    );
    expect(entries.get(PACK_V2_CHECKSUMS_PATH)!.toString('utf8')).toBe(sampleChecksums);
    expect(result.checksums).toBe(sampleChecksums);
    // 读回工件原样通过独立一致性验证器（磁盘往返无损）。
    const readBack = [...entries].map(([path, buffer]) => ({ path, content: buffer }));
    const check = validatePackV2Consistency(readBack);
    expect(check.problems).toEqual([]);
    expect(check.valid).toBe(true);
  }, 60000);

  it('样例包以 ZIP64 强制模式导出 → 读回校验同样通过', async () => {
    const dir = await newTempDir();
    const zipPath = join(dir, 'pack.zip');
    const sample = await createSampleCapturePackV2();
    await exportPackV2Zip({ zipPath, artifacts: await sampleBytesArtifacts(), forceZip64: true });
    const entries = await readZipEntries(zipPath);
    expect(entries.size).toBe(sample.artifacts.length);
    const readBack = [...entries].map(([path, buffer]) => ({ path, content: buffer }));
    const check = validatePackV2Consistency(readBack);
    expect(check.valid).toBe(true);
  }, 60000);
});
