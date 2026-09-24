/**
 * 单作业磁盘工作区（规范 §4.2 / §9）。
 *
 * - 应用同一时刻只允许一个 active 作业；start 前先做磁盘水位检查，
 *   余量不足（默认至少为系统盘预留 5 GiB）直接拒绝启动。
 * - 作业写入独立临时目录，目录内 `workspace.json` 是恢复标记，含持久
 *   `workspaceId`（实例身份）与 `exported`（ZIP 自校验成功后才为 true）。
 *   `current/` 可被后继作业复用，因此每个对象在读写/导出/清理前核验
 *   workspaceId，旧对象不得操作或删除后继作业。
 * - recoverActiveJobWorkspace 恢复 active，以及已收尾但尚未导出的
 *   finalized-unexported 作业（只读）；已 exported 的作业返回 null。
 *   标记更新全部走「写 .tmp 临时文件 → fsync → rename」的原子路径。
 * - storageLimited 是持久粘性状态：首次触发即原子写入标记，崩溃恢复
 *   后仍为 true（映射 INCOMPLETE_STORAGE_LIMIT）。
 * - 单作业互斥：跨进程用 OS 内核独占锁（见 processMutex.ts）；start/
 *   recover 立即失败，finalize/close/cleanup/markExported 等待持有者
 *   释放。`current/.owner` 是只创建不偷取的所有权租赁；close 必须先
 *   成功释放 owner 再提交 closed，失败可重试。发布前若 `current` 已
 *   存在（含空目录）按标记处理：缺 marker 视为未知状态失败关闭，
 *   绝不让 POSIX rename 覆盖空目录。未导出的 finalized 不得删除。
 * - finalize 是不可变边界：进入 `finalizing` 后拒绝一切新写入并等待
 *   在途写入器全部落定，再原子落盘 finalized + exported:false；
 *   仅 markExported（ZIP 成功校验后）允许后续 start 清理或 cleanup。
 *
 * 包工件与工作区内部文件共用目录：`workspace.json`、`.owner`、`.tmp/`
 * 全部保留，writeArtifact / appendJsonl / BodyStore namespace 统一拒绝。
 * artifactPaths() 只返回包内工件。
 */

import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

import { acquireProcessMutex, ProcessMutexHeldError } from './processMutex';


export const DEFAULT_DISK_SAFETY_MARGIN_BYTES = 5 * 1024 * 1024 * 1024;

/** 每 128 次追加做一次 fsync（规范 §9“重要元数据定期 fsync 或安全刷新”）。 */
const FSYNC_EVERY_APPENDS = 128;

export const WORKSPACE_MARKER_FILE = 'workspace.json';
export const WORKSPACE_TMP_DIR = '.tmp';
/** 单作业规范目录名（staging 内初始化后 rename 发布为 current）。 */
export const WORKSPACE_JOB_DIR = 'current';
/** 作业所有权租赁（current 内，wx 创建，不自动偷取；app 单实例锁保证后可用 reset 显式接管）。 */
export const WORKSPACE_OWNER_FILE = '.owner';
/** 初始化 staging 目录前缀（唯一命名，原子 rename 发布前永不公开）。 */
const WORKSPACE_STAGING_PREFIX = 'staging-';

export type JobWorkspaceState = 'active' | 'finalizing' | 'finalized';

export interface DiskSpaceSnapshot {
  freeBytes: number;
  marginBytes: number;
  /** freeBytes >= marginBytes */
  ok: boolean;
}

export interface StatFsLike {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

export type StatFsProbe = (path: string) => Promise<StatFsLike>;

/** 开始前磁盘余量不足（规范 §9：开始前空间不足则不启动）。 */
export class JobWorkspaceDiskSpaceError extends Error {
  constructor(
    readonly snapshot: DiskSpaceSnapshot,
  ) {
    super(
      `磁盘安全余量不足：可用 ${snapshot.freeBytes} 字节，需要预留 ${snapshot.marginBytes} 字节`,
    );
    this.name = 'JobWorkspaceDiskSpaceError';
  }
}

/** 单作业模型被破坏（已存在 active 作业、并发启动或发现多份 active 作业）。 */
export class JobWorkspaceConflictError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'JobWorkspaceConflictError';
  }
}

/** current 目录状态未知（marker 缺失/损坏/不可读）：失败关闭并保留证据，绝不自动删除。 */
export class JobWorkspaceUnknownStateError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'JobWorkspaceUnknownStateError';
  }
}

/** 工作区对象不再对应当前 current（后继作业已替换该目录）。 */
export class JobWorkspaceIdentityError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'JobWorkspaceIdentityError';
  }
}

/** 已收尾但尚未导出：拒绝启动下一作业或删除资料。 */
export class JobWorkspaceExportRequiredError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'JobWorkspaceExportRequiredError';
  }
}

export interface JobWorkspaceMarker {
  schemaVersion: '1.0.0';
  jobId: string;
  /** 不可复用的作业实例身份；current 被后继替换后旧对象据此失效。 */
  workspaceId: string;
  /** 标记只持久化 active/finalized；finalizing 是纯内存的过渡状态。 */
  state: 'active' | 'finalized';
  startedAt: string;
  deviceLabel: string | null;
  targetUrl: string | null;
  /** 持久粘性水位标记（旧标记缺省为 false）。 */
  storageLimited: boolean;
  /** ZIP 导出并自校验成功后才为 true；未导出的 finalized 不得删除。 */
  exported: boolean;
}

export interface JobWorkspaceInit {
  jobId: string;
  rootDir: string;
  deviceLabel?: string;
  targetUrl?: string;
  startedAt?: string;
  safetyMarginBytes?: number;
  statfs?: StatFsProbe;
  /** JSONL 追加的 fsync 节拍（每 N 次追加一次，默认 128；测试/调优可调）。 */
  fsyncEveryAppends?: number;
}

export interface JobWorkspace {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly dir: string;
  readonly deviceLabel: string | null;
  readonly targetUrl: string | null;
  readonly startedAt: string;
  readonly safetyMarginBytes: number;
  state: JobWorkspaceState;
  /** 运行中触发过安全余量（持久粘性，崩溃恢复不丢）。 */
  readonly storageLimited: boolean;
  /** ZIP 导出并自校验成功后为 true。 */
  readonly exported: boolean;
  /** 磁盘水位检查；不修改 storageLimited。 */
  diskCheck(): Promise<DiskSpaceSnapshot>;
  /** 磁盘水位检查；首次不足时先原子持久化再置位（映射 INCOMPLETE_STORAGE_LIMIT）。 */
  ensureDiskMargin(): Promise<DiskSpaceSnapshot>;
  /** 断言可写（active 且未关闭）；finalizing/finalized/关闭后拒绝写入。 */
  assertWritable(): void;
  /**
   * 登记一个在途写入（BodyStore 等流式写入方使用）；返回释放函数。
   * finalize 进入 finalizing 后拒绝新登记，并等待全部已登记写入落定。
   */
  trackInFlightWrite(): () => void;
  writeArtifact(path: string, content: string | Uint8Array): Promise<void>;
  appendJsonl(path: string, row: unknown): Promise<void>;
  readArtifact(path: string): Promise<Buffer>;
  /**
   * 工件只读字节流（与 readArtifact 同一身份校验/路径归一化）：无界
   * journal、storage.json、正文等大文件逐块消费，不整体载入内存。
   * 文件在流打开后才被删除时由流自身报错（调用方按读取失败记账）。
   */
  openArtifactStream(path: string): Promise<Readable>;
  /** 包内工件相对路径（排序后；不含 workspace.json 与 .tmp/）。 */
  artifactPaths(): Promise<string[]>;
  /** fsync 所有打开的 JSONL 句柄。 */
  flush(): Promise<void>;
  /** 每个 JSONL 文件的追加/fsync 计数（诊断与测试：验证 fsync 节拍）。 */
  jsonlWriteStats(): ReadonlyMap<string, { appends: number; syncs: number }>;
  /**
   * 包工件字节记账（界面展示用，只读单调计数）：JSONL 追加成功行 +
   * writeArtifact 内容 + BodyStore 发布正文。不含工作区内部文件
   * （workspace.json / .owner / .tmp 中间态）与 ZIP 导出；失败写入不计。
   */
  bytesWritten(): number;
  /** BodyStore 正文发布（finish 改名成功）时报数；去重命中不报。只记账，不落盘。 */
  recordBodyBytes(bytes: number): void;
  /** 先原子落盘 finalized 标记，再切换内存状态（收尾完成，尚未导出）。 */
  finalize(): Promise<void>;
  /** ZIP 导出并自校验成功后调用：持久化 exported，此后才允许清理/启动下一作业。 */
  markExported(): Promise<void>;
  /** 关闭句柄；目录保留（active 状态下崩溃可恢复；finalized-unexported 可再恢复导出）。 */
  close(): Promise<void>;
  /**
   * 关闭句柄并删除整个作业目录（未导出的 finalized 拒绝删除）。
   * allowUnexportedDiscard：零观察事实丢弃放宽——调用方必须先过
   * checkUnexportedDiscard 门禁（无观察行且无其他已知现场证据）才允许置位。
   */
  cleanup(options?: { allowUnexportedDiscard?: boolean }): Promise<void>;
  /** 无法装配正式包时，原样移入 retained/ 并释放 current 单作业槽位；绝不删除现场资料。 */
  retainUnexported(): Promise<string>;
}

const defaultStatfs: StatFsProbe = path => statfs(path) as Promise<StatFsLike>;

/** 工作区内部路径（包工件入口与 BodyStore namespace 共用）。 */
const RESERVED_WORKSPACE_SEGMENTS = new Set([
  WORKSPACE_TMP_DIR,
  WORKSPACE_MARKER_FILE,
  WORKSPACE_OWNER_FILE,
]);

export function isReservedWorkspacePath(path: string): boolean {
  const first = path.split('/')[0];
  return RESERVED_WORKSPACE_SEGMENTS.has(first);
}

/** jobId 只允许字母数字开头的安全字符，杜绝 '.' / '..' / 路径分隔符逃逸。 */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 生命周期内部互斥等待（close/finalize/cleanup/markExported）。 */
const LIFECYCLE_MUTEX_WAIT_MS = 30_000;

function validateJobId(jobId: string): void {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId) || jobId === '.' || jobId === '..') {
    throw new Error(`非法作业 ID：${JSON.stringify(jobId)}`);
  }
}

/** join 后的路径必须仍在父目录内（防逃逸的双保险）。 */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new Error(`${label} 逃逸出目录边界：${childPath}`);
  }
}

function normalizeArtifactPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`非法工件路径：${JSON.stringify(path)}`);
  }
  if (path.startsWith('/') || path.includes('\\') || /^[a-zA-Z]:/.test(path)) {
    throw new Error(`工件路径必须是包内相对路径：${path}`);
  }
  const segments = path.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`工件路径包含非法片段：${path}`);
  }
  if (isReservedWorkspacePath(path) || isReservedWorkspacePath(segments[0])) {
    throw new Error(`不得写工作区内部文件：${path}`);
  }
  return segments.join('/');
}

async function freeBytesOf(statfsProbe: StatFsProbe, path: string): Promise<number> {
  const stats = await statfsProbe(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** 原子写标记：.tmp 临时文件 → fsync → rename（写到一半崩溃只留旧标记）。 */
async function writeMarkerAtomic(dir: string, marker: JobWorkspaceMarker): Promise<void> {
  const tmpDir = join(dir, WORKSPACE_TMP_DIR);
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `workspace-marker-${randomUUID()}.json`);
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, join(dir, WORKSPACE_MARKER_FILE));
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/** 严格校验标记全部字段：任何缺失/类型错误/非法值都抛错（失败关闭，绝不静默修复）。 */
async function readMarker(dir: string): Promise<JobWorkspaceMarker> {
  const raw = await readFile(join(dir, WORKSPACE_MARKER_FILE), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const problems: string[] = [];
  if (parsed?.schemaVersion !== '1.0.0') problems.push('schemaVersion 必须为 1.0.0');
  if (typeof parsed?.jobId !== 'string' || !JOB_ID_PATTERN.test(parsed.jobId)) {
    problems.push('jobId 非法');
  }
  if (parsed?.state !== 'active' && parsed?.state !== 'finalized') {
    problems.push('state 必须是 active/finalized');
  }
  if (typeof parsed?.startedAt !== 'string' || parsed.startedAt.length === 0) {
    problems.push('startedAt 必须是非空字符串');
  }
  if (parsed?.deviceLabel !== null && typeof parsed?.deviceLabel !== 'string') {
    problems.push('deviceLabel 必须是字符串或 null');
  }
  if (parsed?.targetUrl !== null && typeof parsed?.targetUrl !== 'string') {
    problems.push('targetUrl 必须是字符串或 null');
  }
  if (typeof parsed?.storageLimited !== 'boolean') {
    problems.push('storageLimited 必须是布尔值');
  }
  if (typeof parsed?.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(parsed.workspaceId)) {
    problems.push('workspaceId 必须是 UUID');
  }
  if (typeof parsed?.exported !== 'boolean') {
    problems.push('exported 必须是布尔值');
  }
  if (problems.length > 0) {
    throw new Error(`作业标记不完整：${problems.join('；')}`);
  }
  return {
    schemaVersion: '1.0.0',
    jobId: parsed.jobId as string,
    workspaceId: parsed.workspaceId as string,
    state: parsed.state as 'active' | 'finalized',
    startedAt: parsed.startedAt as string,
    deviceLabel: parsed.deviceLabel as string | null,
    targetUrl: parsed.targetUrl as string | null,
    storageLimited: parsed.storageLimited as boolean,
    exported: parsed.exported as boolean,
  };
}

export type CurrentMarkerStatus =
  | { ok: true; marker: JobWorkspaceMarker }
  | { ok: false; reason: 'missing' | 'corrupt'; detail: string };

/**
 * 读取规范目录（current）的标记，三态返回：
 * - missing：目录或 workspace.json 不存在（ENOENT）——可能是尚未初始化；
 * - corrupt：存在但解析失败/字段非法/权限错误——**未知状态**，必须失败
 *   关闭并保留证据，绝不能自动认定为安全残留后删除（可能已采集现场资料）；
 * - ok：完整标记（active/finalized）。
 */
async function readCurrentMarker(rootDir: string): Promise<CurrentMarkerStatus> {
  const dir = join(rootDir, WORKSPACE_JOB_DIR);
  let raw: string;
  try {
    raw = await readFile(join(dir, WORKSPACE_MARKER_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 区分「current 不存在」（未初始化 → missing）与「current 存在但缺
      // marker」（状态未知 → corrupt，可能已采集证据，失败关闭）。
      const dirExists = await stat(dir).then(
        stats => stats.isDirectory(),
        () => false,
      );
      return dirExists
        ? { ok: false, reason: 'corrupt', detail: `${dir} 存在但缺少 ${WORKSPACE_MARKER_FILE}` }
        : { ok: false, reason: 'missing', detail: `${dir} 不存在` };
    }
    return { ok: false, reason: 'corrupt', detail: `读取失败：${(error as Error).message}` };
  }
  try {
    const marker = await readMarker(dir);
    return { ok: true, marker };
  } catch (error) {
    return { ok: false, reason: 'corrupt', detail: (error as Error).message };
  }
}

/** 启动前清理未发布的 staging-* 目录（唯一命名、从未成为 current，删除安全）。 */
async function cleanupStagingDirs(rootDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORKSPACE_STAGING_PREFIX)) continue;
    await rm(join(rootDir, entry.name), { recursive: true, force: true });
  }
}

// ---- 根目录级单作业互斥：进程内串行 + 跨进程 OS 内核独占锁 ----

const rootChains = new Map<string, Promise<unknown>>();

/** 进程内按根目录串行（链条空闲时清理，避免 Map 无限增长）。 */
function serializeRoot<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(rootDir);
  const tail = rootChains.get(key) ?? Promise.resolve();
  const result = tail.then(fn, fn);
  const nextTail = result.then(
    () => undefined,
    () => undefined,
  );
  rootChains.set(key, nextTail);
  void nextTail.then(() => {
    if (rootChains.get(key) === nextTail) rootChains.delete(key);
  });
  return result;
}

function createWorkspace(
  fsyncEveryAppends: number,
  init: JobWorkspaceInit,
  marker: JobWorkspaceMarker,
  statfsProbe: StatFsProbe,
  ownerToken: string,
): JobWorkspace {
  const dir = join(init.rootDir, WORKSPACE_JOB_DIR);
  let state: JobWorkspaceState = marker.state;
  let storageLimited = marker.storageLimited;
  let exported = marker.exported;
  let closed = false;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const assertOpen = () => {
    if (closed) throw new Error(`作业已关闭：${init.jobId}`);
  };

  const assertSameInstance = async () => {
    const status = await readCurrentMarker(dirname(dir));
    if (!status.ok || status.marker.workspaceId !== marker.workspaceId) {
      throw new JobWorkspaceIdentityError(
        `工作区实例 ${marker.workspaceId} 已不再对应当前 current 目录`,
      );
    }
  };

  const assertWritable = () => {
    assertOpen();
    if (closing) throw new Error(`作业正在关闭并拒绝写入：${init.jobId}`);
    if (state !== 'active') throw new Error(`作业已进入收尾并拒绝写入：${init.jobId}`);
  };

  const diskCheck = async (): Promise<DiskSpaceSnapshot> => {
    const freeBytes = await freeBytesOf(statfsProbe, dir);
    const marginBytes = init.safetyMarginBytes ?? DEFAULT_DISK_SAFETY_MARGIN_BYTES;
    return { freeBytes, marginBytes, ok: freeBytes >= marginBytes };
  };

  // 在途写入登记：finalize 进入 finalizing 后拒绝新登记，并等待全部落定。
  let inFlightWrites = 0;
  const inFlightWaiters: Array<() => void> = [];

  // 终止流程互斥链：finalize 与 close/cleanup 串行执行，
  // 绝不允许「close 关掉句柄后 finalize 还在 flush」的交错。
  let terminationChain: Promise<void> = Promise.resolve();
  const withTerminationLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = terminationChain.then(fn, fn);
    terminationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // marker 更新互斥链：水位持久化与 finalize 的标记写入串行执行，
  // 保证「active+limited」与「finalized」的标记不会交错覆盖。
  let markerChain: Promise<void> = Promise.resolve();
  const withMarkerLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = markerChain.then(fn, fn);
    markerChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // 每文件 JSONL 句柄：创建按路径 Promise 缓存（并发首次打开只建一个句柄），
  // 追加按路径链式串行（同一文件不会交错写），fsync 计数在链内完成。
  type OpenRecord = {
    handle: import('node:fs/promises').FileHandle;
    /** 累计追加次数（单调递增，绝不回退）——fsync 节拍按此计数。 */
    appendCount: number;
    /** 累计实际执行 fsync 次数（诊断/测试）。 */
    syncCount: number;
    chain: Promise<void>;
  };
  const openHandles = new Map<string, OpenRecord>();
  const handlePromises = new Map<string, Promise<OpenRecord>>();

  const handleOf = async (path: string) => {
    const normalized = normalizeArtifactPath(path);
    let record = openHandles.get(normalized);
    if (!record) {
      let pending = handlePromises.get(normalized);
      if (!pending) {
        pending = (async () => {
          await mkdir(dirname(join(dir, normalized)), { recursive: true });
          const handle = await open(join(dir, normalized), 'a');
          const created: OpenRecord = { handle, appendCount: 0, syncCount: 0, chain: Promise.resolve() };
          openHandles.set(normalized, created);
          return created;
        })();
        handlePromises.set(normalized, pending);
      }
      record = await pending;
    }
    return record;
  };

  /** 按文件串行化追加（链在句柄记录上，close 时链已随租赁耗尽）。
   *  fsync 按「累计追加次数」每 fsyncEveryAppends 次一次（默认 128）——
   *  用队列深度会变成每次追加都 fsync（顺序 10 次 = 10 次 sync）。 */
  // 包工件字节记账：只在写入成功后累加（失败/中止不计），UI 展示用
  let bytesWrittenTotal = 0;

  const enqueueAppend = (record: OpenRecord, line: string): Promise<void> => {
    record.appendCount += 1;
    const needSync = record.appendCount % fsyncEveryAppends === 0;
    const run = record.chain.then(async () => {
      await record.handle.appendFile(line, 'utf8');
      bytesWrittenTotal += Buffer.byteLength(line, 'utf8');
      if (needSync) {
        await record.handle.sync();
        record.syncCount += 1;
      }
    });
    record.chain = run.catch(() => {});
    return run;
  };

  const waitForInFlight = async () => {
    while (inFlightWrites > 0) {
      await new Promise<void>(resolve => inFlightWaiters.push(resolve));
    }
  };

  const releaseOwnerLease = async () => {
    const release = await acquireRootMutex(dirname(dir), LIFECYCLE_MUTEX_WAIT_MS);
    try {
      const status = await readCurrentMarker(dirname(dir));
      if (!status.ok || status.marker.workspaceId !== marker.workspaceId) return;
      const ownerPath = join(dir, WORKSPACE_OWNER_FILE);
      const existing = (await readFile(ownerPath, 'utf8').catch(() => '')).trim();
      if (existing === ownerToken) {
        await unlink(ownerPath).catch(error => {
          // owner 已不存在视为释放成功（并发 close / 崩溃残留）。
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    } finally {
      await release();
    }
  };

  return {
    jobId: init.jobId,
    workspaceId: marker.workspaceId,
    dir,
    deviceLabel: marker.deviceLabel,
    targetUrl: marker.targetUrl,
    startedAt: marker.startedAt,
    safetyMarginBytes: init.safetyMarginBytes ?? DEFAULT_DISK_SAFETY_MARGIN_BYTES,
    get state() {
      return state;
    },
    get storageLimited() {
      return storageLimited;
    },
    get exported() {
      return exported;
    },
    assertWritable,
    trackInFlightWrite() {
      assertWritable();
      inFlightWrites += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlightWrites -= 1;
        if (inFlightWrites === 0) {
          for (const resolve of inFlightWaiters.splice(0)) resolve();
        }
      };
    },
    async diskCheck() {
      assertOpen();
      return diskCheck();
    },
    async ensureDiskMargin() {
      assertOpen();
      await assertSameInstance();
      const snapshot = await diskCheck();
      // 只在 active 时持久化粘性水位；marker 写入与 finalize 通过同一
      // 互斥链串行化，且在锁内复查 closed/closing/state——cleanup 已
      // 返回后延迟完成的水位检查绝不允许重新创建目录与 active 标记。
      if (!snapshot.ok && !storageLimited) {
        await withMarkerLock(async () => {
          if (closed || closing || state !== 'active') return;
          await assertSameInstance();
          // 先原子持久化再置位：崩溃恢复后粘性状态不丢。
          await writeMarkerAtomic(dir, {
            ...marker,
            state: 'active',
            storageLimited: true,
            exported,
          });
          storageLimited = true;
        });
      }
      return snapshot;
    },
    async writeArtifact(path, content) {
      // 写租赁在第一个 await 前取得（assertWritable + 登记同一步完成），
      // 保证 finalize 等待所有在途写入落定，晚到写入不会进入 finalized 包。
      const release = this.trackInFlightWrite();
      try {
        await assertSameInstance();
        const normalized = normalizeArtifactPath(path);
        await mkdir(dirname(join(dir, normalized)), { recursive: true });
        await writeFile(join(dir, normalized), content);
        bytesWrittenTotal +=
          typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
      } finally {
        release();
      }
    },
    async appendJsonl(path, row) {
      const release = this.trackInFlightWrite();
      try {
        await assertSameInstance();
        const record = await handleOf(path);
        // 同一文件按链串行追加 + 计数 fsync（并发首次打开只建一个句柄）。
        await enqueueAppend(record, `${JSON.stringify(row)}\n`);
      } finally {
        release();
      }
    },
    async readArtifact(path) {
      assertOpen();
      await assertSameInstance();
      const normalized =
        path === WORKSPACE_MARKER_FILE ? path : normalizeArtifactPath(path);
      return readFile(join(dir, normalized));
    },
    async openArtifactStream(path) {
      assertOpen();
      await assertSameInstance();
      const normalized =
        path === WORKSPACE_MARKER_FILE ? path : normalizeArtifactPath(path);
      return createReadStream(join(dir, normalized));
    },
    async artifactPaths() {
      assertOpen();
      await assertSameInstance();
      const paths: string[] = [];
      const walk = async (relativeDir: string) => {
        const entries = await readdir(join(dir, relativeDir || '.'), { withFileTypes: true });
        for (const entry of entries) {
          const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (relative === WORKSPACE_TMP_DIR) continue;
            await walk(relative);
          } else if (relative !== WORKSPACE_MARKER_FILE && relative !== WORKSPACE_OWNER_FILE) {
            paths.push(relative);
          }
        }
      };
      await walk('');
      return paths.sort();
    },
    async flush() {
      for (const record of openHandles.values()) {
        await record.chain;
        await record.handle.sync();
        record.syncCount += 1;
      }
    },
    jsonlWriteStats() {
      const stats = new Map<string, { appends: number; syncs: number }>();
      for (const [path, record] of openHandles) {
        stats.set(path, { appends: record.appendCount, syncs: record.syncCount });
      }
      return stats;
    },
    bytesWritten() {
      return bytesWrittenTotal;
    },
    recordBodyBytes(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error(`非法字节数：${bytes}`);
      }
      bytesWrittenTotal += bytes;
    },
    async finalize() {
      assertWritable();
      // 不可变边界：终态流程（finalize 与 close/cleanup）经互斥链串行，
      // 杜绝「close 已关闭句柄、finalize 仍在 flush」的交错；进入链后
      // 复查未关闭，再进入 finalizing（拒绝新写入），等待全部在途写入
      // 落定，经 marker 互斥链原子落盘 finalized 标记并切换状态；
      // 落盘失败保持 finalizing 前的语义（调用方可重试或继续采集）。
      //
      // 调用方契约：finalize 前必须排空所有网络写入（停止向在途
      // BodyStoreWriter 喂数据），否则在途 writer 只能 finish/abort，
      // 可能发布截断正文——采集器负责在收尾前关闭写入源。
      // 同步声明 finalizing：调用后立即拒绝新写入（执行仍在终止链内串行）。
      state = 'finalizing';
      return withTerminationLock(async () => {
        if (closed || closing) {
          state = 'active';
          throw new Error(`作业已关闭或正在关闭，拒绝 finalize：${init.jobId}`);
        }
        try {
          await waitForInFlight();
          await this.flush();
          await withMarkerLock(async () => {
            // 标记落盘纳入全局进程互斥：另一进程的 start 若读到 finalized
            // 会递归删除 current——互斥保证「读到 finalized」与「删除+发布」
            // 与本进程的落盘/使用不交错。
            const release = await acquireRootMutex(dirname(dir), LIFECYCLE_MUTEX_WAIT_MS);
            try {
              await assertSameInstance();
              await writeMarkerAtomic(dir, {
                ...marker,
                state: 'finalized',
                storageLimited,
                exported: false,
              });
            } finally {
              await release();
            }
          });
          state = 'finalized';
        } catch (error) {
          state = 'active';
          throw error;
        }
      });
    },
    async markExported() {
      assertOpen();
      return withTerminationLock(async () => {
        if (closed || closing) {
          throw new Error(`作业已关闭或正在关闭，拒绝 markExported：${init.jobId}`);
        }
        if (state !== 'finalized') {
          throw new Error(`仅 finalized 作业可标记已导出：${init.jobId}`);
        }
        await withMarkerLock(async () => {
          const release = await acquireRootMutex(dirname(dir), LIFECYCLE_MUTEX_WAIT_MS);
          try {
            await assertSameInstance();
            await writeMarkerAtomic(dir, {
              ...marker,
              state: 'finalized',
              storageLimited,
              exported: true,
            });
            exported = true;
          } finally {
            await release();
          }
        });
      });
    },
    async close() {
      if (closed) return;
      if (closePromise) return closePromise;
      // 生命周期边界：先拒绝新租赁（closing），等待在途写入与追加链全部
      // 落定，再关闭句柄——与 finalize 一样经终止互斥链串行。
      // 必须先成功释放 owner 再提交 closed：互斥竞争失败时允许重试 close，
      // 绝不留下「closed=true 但 .owner 仍在」的永久卡死。
      closing = true;
      closePromise = withTerminationLock(async () => {
        try {
          await waitForInFlight();
          await markerChain;
          for (const record of openHandles.values()) {
            await record.chain;
            await record.handle.close();
          }
          openHandles.clear();
          await releaseOwnerLease();
          closed = true;
          closing = false;
        } catch (error) {
          closing = false;
          closePromise = null;
          throw error;
        }
      });
      await closePromise;
    },
    async cleanup(options?: { allowUnexportedDiscard?: boolean }) {
      const allowUnexported = options?.allowUnexportedDiscard === true;
      if (state === 'finalized' && !exported && !allowUnexported) {
        throw new JobWorkspaceExportRequiredError(
          `作业 ${init.jobId} 已收尾但尚未导出，拒绝删除资料`,
        );
      }
      await this.close();
      // 递归删除纳入全局进程互斥，并在 rm 前核对 workspaceId：
      // 取得互斥只能避免同时执行，不能证明 current 仍属于这个对象。
      const release = await acquireRootMutex(dirname(dir), LIFECYCLE_MUTEX_WAIT_MS);
      try {
        const status = await readCurrentMarker(dirname(dir));
        if (!status.ok) return;
        if (status.marker.workspaceId !== marker.workspaceId) return;
        if (status.marker.state === 'finalized' && !status.marker.exported && !allowUnexported) {
          throw new JobWorkspaceExportRequiredError(
            `作业 ${status.marker.jobId} 已收尾但尚未导出，拒绝删除资料`,
          );
        }
        const existing = (await readFile(join(dir, WORKSPACE_OWNER_FILE), 'utf8').catch(() => '')).trim();
        if (existing && existing !== ownerToken) return;
        await rm(dir, { recursive: true, force: true });
      } finally {
        await release();
      }
    },
    async retainUnexported() {
      if (state !== 'finalized' || exported) {
        throw new Error('只能保留已收尾且未导出的作业');
      }
      await this.close();
      const rootDir = dirname(dir);
      const release = await acquireRootMutex(rootDir, LIFECYCLE_MUTEX_WAIT_MS);
      try {
        const status = await readCurrentMarker(rootDir);
        if (!status.ok || status.marker.workspaceId !== marker.workspaceId ||
            status.marker.state !== 'finalized' || status.marker.exported) {
          throw new JobWorkspaceIdentityError(`作业 ${init.jobId} 已不再对应待保留的 current 目录`);
        }
        const owner = await readFile(join(dir, WORKSPACE_OWNER_FILE), 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw error;
        });
        if (owner.trim()) throw new Error('作业仍被其他实例持有，拒绝移动');
        const retainedDir = join(rootDir, 'retained');
        await mkdir(retainedDir, { recursive: true });
        const retainedPath = join(retainedDir, `${marker.jobId}-${marker.workspaceId}`);
        const alreadyExists = await stat(retainedPath).then(() => true, error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        });
        if (alreadyExists) throw new Error('保留目录已存在，拒绝覆盖');
        await rename(dir, retainedPath);
        return retainedPath;
      } finally {
        await release();
      }
    },
  };
}

/**
 * 启动新作业：磁盘水位检查 → 清理未发布 staging → 在唯一 staging 目录内
 * 完成初始化（marker + owner 一起落盘）→ `rename(staging, current)` 原子发布
 * → 写入 active 标记前的任何崩溃都只留下 staging 残留（可安全清理）。
 *
 * 发布前若 `current` 已存在（含空目录）：按标记处理。缺 marker 视为未知
 * 状态失败关闭（POSIX rename 会覆盖空目录，绝不能先 rename）。active
 * 冲突；finalized 且未导出拒绝启动；仅 exported 后才删除并发布新作业。
 */
export async function startJobWorkspace(init: JobWorkspaceInit): Promise<JobWorkspace> {
  validateJobId(init.jobId);
  assertFsyncCadence(init.fsyncEveryAppends);
  const safetyMarginBytes = init.safetyMarginBytes ?? DEFAULT_DISK_SAFETY_MARGIN_BYTES;
  const statfsProbe = init.statfs ?? defaultStatfs;

  return serializeRoot(init.rootDir, async () => {
    const releaseMutex = await acquireRootMutex(init.rootDir);
    try {
      await mkdir(init.rootDir, { recursive: true });
      const freeBytes = await freeBytesOf(statfsProbe, init.rootDir);
      if (freeBytes < safetyMarginBytes) {
        throw new JobWorkspaceDiskSpaceError({ freeBytes, marginBytes: safetyMarginBytes, ok: false });
      }
      await cleanupStagingDirs(init.rootDir);

      const currentDir = join(init.rootDir, WORKSPACE_JOB_DIR);
      assertInside(init.rootDir, currentDir, '作业目录');
      const currentExists = await stat(currentDir).then(
        stats => stats.isDirectory(),
        () => false,
      );
      if (currentExists) {
        const status = await readCurrentMarker(init.rootDir);
        if (!status.ok) {
          throw new JobWorkspaceUnknownStateError(
            `current 目录状态未知（${status.detail}），已保留现场资料，请人工检查后再启动`,
          );
        }
        if (status.marker.state === 'active') {
          throw new JobWorkspaceConflictError(
            `已存在 active 作业（${status.marker.jobId}），同一时刻只允许一个当前作业；请先恢复或清理`,
          );
        }
        if (!status.marker.exported) {
          throw new JobWorkspaceExportRequiredError(
            `上一作业 ${status.marker.jobId} 已收尾但尚未导出，拒绝覆盖资料`,
          );
        }
        await rm(currentDir, { recursive: true, force: true });
      }

      const marker: JobWorkspaceMarker = {
        schemaVersion: '1.0.0',
        jobId: init.jobId,
        workspaceId: randomUUID(),
        state: 'active',
        startedAt: init.startedAt ?? new Date().toISOString(),
        deviceLabel: init.deviceLabel ?? null,
        targetUrl: init.targetUrl ?? null,
        storageLimited: false,
        exported: false,
      };
      const ownerContent = `${process.pid}:${randomUUID()}`;
      const stagingDir = join(init.rootDir, `${WORKSPACE_STAGING_PREFIX}${process.pid}-${randomUUID()}`);
      try {
        await mkdir(stagingDir, { recursive: true });
        await writeMarkerAtomic(stagingDir, marker);
        await writeFile(join(stagingDir, WORKSPACE_OWNER_FILE), `${ownerContent}\n`, { flag: 'wx' });
        await rename(stagingDir, currentDir);
      } catch (error) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return createWorkspace(
        init.fsyncEveryAppends ?? FSYNC_EVERY_APPENDS,
        init,
        marker,
        statfsProbe,
        ownerContent,
      );
    } finally {
      await releaseMutex();
    }
  });
}

/**
 * 恢复异常退出后唯一未完成作业：active，或已收尾但尚未导出的
 * finalized-unexported（只读，供手动导出）。已 exported 返回 null。
 * 所有权：`current/.owner` 由恢复方以 `wx` 原子取得——属主进程存活时
 * 冲突；属主已死时默认**失败关闭**（不自动偷取），调用方确认单实例
 * 后（Electron requestSingleInstanceLock 保证）可传 `resetStaleOwner: true`
 * 显式接管。两个并发恢复（即使都传 resetStaleOwner）也只有唯一赢家。
 */
export async function recoverActiveJobWorkspace(
  rootDir: string,
  options: Pick<JobWorkspaceInit, 'safetyMarginBytes' | 'statfs' | 'fsyncEveryAppends'> & {
    resetStaleOwner?: boolean;
  } = {},
): Promise<JobWorkspace | null> {
  const statfsProbe = options.statfs ?? defaultStatfs;
  assertFsyncCadence(options.fsyncEveryAppends);
  return serializeRoot(rootDir, async () => {
    const releaseMutex = await acquireRootMutex(rootDir);
    try {
      await mkdir(rootDir, { recursive: true });
      const status = await readCurrentMarker(rootDir);
      if (!status.ok) {
        if (status.reason === 'missing') return null;
        throw new JobWorkspaceUnknownStateError(
          `current 目录状态未知（${status.detail}），已保留现场资料，请人工检查`,
        );
      }
      if (status.marker.exported) return null;
      if (status.marker.state !== 'active' && status.marker.state !== 'finalized') {
        return null;
      }

      const currentDir = join(rootDir, WORKSPACE_JOB_DIR);
      assertInside(rootDir, currentDir, '作业目录');
      const ownerPath = join(currentDir, WORKSPACE_OWNER_FILE);
      const token = randomUUID();
      const ownContent = `${process.pid}:${token}`;
      try {
        await writeFile(ownerPath, `${ownContent}\n`, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = (await readFile(ownerPath, 'utf8')).trim();
        const match = /^(\d+):([0-9a-f-]{36})$/.exec(existing);
        const existingPid = match ? Number(match[1]) : Number.NaN;
        const alive =
          match !== null &&
          (existingPid === process.pid || (await processExistsForRecovery(existingPid)));
        if (alive || !options.resetStaleOwner) {
          throw new JobWorkspaceConflictError(
            `作业 ${status.marker.jobId} 正被恢复/持有（.owner = ${existing || '空'}）；` +
              '如属主进程已退出，请确认单实例后以 resetStaleOwner 显式接管',
          );
        }
        await unlink(ownerPath).catch(() => {});
        try {
          await writeFile(ownerPath, `${ownContent}\n`, { flag: 'wx' });
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new JobWorkspaceConflictError('作业正在被另一进程恢复（.owner 竞争）');
          }
          throw retryError;
        }
      }
      return createWorkspace(
        options.fsyncEveryAppends ?? FSYNC_EVERY_APPENDS,
        {
          jobId: status.marker.jobId,
          rootDir,
          deviceLabel: status.marker.deviceLabel ?? undefined,
          targetUrl: status.marker.targetUrl ?? undefined,
          startedAt: status.marker.startedAt,
          safetyMarginBytes: options.safetyMarginBytes,
          statfs: statfsProbe,
        },
        status.marker,
        statfsProbe,
        ownContent,
      );
    } finally {
      await releaseMutex();
    }
  });
}

/** 恢复用进程存活探测（EPERM = 存在）。 */
async function processExistsForRecovery(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 全局进程互斥键（同一 rootDir 全局唯一）：放系统临时目录，避免被作业
 * 目录清理影响。路径带 v2 版本，与旧协议 `.sock` / 无版本 `.lock` 隔离；
 * 旧残留失败关闭，不自动 unlink。Windows 用命名管道；Linux 用抽象
 * socket（由此路径派生名称）；macOS 用该路径作为 O_EXLOCK 锁文件。
 */
export function jobProcessMutexPath(rootDir: string): string {
  const key = createHash('sha256').update(resolve(rootDir)).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\kvm-recon-v2-${key}`
    : join(tmpdir(), `kvm-recon-mutex-v2-${key}.lock`);
}

/** 互斥错误映射为单作业冲突（对外 API 保持 JobWorkspaceConflictError）。 */
async function wrapProcessMutex(
  acquire: () => Promise<() => Promise<void>>,
): Promise<() => Promise<void>> {
  try {
    return await acquire();
  } catch (error) {
    if (error instanceof ProcessMutexHeldError) {
      throw new JobWorkspaceConflictError(error.message);
    }
    throw error;
  }
}

async function acquireRootMutex(rootDir: string, waitMs = 0): Promise<() => Promise<void>> {
  return wrapProcessMutex(() => acquireProcessMutex(jobProcessMutexPath(rootDir), { waitMs }));
}

function assertFsyncCadence(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`fsyncEveryAppends 必须是正整数：${value}`);
  }
}

/** 工作区内部临时目录（.tmp）的绝对路径，供 BodyStore 等流式写入方使用。 */
export function workspaceTmpDir(workspace: JobWorkspace): string {
  return join(workspace.dir, WORKSPACE_TMP_DIR);
}
