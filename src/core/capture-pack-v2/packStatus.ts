import { sortIncompleteReasons } from './incompleteReasons';
import type {
  CaptureIntegrity,
  DerivedPackIntegrity,
  PackIntegrityEvidenceSummary,
  PackV2IntegrityGate,
  PackV2Status,
  WorkflowStatus,
} from './types';
import { PACK_V2_INTEGRITY_GATE_IDS } from './types';

/**
 * 采集完整度与工作流状态（规范 §6）以及完整度门禁（规范 §14）。
 * 证据摘要由采集器的真实观察事实填充。
 */

export interface PackStatusCheck {
  legal: boolean;
  violations: string[];
}

/**
 * 状态组合合法性：
 * - COMPLETE 只能与 KVM_REACHED 组合。未到达 KVM 时完整度必须是
 *   INCOMPLETE + INCOMPLETE_WORKFLOW_NOT_REACHED。
 * - 不识别协议族：未知架构只要证据完整且到达 KVM，同样可以 COMPLETE。
 */
export function checkPackStatus(status: PackV2Status): PackStatusCheck {
  const violations: string[] = [];
  if (status.captureIntegrity === 'COMPLETE' && status.workflowStatus !== 'KVM_REACHED') {
    violations.push(
      `COMPLETE 只能与 KVM_REACHED 组合，当前为 ${status.workflowStatus}；未到达 KVM 时必须 INCOMPLETE + INCOMPLETE_WORKFLOW_NOT_REACHED`,
    );
  }
  return { legal: violations.length === 0, violations };
}

// ---------- 完整度派生（规范 §14 门禁） ----------

/**
 * 由证据摘要派生 captureIntegrity、原因代码与十项门禁。
 * 原因代码固定按规范 §14 列出顺序输出。
 *
 * 完整度 = 无任何原因代码 **且** 十项门禁全部通过（规范 §14）：
 * 十项门禁中的每一项失败都必须产生至少一个稳定原因代码，
 * 不允许出现「门禁失败但 COMPLETE」。
 */
export function derivePackIntegrity(summary: PackIntegrityEvidenceSummary): DerivedPackIntegrity {
  const bodyMissing = summary.missingBodies.length > 0;
  const targetAttach =
    !summary.collectorReadyBeforeFirstNavigation || summary.targetAttachFailures.length > 0;
  const workerSource = summary.missingWorkerSources.length > 0;
  const channelGap = summary.channelGaps.length > 0;
  const unsupportedChannel = summary.unsupportedChannels.length > 0;
  const storageLimit = summary.storageLimitReached;
  const exportValidation = summary.exportValidationFailures.length > 0;
  const workflowNotReached = summary.workflowStatus !== 'KVM_REACHED';
  // journal 行写入磁盘失败 = raw journal 缺行，按 §14 映射 INCOMPLETE_RAW_JOURNAL
  const rawJournal =
    !summary.rawJournalsClosed || summary.journalWriteFailures.length > 0;
  // 状态快照步骤失败（写入了空数据）不是「已写入」
  const browserState = !summary.browserStateWritten || summary.browserStateGaps.length > 0;
  // 证据图派生/写盘失败（被 best-effort 吞掉）不是「已闭环」
  const evidenceReference =
    !summary.evidenceReferencesClosed || summary.evidenceGraphFailures.length > 0;

  const reasons = sortIncompleteReasons([
    ...(bodyMissing ? (['INCOMPLETE_BODY_MISSING'] as const) : []),
    ...(targetAttach ? (['INCOMPLETE_TARGET_ATTACH'] as const) : []),
    ...(workerSource ? (['INCOMPLETE_WORKER_SOURCE'] as const) : []),
    ...(channelGap ? (['INCOMPLETE_CHANNEL_GAP'] as const) : []),
    ...(unsupportedChannel ? (['INCOMPLETE_UNSUPPORTED_CHANNEL'] as const) : []),
    ...(storageLimit ? (['INCOMPLETE_STORAGE_LIMIT'] as const) : []),
    ...(exportValidation ? (['INCOMPLETE_EXPORT_VALIDATION'] as const) : []),
    ...(workflowNotReached ? (['INCOMPLETE_WORKFLOW_NOT_REACHED'] as const) : []),
    ...(rawJournal ? (['INCOMPLETE_RAW_JOURNAL'] as const) : []),
    ...(browserState ? (['INCOMPLETE_BROWSER_STATE'] as const) : []),
    ...(evidenceReference ? (['INCOMPLETE_EVIDENCE_REFERENCE'] as const) : []),
  ]);

  const gates: PackV2IntegrityGate[] = [
    {
      id: 'collector-ready-before-first-navigation',
      passed: summary.collectorReadyBeforeFirstNavigation,
    },
    {
      id: 'targets-attached',
      passed: summary.targetAttachFailures.length === 0,
      detail:
        summary.targetAttachFailures
          .map(failure => `${failure.id}${failure.detail ? `: ${failure.detail}` : ''}`)
          .join('; ') || undefined,
    },
    {
      id: 'http-bodies-complete',
      passed: !bodyMissing,
      detail:
        summary.missingBodies.map(gap => `${gap.id}${gap.detail ? `: ${gap.detail}` : ''}`).join('; ') ||
        undefined,
    },
    {
      id: 'scripts-workers-wasm-complete',
      passed: !workerSource,
      detail:
        summary.missingWorkerSources
          .map(gap => `${gap.id}${gap.detail ? `: ${gap.detail}` : ''}`)
          .join('; ') || undefined,
    },
    {
      id: 'realtime-channels-complete',
      passed: !channelGap,
      detail:
        summary.channelGaps.map(gap => `${gap.id}${gap.detail ? `: ${gap.detail}` : ''}`).join('; ') ||
        undefined,
    },
    {
      id: 'no-uncollected-channel',
      passed: !unsupportedChannel,
      detail:
        summary.unsupportedChannels
          .map(gap => `${gap.id}${gap.detail ? `: ${gap.detail}` : ''}`)
          .join('; ') || undefined,
    },
    {
      id: 'raw-journals-closed',
      passed: rawJournal === false,
      detail:
        summary.journalWriteFailures
          .map(gap => `${gap.id}${gap.detail ? `: ${gap.detail}` : ''}`)
          .join('; ') || undefined,
    },
    {
      id: 'browser-state-written',
      passed: browserState === false,
      detail:
        summary.browserStateGaps
          .map(gap => `${gap.id}${gap.detail ? `: ${gap.detail}` : ''}`)
          .join('; ') ||
        (summary.browserStateWritten ? undefined : '浏览器状态快照未写入') ||
        undefined,
    },
    {
      id: 'evidence-references-closed',
      passed: evidenceReference === false,
      detail:
        summary.evidenceGraphFailures
          .map(gap => `${gap.id}${gap.detail ? `: ${gap.detail}` : ''}`)
          .join('; ') ||
        (summary.evidenceReferencesClosed ? undefined : '证据图未闭环') ||
        undefined,
    },
    {
      id: 'zip-self-validated',
      passed: !exportValidation,
      detail:
        summary.exportValidationFailures
          .map(gap => `${gap.id}${gap.detail ? `: ${gap.detail}` : ''}`)
          .join('; ') || undefined,
    },
  ];

  return {
    captureIntegrity:
      reasons.length === 0 && gates.every(gate => gate.passed) ? 'COMPLETE' : 'INCOMPLETE',
    reasons,
    gates,
  };
}

/**
 * 由派生完整度与工作流结果组装合法状态。
 * INCOMPLETE 结果不携带任何原因代码视为契约违规；
 * COMPLETE 结果携带原因代码或存在失败门禁同样视为契约违规。
 */
export function buildPackStatusTriple(input: {
  derived: DerivedPackIntegrity;
  workflowStatus: WorkflowStatus;
}): PackV2Status {
  if (input.derived.captureIntegrity === 'INCOMPLETE' && input.derived.reasons.length === 0) {
    throw new Error('INCOMPLETE 必须至少携带一个稳定原因代码（规范 §14）');
  }
  if (input.derived.captureIntegrity === 'COMPLETE' && input.derived.reasons.length > 0) {
    throw new Error('COMPLETE 不允许携带完整度原因代码（规范 §14）');
  }
  // 门禁必须恰好覆盖十个唯一且完整的门禁 ID；空集或残缺集合不允许（规范 §14）。
  const gateIds = input.derived.gates.map(gate => gate.id);
  const gateIdSet = new Set(gateIds);
  if (gateIds.length !== PACK_V2_INTEGRITY_GATE_IDS.length || gateIdSet.size !== PACK_V2_INTEGRITY_GATE_IDS.length) {
    throw new Error(
      `门禁必须恰好覆盖十个唯一门禁 ID（规范 §14），实际 ${gateIds.length} 个 / ${gateIdSet.size} 个唯一`,
    );
  }
  for (const gateId of PACK_V2_INTEGRITY_GATE_IDS) {
    if (!gateIdSet.has(gateId)) {
      throw new Error(`门禁缺少必需 ID：${gateId}（规范 §14）`);
    }
  }
  if (input.derived.captureIntegrity === 'COMPLETE') {
    const failedGates = input.derived.gates.filter(gate => !gate.passed);
    if (failedGates.length > 0) {
      throw new Error(
        `COMPLETE 不允许存在未通过的门禁（规范 §14）：${failedGates.map(gate => gate.id).join(', ')}`,
      );
    }
  }
  const status: PackV2Status = {
    captureIntegrity: input.derived.captureIntegrity,
    workflowStatus: input.workflowStatus,
  };
  const check = checkPackStatus(status);
  if (!check.legal) {
    throw new Error(check.violations.join('; '));
  }
  return status;
}
