import type { CaptureIntegrity, WorkflowStatus } from './types';

/**
 * Capture Pack 2.0 ZIP 文件名（规范 §10）：
 *
 *   KVM-Recon_<YYYYMMDD-HHmmss>_<HOST>_<WORKFLOW>_<INTEGRITY>_<SHORT_JOB_ID>.zip
 *
 * - 不包含协议族、产品候选和设备说明。
 * - HOST 做文件名安全化（点号等分隔符转连字符，例如 10.10.8.111 → 10-10-8-111）。
 * - WORKFLOW：KVM-REACHED / LOGIN-REACHED / TARGET-OPENED。
 * - INTEGRITY：COMPLETE / INCOMPLETE；LEGACY_UNVERIFIED 只来自 1.x 导入，
 *   2.0 导出不允许出现。
 */

export interface BuildPackV2FileNameInput {
  /** 作业开始时间（ISO 8601，含本地时区偏移）。 */
  startedAt: string;
  targetHost: string;
  workflowStatus: WorkflowStatus;
  captureIntegrity: CaptureIntegrity;
  shortJobId: string;
}

function dateTimeSegment(startedAt: string): string {
  const match = startedAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    // 非法时间必须拒绝：静默退回占位段会让不同作业生成相同文件名（规范 §14：缺失必须显式）。
    throw new Error(`无法从 startedAt 解析 YYYYMMDD-HHmmss 时间段：${startedAt}`);
  }
  const [, year, month, day, hour, minute, second] = match;
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function safeHostSegment(host: string): string {
  const segment = host
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/\./g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return segment || 'unknown-host';
}

function safeShortIdSegment(shortJobId: string): string {
  const segment = shortJobId
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '')
    .slice(0, 12);
  if (!segment) {
    throw new Error('短作业 ID 不能为空，且必须包含文件名安全字符');
  }
  return segment;
}

export function buildPackV2FileName(input: BuildPackV2FileNameInput): string {
  if (input.captureIntegrity === 'LEGACY_UNVERIFIED') {
    throw new Error('LEGACY_UNVERIFIED 只能来自 1.x 导入，不能出现在 2.0 导出文件名（规范 §6 / §10）');
  }
  const workflow = input.workflowStatus.replace(/_/g, '-');
  return [
    'KVM-Recon',
    dateTimeSegment(input.startedAt),
    safeHostSegment(input.targetHost),
    workflow,
    input.captureIntegrity,
    safeShortIdSegment(input.shortJobId),
  ].join('_').concat('.zip');
}
