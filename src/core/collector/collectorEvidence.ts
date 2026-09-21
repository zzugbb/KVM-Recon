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

export interface CollectorEvidence {
  /** 按类别记录一个缺口（附出现次数统计）。 */
  recordGap(category: EvidenceGapCategory, id: string, detail?: string): void;
  /** 事件处理链上的未捕获异常：记录丢弃计数与按方法统计（诊断用，不进包）。 */
  droppedEvent(method: string, error: unknown): void;
  markStorageLimitReached(): void;
  diagnostics(): {
    droppedEvents: number;
    droppedEventByMethod: Readonly<Record<string, number>>;
    gapCounts: Readonly<Record<string, number>>;
    storageLimitReached: boolean;
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
