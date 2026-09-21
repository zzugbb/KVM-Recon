/**
 * 采集失败记账（规范 §3「缺失必须显式」）。
 *
 * 任何被捕获后继续执行的错误（事件落盘失败、正文不可读、帧断档、无法
 * 观察的通道）都必须在这里留下计数与缺口 ID；阶段 3 的 IntegrityEngine
 * 用这些事实填充 PackIntegrityEvidenceSummary 并映射 INCOMPLETE 原因。
 * 没有记账的静默丢弃等于编造「没有发生过」。
 */

import type { IntegrityEvidenceGap, PackIntegrityEvidenceSummary } from '../capture-pack-v2/types';

export type EvidenceGapCategory =
  | 'targetAttachFailures'
  | 'missingBodies'
  | 'missingWorkerSources'
  | 'channelGaps'
  | 'unsupportedChannels'
  | 'journalWriteFailures';

/** 缺口列表上限：超出后聚合为一条「N more」记录，防止记账自身无界。 */
const MAX_GAP_ENTRIES = 500;

/** 观察脚本钩子安装失败明细上限：超出后置 * 哨兵（派生按全观察面不可信处理）。 */
const MAX_HOOK_FAILURE_ENTRIES = 100;

export interface ObserverHookFailure {
  hook: string;
  stage: string;
  detail: string;
}

/** 观察脚本钩子对应的实时通道观察面（表面条件映射用；action/crypto 不映射通道缺口）。 */
const OBSERVER_HOOK_SURFACES: Record<string, 'webrtc' | 'webtransport' | 'sse'> = {
  webrtc: 'webrtc',
  'webrtc-datachannel': 'webrtc',
  webtransport: 'webtransport',
  sse: 'sse',
};

export interface CollectorEvidence {
  /** 按类别记录一个缺口（附出现次数统计）。 */
  recordGap(category: EvidenceGapCategory, id: string, detail?: string): void;
  /** 事件处理链上的未捕获异常：记录丢弃计数与按方法统计（诊断用，不进包）。 */
  droppedEvent(method: string, error: unknown): void;
  /**
   * 观察脚本钩子安装失败：除 droppedEvent 计数外保留有界明细（hook/stage），
   * 供 workflowStatus 派生折扣与表面条件缺口映射（阶段 3）。
   */
  recordObserverHookFailure(hook: string, stage: string, detail: string): void;
  markStorageLimitReached(): void;
  diagnostics(): {
    droppedEvents: number;
    droppedEventByMethod: Readonly<Record<string, number>>;
    gapCounts: Readonly<Record<string, number>>;
    storageLimitReached: boolean;
    observerHookFailures: ReadonlyArray<ObserverHookFailure>;
  };
  /** 汇总为阶段 3 IntegrityEngine 的证据摘要输入。 */
  summary(input: {
    collectorReadyBeforeFirstNavigation: boolean;
    rawJournalsClosed: boolean;
    browserStateWritten: boolean;
    evidenceReferencesClosed: boolean;
    workflowStatus: PackIntegrityEvidenceSummary['workflowStatus'];
  }): PackIntegrityEvidenceSummary;
}

export function createCollectorEvidence(): CollectorEvidence {
  const gaps = new Map<EvidenceGapCategory, { count: number; entries: IntegrityEvidenceGap[]; overflow: number }>();
  let droppedEvents = 0;
  const droppedByMethod = new Map<string, number>();
  let storageLimitReached = false;
  const hookFailures: ObserverHookFailure[] = [];
  let hookFailureOverflowed = false;

  function bucket(category: EvidenceGapCategory) {
    let entry = gaps.get(category);
    if (!entry) {
      entry = { count: 0, entries: [], overflow: 0 };
      gaps.set(category, entry);
    }
    return entry;
  }

  function trimmed(category: EvidenceGapCategory): IntegrityEvidenceGap[] {
    const entry = gaps.get(category);
    if (!entry) return [];
    const rows = entry.entries.slice();
    if (entry.overflow > 0) {
      rows.push({
        id: `…${entry.overflow} more suppressed`,
        detail: `类目 ${category} 缺口超出 ${MAX_GAP_ENTRIES} 条上限`,
      });
    }
    return rows;
  }

  return {
    recordGap(category, id, detail) {
      const entry = bucket(category);
      entry.count += 1;
      if (entry.entries.length < MAX_GAP_ENTRIES) {
        entry.entries.push({ id, ...(detail ? { detail } : {}) });
      } else {
        entry.overflow += 1;
      }
    },
    droppedEvent(method, error) {
      // 错误对象不落盘（可能包含敏感路径），只计数与归类
      void error;
      droppedEvents += 1;
      droppedByMethod.set(method, (droppedByMethod.get(method) ?? 0) + 1);
    },
    recordObserverHookFailure(hook, stage, detail) {
      // 与 droppedEvent('observer-hook-failed') 同一计数通道，另有界保留明细
      droppedEvents += 1;
      droppedByMethod.set(
        'observer-hook-failed',
        (droppedByMethod.get('observer-hook-failed') ?? 0) + 1,
      );
      if (hookFailures.length < MAX_HOOK_FAILURE_ENTRIES) {
        hookFailures.push({ hook, stage, detail });
      } else if (!hookFailureOverflowed) {
        hookFailureOverflowed = true;
        hookFailures.push({
          hook: '*',
          stage: 'overflow',
          detail: `观察脚本钩子安装失败明细超出 ${MAX_HOOK_FAILURE_ENTRIES} 条上限`,
        });
      }
    },
    markStorageLimitReached() {
      storageLimitReached = true;
    },
    diagnostics() {
      return {
        droppedEvents,
        droppedEventByMethod: Object.fromEntries(droppedByMethod),
        gapCounts: Object.fromEntries(
          [...gaps.entries()].map(([category, entry]) => [category, entry.count]),
        ),
        storageLimitReached,
        observerHookFailures: hookFailures.map(failure => ({ ...failure })),
      };
    },
    summary(input) {
      return {
        collectorReadyBeforeFirstNavigation: input.collectorReadyBeforeFirstNavigation,
        rawJournalsClosed: input.rawJournalsClosed,
        browserStateWritten: input.browserStateWritten,
        evidenceReferencesClosed: input.evidenceReferencesClosed,
        storageLimitReached,
        targetAttachFailures: trimmed('targetAttachFailures'),
        missingBodies: trimmed('missingBodies'),
        missingWorkerSources: trimmed('missingWorkerSources'),
        channelGaps: trimmed('channelGaps'),
        unsupportedChannels: trimmed('unsupportedChannels'),
        journalWriteFailures: trimmed('journalWriteFailures'),
        exportValidationFailures: [],
        workflowStatus: input.workflowStatus,
      };
    },
  };
}

/**
 * 观察脚本钩子失败的表面条件映射（阶段 3 第 1 刀）：只有对应观察面
 * （webrtc / webtransport / sse 通道）真实在场时，钩子失败才构成
 * channelGaps 缺口——无使用的面不记缺口，不编造（规范 §3）。
 */
export function observerHookFailureChannelGaps(
  hookFailures: ReadonlyArray<ObserverHookFailure>,
  channelKinds: ReadonlySet<string>,
): Array<{ id: string; detail: string }> {
  const gaps: Array<{ id: string; detail: string }> = [];
  const seen = new Set<string>();
  for (const failure of hookFailures) {
    if (failure.hook === '*') {
      const surfaces = ['webrtc', 'webtransport', 'sse'].filter(kind => channelKinds.has(kind));
      if (surfaces.length > 0 && !seen.has('*')) {
        seen.add('*');
        gaps.push({
          id: 'observer-hook:overflow',
          detail: `${failure.detail}；存在 ${surfaces.join('/')} 通道，其消息采集可能不完整`,
        });
      }
      continue;
    }
    const surface = OBSERVER_HOOK_SURFACES[failure.hook];
    if (!surface || !channelKinds.has(surface)) continue;
    const key = `${failure.hook}/${failure.stage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({
      id: `observer-hook:${key}`,
      detail: `观察脚本钩子安装失败（${failure.hook}/${failure.stage}）：${failure.detail}；存在 ${surface} 通道，其消息采集可能不完整`,
    });
  }
  return gaps;
}
