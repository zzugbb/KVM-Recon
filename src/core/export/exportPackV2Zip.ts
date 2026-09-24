/**
 * 流式 ZIP64 导出（规范 §9 / §10，阶段 1）。
 *
 * - 正式写出前先执行文件背书的 Capture Pack 2.0 一致性门禁：
 *   结构化文件（json/jsonl/md）载入内存；DOM 快照 / report.html 与
 *   大正文/截图/frames.bin 一样只带流式计算的 sha256 与字节数（验证器
 *   跳过其内容哈希），绝不把 HTML 或大正文整体载入内存。带悬空 BodyRef、
 *   非法 Schema 或状态矛盾的包在写 ZIP 之前即被拒绝。
 * - 逐工件流式写入 `<zipPath>.partial`（yazl），文本类扩展名按需
 *   DEFLATE，已压缩图片/媒体/二进制使用 STORE，避免无意义重压缩；
 *   不再把整包生成到内存 Uint8Array。
 * - 写完重开 .partial，逐条目流式重算 SHA-256，校验条目集合、大小与
 *   checksums 清单全部一致；fsync 后原子 rename 为正式文件名，并
 *   fsync 父目录（rename 的目录项落盘）。
 * - 任何失败删除 .partial 并抛错（导出不得留下未验证的正式 ZIP）。
 * - forceZip64 强制 ZIP64 记录（用于测试）；超限条目数/偏移 yazl
 *   自动切换 ZIP64。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open as openFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { WriteStream } from 'node:fs';

import yazl from 'yazl';
import yauzl from 'yauzl';
import type { Entry } from 'yauzl';

import { buildChecksumsManifest, sha256OfContent } from './checksumsManifest';
import {
  validatePackV2Consistency,
  isRawJournalPath,
  isLargeIndexPath,
  type PackV2ArtifactLike,
} from '../capture-pack-v2/packV2Consistency';
import { streamValidateRawJournals } from './streamingRawJournalChecks';
import { streamValidateLargeIndexes } from './streamingLargeIndexChecks';

export const PACK_V2_CHECKSUMS_PATH = 'checksums.sha256';

/** 按需压缩的文本类扩展名（其余一律 STORE，含无扩展名的正文与已压缩媒体）。 */
const DEFLATE_EXTENSIONS = new Set([
  'css',
  'csv',
  'har',
  'htm',
  'html',
  'js',
  'json',
  'jsonl',
  'map',
  'md',
  'mjs',
  'svg',
  'txt',
  'xml',
]);

/** 一致性门禁需要完整内容的结构化扩展名（验证器只解析这些文件的文本）。
 *  html 不在列：DOM 快照可能很大，只走流式 sha256/bytes 背书。 */
const STRUCTURED_EXTENSIONS = new Set(['json', 'jsonl', 'md', 'txt', 'xml']);

export function isStructuredPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot === -1 || dot < slash) return false;
  return STRUCTURED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase()) || path === PACK_V2_CHECKSUMS_PATH;
}

export function compressionForZipPath(path: string): 'deflate' | 'store' {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot === -1 || dot < slash) return 'store';
  return DEFLATE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase()) ? 'deflate' : 'store';
}

export interface ZipArtifactFileSource {
  kind: 'file';
  absolutePath: string;
}

export interface ZipArtifactBytesSource {
  kind: 'bytes';
  data: Uint8Array | string;
}

export type ZipArtifactSource = ZipArtifactFileSource | ZipArtifactBytesSource;

export interface ZipArtifact {
  /** ZIP 内路径（包内相对路径）。 */
  path: string;
  source: ZipArtifactSource;
}

export interface PackV2ZipExportInput {
  zipPath: string;
  /** 包内工件（不含 checksums.sha256，由导出器生成）。 */
  artifacts: ReadonlyArray<ZipArtifact>;
  forceZip64?: boolean;
}

export interface PackV2ZipExportResult {
  zipPath: string;
  zipBytes: number;
  entryCount: number;
  checksums: string;
}

export class PackV2ZipExportError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'PackV2ZipExportError';
  }
}

function validateArtifactPaths(artifacts: ReadonlyArray<ZipArtifact>): void {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    const { path } = artifact;
    if (typeof path !== 'string' || path.length === 0) {
      throw new PackV2ZipExportError(`非法 ZIP 内路径：${JSON.stringify(path)}`);
    }
    if (path.startsWith('/') || path.includes('\\') || path.includes('..')) {
      throw new PackV2ZipExportError(`ZIP 内路径必须是包内相对路径：${path}`);
    }
    if (path === PACK_V2_CHECKSUMS_PATH) {
      throw new PackV2ZipExportError(`checksums.sha256 由导出器生成，不得作为输入工件：${path}`);
    }
    if (seen.has(path)) {
      throw new PackV2ZipExportError(`ZIP 内路径重复：${path}`);
    }
    seen.add(path);
  }
}

async function sha256OfArtifact(artifact: ZipArtifact): Promise<string> {
  if (artifact.source.kind === 'bytes') {
    return sha256OfContent(artifact.source.data);
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(artifact.source.absolutePath), hash);
  return hash.digest('hex');
}

/**
 * 文件背书的一致性门禁工件：结构化文件带真实内容，二进制只带流式
 * 预计算的 sha256/bytes（验证器跳过其内容哈希，不整体载入内存）。
 * 无界 raw journal（CDP/NetLog/事务/实时/帧索引）与无上界索引文件
 * （resources/relations/replay 行索引、value-flow 图、storage 快照）
 * 在此一律哈希背书，内容校验由两条流式通道负责。
 */
async function buildConsistencyArtifact(
  artifact: ZipArtifact,
  sha256: string,
): Promise<PackV2ArtifactLike> {
  if (isRawJournalPath(artifact.path) || isLargeIndexPath(artifact.path)) {
    const bytes =
      artifact.source.kind === 'file'
        ? (await stat(artifact.source.absolutePath)).size
        : BufferSourceSize(artifact.source);
    return {
      path: artifact.path,
      content: new Uint8Array(0),
      sha256,
      bytes,
    };
  }
  if (artifact.source.kind === 'bytes') {
    return { path: artifact.path, content: artifact.source.data };
  }
  const stats = await stat(artifact.source.absolutePath);
  if (isStructuredPath(artifact.path)) {
    return { path: artifact.path, content: await readFile(artifact.source.absolutePath) };
  }
  return {
    path: artifact.path,
    content: new Uint8Array(0),
    sha256,
    bytes: stats.size,
  };
}

function BufferSourceSize(source: { data: Uint8Array | string }): number {
  return typeof source.data === 'string'
    ? Buffer.byteLength(source.data, 'utf8')
    : source.data.byteLength;
}

/** 正式写出前的 Capture Pack 2.0 一致性门禁（文件背书、流式、有界内存）。 */
async function assertPackV2Consistency(
  artifacts: ReadonlyArray<ZipArtifact>,
  checksums: string,
  hashes: ReadonlyMap<string, string>,
): Promise<void> {
  // 1. 无界 raw journal 流式校验（逐行/逐字符，不整文件载入），
  //    并收集其行内稳定 ID 注入元数据校验（knownIds 闭合同一语义）。
  const bytesByPath = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.source.kind === 'file') {
      bytesByPath.set(artifact.path, (await stat(artifact.source.absolutePath)).size);
    } else {
      bytesByPath.set(artifact.path, BufferSourceSize(artifact.source));
    }
  }
  const streamed = await streamValidateRawJournals({ artifacts, sha256ByPath: hashes, bytesByPath });

  // 1b. 无上界索引文件流式校验（逐行/逐元素，行数据注入内存侧闭包检查）。
  const streamedLarge = await streamValidateLargeIndexes(artifacts);

  // 2. 元数据/索引规模文件内存校验（raw journal 与大索引以哈希背书 + 委托选项）。
  const validationArtifacts: PackV2ArtifactLike[] = [];
  for (const artifact of artifacts) {
    validationArtifacts.push(await buildConsistencyArtifact(artifact, hashes.get(artifact.path)!));
  }
  validationArtifacts.push({
    path: PACK_V2_CHECKSUMS_PATH,
    content: checksums,
    sha256: sha256OfContent(checksums),
  });
  const check = validatePackV2Consistency(validationArtifacts, {
    skipRawJournalContentChecks: true,
    rawJournalIds: streamed.rawJournalIds,
    skipLargeIndexContentChecks: true,
    largeIndexFacts: streamedLarge.facts,
  });

  const problems = [...streamed.problems, ...streamedLarge.problems, ...check.problems];
  if (problems.length > 0) {
    const summary = problems
      .slice(0, 5)
      .map(problem => `${problem.code}: ${problem.detail}`)
      .join('；');
    const suffix = problems.length > 5 ? `（共 ${problems.length} 项）` : '';
    throw new PackV2ZipExportError(`包一致性验证未通过，拒绝导出：${summary}${suffix}`);
  }
}

/** fsync 一个文件（数据落盘后再 rename，崩溃后不留半截文件）。 */
async function fsyncFile(path: string): Promise<void> {
  const handle = await openFile(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** fsync 目录（rename 的目录项落盘）；平台不支持时静默跳过。 */
async function fsyncDir(path: string): Promise<void> {
  try {
    const handle = await openFile(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows 等平台不允许对目录执行 fsync：尽力而为。
  }
}

/**
 * 重新打开 ZIP 并逐条目流式校验：条目集合、未压缩大小与 SHA-256
 * 必须与期望清单完全一致（规范 §9：重新打开并验证清单、大小、引用
 * 和 SHA-256）。
 */
export async function verifyPackV2Zip(
  zipPath: string,
  expected: ReadonlyMap<string, string>,
): Promise<void> {
  const zipfile = await yauzl.openPromise(zipPath, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true,
  });
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry: Entry) => {
        void (async () => {
          const fileName = entry.fileName;
          const expectedSha = expected.get(fileName);
          if (!expectedSha) {
            throw new PackV2ZipExportError(`ZIP 中出现未声明的条目：${fileName}`);
          }
          const hash = createHash('sha256');
          let bytes = 0;
          const stream = await zipfile.openReadStreamPromise(entry);
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
          });
          await pipeline(stream, hash);
          if (bytes !== entry.uncompressedSize) {
            throw new PackV2ZipExportError(
              `ZIP 条目 ${fileName} 大小不一致：实际 ${bytes}，声明 ${entry.uncompressedSize}`,
            );
          }
          const sha256 = hash.digest('hex');
          if (sha256 !== expectedSha) {
            throw new PackV2ZipExportError(
              `ZIP 条目 ${fileName} SHA-256 不一致：实际 ${sha256}，清单 ${expectedSha}`,
            );
          }
          seen.add(fileName);
          zipfile.readEntry();
        })().catch(reject);
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
  for (const path of expected.keys()) {
    if (!seen.has(path)) {
      throw new PackV2ZipExportError(`ZIP 缺少声明的条目：${path}`);
    }
  }
}

/**
 * 流式导出：一致性门禁 → 生成 checksums → 写唯一临时文件 → 重开校验 →
 * fsync → 原子改名 → fsync 父目录。整个流程（含门禁阶段）都在
 * try/finally 内：任何失败都删除本流程创建的临时文件（唯一后缀，
 * 不会误删并发流程或既有文件）。
 */
export async function exportPackV2Zip(input: PackV2ZipExportInput): Promise<PackV2ZipExportResult> {
  validateArtifactPaths(input.artifacts);
  const partialPath = `${input.zipPath}.partial-${randomUUID()}`;

  try {
    const hashes = new Map<string, string>();
    for (const artifact of input.artifacts) {
      hashes.set(artifact.path, await sha256OfArtifact(artifact));
    }
    const checksums = buildChecksumsManifest([...hashes].map(([path, sha256]) => ({ path, sha256 })));
    hashes.set(PACK_V2_CHECKSUMS_PATH, sha256OfContent(checksums));

    // 正式写出前的一致性门禁（流式 raw journal + 元数据内存校验）：
    // 非法包不产生任何 ZIP 文件。
    await assertPackV2Consistency(input.artifacts, checksums, hashes);

    const zipfile = new yazl.ZipFile();
    try {
      for (const artifact of input.artifacts) {
        const compress = compressionForZipPath(artifact.path) === 'deflate';
        if (artifact.source.kind === 'file') {
          zipfile.addFile(artifact.source.absolutePath, artifact.path, { compress });
        } else {
          const buffer =
            typeof artifact.source.data === 'string'
              ? Buffer.from(artifact.source.data, 'utf8')
              : Buffer.from(artifact.source.data);
          zipfile.addBuffer(buffer, artifact.path, { compress });
        }
      }
      zipfile.addBuffer(Buffer.from(checksums, 'utf8'), PACK_V2_CHECKSUMS_PATH, { compress: true });
      zipfile.end({ forceZip64Format: input.forceZip64 === true, comment: '' });
    } catch (error) {
      // addFile/addBuffer 只做同步路径校验，失败时尚未写出任何数据。
      throw error;
    }

    const output: WriteStream = createWriteStream(partialPath);
    await pipeline(zipfile.outputStream, output);

    await verifyPackV2Zip(partialPath, hashes);
    await fsyncFile(partialPath);
    await rename(partialPath, input.zipPath);
    await fsyncDir(dirname(input.zipPath));
    const stats = await stat(input.zipPath);
    return {
      zipPath: input.zipPath,
      zipBytes: stats.size,
      entryCount: hashes.size,
      checksums,
    };
  } finally {
    await rm(partialPath, { force: true });
  }
}
