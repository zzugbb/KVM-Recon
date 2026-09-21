/**
 * Controller 诊断事实记录器（规范 §8.4）。
 *
 * stderr + 内存环形缓冲镜像同步保留；事实行追加进包。行写入失败走
 * droppedEvent 计账（收尾后到达的行由 finalize 门禁拒绝，同属此路径），
 * 镜像不受写失败影响——诊断缺失绝不静默。
 */

import type { ControllerDiagnosticKind } from '../../core/capture-pack-v2/types';

export interface ControllerDiagnosticRow {
  occurredAt: string;
  kind: ControllerDiagnosticKind;
  detail: string;
}

export interface DiagnosticRecorderDeps {
  appendDiagnosticRow(row: ControllerDiagnosticRow): Promise<void>;
  droppedEvent(method: string, error: unknown): void;
  mirrorLog(line: string): void;
}

export function createDiagnosticRecorder(deps: DiagnosticRecorderDeps) {
  return function recordDiagnostic(kind: ControllerDiagnosticKind, detail: string): void {
    deps.mirrorLog(`capture-${kind} ${detail}`);
    void (async () => {
      try {
        await deps.appendDiagnosticRow({ occurredAt: new Date().toISOString(), kind, detail });
      } catch (error) {
        deps.droppedEvent('controller-diagnostic', error);
      }
    })();
  };
}
