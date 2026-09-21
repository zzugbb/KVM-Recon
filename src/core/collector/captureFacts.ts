/**
 * 采集事实落盘（规范 §3 / §4.2，阶段 2 崩溃恢复）。
 *
 * `catalog/capture-facts.json` 是采集会话的生命周期事实：第一个根挂载后即
 * 写入 v1（target / 环境 / startedAt），stop() 收尾时覆写终态（完整证据
 * 摘要）。它随包导出（catalog/ 稳定索引），也是崩溃恢复导出的单一事实
 * 来源：应用崩溃后恢复的工作区可以凭它装配出合法的 2.0 包。
 *
 * 硬崩溃（来不及 stop）时只有 v1：恢复导出必须显式保守（门禁无法证明的
 * 一律不通过），绝不把「不知道」写成「没有缺口」。
 */

import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import type {
  PackIntegrityEvidenceSummary,
  PackV2Environment,
  WorkflowStatus,
} from '../capture-pack-v2/types';

export const CAPTURE_FACTS_PATH = 'catalog/capture-facts.json';

export interface CaptureFacts {
  schemaVersion: '1.0.0';
  jobId: string;
  workspaceId: string;
  startedAt: string;
  endedAt: string | null;
  deviceLabel: string | null;
  targetUrl: string | null;
  /** 从 targetUrl 解析的目标（host/port/scheme）；解析失败为 null（恢复导出拒绝）。 */
  target: { host: string; port: number; scheme: 'http' | 'https' } | null;
  /** 页面侧 + 主进程侧合并环境（阶段 2 在首个根挂载后即采集一次）。 */
  environment: PackV2Environment | null;
  /** 阶段 2 恒为 TARGET_OPENED（诚实下限；阶段 3 IntegrityEngine 接管派生）。 */
  workflowStatus: WorkflowStatus;
  /** stop() 收尾完成后为 true；false = 进程崩溃或异常退出。 */
  stopped: boolean;
  /** 恢复导出覆写过 facts（保守证据摘要）时为 true；正常导出缺省。 */
  recovered?: boolean;
  /** stop() 写入的完整证据摘要；v1（未收尾）为 null。 */
  evidenceSummary: PackIntegrityEvidenceSummary | null;
  /**
   * stop() 收尾时落的 droppedEvent 按方法计数快照（进程内诊断的包内落盘
   * 形态；规范 §3「缺失必须显式」）；v1（未收尾 / 硬崩溃）为 null。
   */
  droppedEventByMethod: Record<string, number> | null;
}

/** 从 targetUrl 解析 manifest 需要的 target；解析失败返回 null（不猜）。 */
export function parseCaptureTarget(
  targetUrl: string | null,
): { host: string; port: number; scheme: 'http' | 'https' } | null {
  if (!targetUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') return null;
  const host = parsed.hostname;
  if (!host) return null;
  const port = parsed.port
    ? Number(parsed.port)
    : scheme === 'https'
      ? 443
      : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port, scheme };
}

export function readCaptureFactsFromBuffer(buffer: Buffer): CaptureFacts {
  const parsed = JSON.parse(buffer.toString('utf8')) as Partial<CaptureFacts>;
  const problems: string[] = [];
  if (parsed?.schemaVersion !== '1.0.0') problems.push('schemaVersion 必须为 1.0.0');
  if (typeof parsed?.jobId !== 'string' || !parsed.jobId) problems.push('jobId 缺失');
  if (typeof parsed?.workspaceId !== 'string' || !parsed.workspaceId) problems.push('workspaceId 缺失');
  if (typeof parsed?.startedAt !== 'string' || !parsed.startedAt) problems.push('startedAt 缺失');
  if (typeof parsed?.stopped !== 'boolean') problems.push('stopped 必须为布尔值');
  if (parsed?.workflowStatus !== 'KVM_REACHED' && parsed?.workflowStatus !== 'LOGIN_REACHED' && parsed?.workflowStatus !== 'TARGET_OPENED') {
    problems.push('workflowStatus 非法');
  }
  if (problems.length > 0) {
    throw new Error(`capture-facts 不完整：${problems.join('；')}`);
  }
  return {
    schemaVersion: '1.0.0',
    jobId: parsed.jobId!,
    workspaceId: parsed.workspaceId!,
    startedAt: parsed.startedAt!,
    endedAt: typeof parsed?.endedAt === 'string' ? parsed.endedAt : null,
    deviceLabel: typeof parsed?.deviceLabel === 'string' ? parsed.deviceLabel : null,
    targetUrl: typeof parsed?.targetUrl === 'string' ? parsed.targetUrl : null,
    target: parsed?.target ?? null,
    environment: parsed?.environment ?? null,
    workflowStatus: parsed.workflowStatus!,
    stopped: parsed.stopped!,
    recovered: parsed?.recovered === true,
    evidenceSummary: parsed?.evidenceSummary ?? null,
    droppedEventByMethod:
      parsed?.droppedEventByMethod && typeof parsed.droppedEventByMethod === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.droppedEventByMethod).filter(
              (entry): entry is [string, number] => typeof entry[1] === 'number',
            ),
          )
        : null,
  };
}

/** 读取工作区 capture-facts；缺失返回 null（调用方决定是否拒绝恢复导出）。 */
export async function readCaptureFacts(
  workspace: JobWorkspace,
): Promise<CaptureFacts | null> {
  let buffer: Buffer;
  try {
    buffer = await workspace.readArtifact(CAPTURE_FACTS_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return readCaptureFactsFromBuffer(buffer);
}

/**
 * 硬崩溃恢复（capture-facts 只有 v1 / 缺失证据摘要）时的保守证据摘要：
 * 无法从磁盘证明的门禁一律不通过（缺失必须显式，规范 §3）——
 * INCOMPLETE_TARGET_ATTACH / INCOMPLETE_BROWSER_STATE / INCOMPLETE_EVIDENCE_REFERENCE
 * 至少在列；从磁盘可证明的事实：storageLimited（持久粘性标记）。
 * rawJournalsClosed=true：帧写入的 FIN 后视 + 延迟落盘设计保证崩溃时 bin
 * 不超前 index，恢复后 finalize 落定的 journal 在磁盘上自洽。
 */
export function conservativeRecoveredEvidenceSummary(
  facts: CaptureFacts,
  options: { storageLimitReached: boolean; workflowStatus: WorkflowStatus },
): PackIntegrityEvidenceSummary {
  void facts;
  return {
    collectorReadyBeforeFirstNavigation: false,
    rawJournalsClosed: true,
    browserStateWritten: false,
    evidenceReferencesClosed: false,
    storageLimitReached: options.storageLimitReached,
    targetAttachFailures: [],
    missingBodies: [],
    missingWorkerSources: [],
    channelGaps: [],
    unsupportedChannels: [],
    journalWriteFailures: [],
    exportValidationFailures: [],
    workflowStatus: options.workflowStatus,
  };
}
