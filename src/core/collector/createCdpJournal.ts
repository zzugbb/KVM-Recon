/**
 * 原始 CDP journal（规范 §8.1）：事件与命令逐条 JSONL，params/result 原样保留。
 *
 * seq 在调用点同步赋值，追加按 seq 顺序串行链接——多根挂载（主窗口 +
 * popup）并发写入时，落盘顺序与 seq 顺序一致，否则包一致性门禁
 * （seq 严格递增）会拒绝导出。
 *
 * 写失败是粘性的：链断开后不再尝试写后续行（乱序落盘会破坏写序 = seq 序），
 * 因此每条被跳过的行都必须持久作证（journalWriteFailures），丢行绝不允许
 * 只留进程内 droppedEvent 计数——否则包内无缺失记录，派生假 COMPLETE。
 */

import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import type { PackV2CdpCommandRow, PackV2CdpEventRow } from '../capture-pack-v2/types';
import type { CollectorEvidence } from './collectorEvidence';

const EVENTS_PATH = 'raw/cdp/events.jsonl';
const COMMANDS_PATH = 'raw/cdp/commands.jsonl';

export interface CdpJournal {
  recordEvent(row: Omit<PackV2CdpEventRow, 'seq'>): Promise<void>;
  recordCommand(row: Omit<PackV2CdpCommandRow, 'seq'>): Promise<void>;
}

function failureDetail(kind: string, seq: number, path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${kind}行 #${seq} 未落盘（${path}）：${message}`;
}

export function createCdpJournal(workspace: JobWorkspace, evidence: CollectorEvidence): CdpJournal {
  let eventSeq = 0;
  let commandSeq = 0;
  let eventTail: Promise<void> = Promise.resolve();
  let commandTail: Promise<void> = Promise.resolve();
  let eventsFailed = false;
  let commandsFailed = false;
  return {
    recordEvent(row) {
      eventSeq += 1;
      const seq = eventSeq;
      const record: PackV2CdpEventRow = { seq, ...row };
      if (eventsFailed) {
        // 粘性丢列：链已断，本行不再尝试落盘（写序必须等于 seq 序），
        // 丢失必须逐条持久作证
        evidence.recordGap(
          'journalWriteFailures',
          `events#${seq}`,
          `事件行 #${seq} 跳过（前序事件行写入失败，粘性丢列）`,
        );
        return eventTail;
      }
      // 挂到链尾：上一条落定后才写这一条，写序 = seq 序
      eventTail = eventTail.then(() => workspace.appendJsonl(EVENTS_PATH, record)).catch(error => {
        eventsFailed = true;
        evidence.recordGap('journalWriteFailures', `events#${seq}`, failureDetail('事件', seq, EVENTS_PATH, error));
        throw error;
      });
      return eventTail;
    },
    recordCommand(row) {
      commandSeq += 1;
      const seq = commandSeq;
      const record: PackV2CdpCommandRow = { seq, ...row };
      if (commandsFailed) {
        evidence.recordGap(
          'journalWriteFailures',
          `commands#${seq}`,
          `命令行 #${seq} 跳过（前序命令行写入失败，粘性丢列）`,
        );
        return commandTail;
      }
      commandTail = commandTail
        .then(() => workspace.appendJsonl(COMMANDS_PATH, record))
        .catch(error => {
          commandsFailed = true;
          evidence.recordGap(
            'journalWriteFailures',
            `commands#${seq}`,
            failureDetail('命令', seq, COMMANDS_PATH, error),
          );
          throw error;
        });
      return commandTail;
    },
  };
}
