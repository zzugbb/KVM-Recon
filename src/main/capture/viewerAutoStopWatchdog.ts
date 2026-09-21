/**
 * Viewer 自动收尾看门狗（规范 §7.4，阶段 3 第 3 刀）。
 *
 * 采集期间每 2s 轮询会话事实快照，检测到 Viewer 活动（§7.3 信号）后
 * 启动稳定窗口：新 target / 通道 / 用户动作（活动指纹变化）重置窗口；
 * 窗口静默通过 → 只触发收尾（controller.stop()），绝不自动导出、
 * 不关窗、不弹保存框。识别 / 快照读取抛错只记诊断，绝不停采集。
 *
 * 定时器 unref：不阻止进程退出（崩溃恢复路径依赖 before-quit 收尾）。
 */

import type { ControllerDiagnosticKind } from '../../core/capture-pack-v2/types';
import { activityFingerprint, detectViewerActivity } from '../../core/collector/viewerActivity';
import type { WorkflowFacts } from '../../core/collector/workflowStatusEngine';

/** 事实快照轮询间隔。 */
export const VIEWER_POLL_INTERVAL_MS = 2_000;
/** Viewer 活动稳定窗口：无新 target / 通道 / 动作的静默时长。 */
export const VIEWER_STABLE_WINDOW_MS = 15_000;

export interface ViewerAutoStopDeps {
  /** 会话事实快照（createCaptureSession.workflowFacts()）。 */
  getFacts(): WorkflowFacts;
  /** 单调时钟（epoch ms）。 */
  now(): number;
  /** 控制器诊断行（进 raw/controller/diagnostics.jsonl）。 */
  recordDiagnostic(kind: ControllerDiagnosticKind, detail: string): void;
  /** 自动收尾触发（只 stop；不导出、不关窗、不弹保存框）。 */
  autoStop(): void | Promise<void>;
}

export interface ViewerAutoStopWatchdog {
  start(): void;
  stop(): void;
}

export function createViewerAutoStopWatchdog(deps: ViewerAutoStopDeps): ViewerAutoStopWatchdog {
  let timer: ReturnType<typeof setInterval> | null = null;
  let detected = false;
  let lastFingerprint: string | null = null;
  let stableDeadline = 0;

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function poll() {
    let facts: WorkflowFacts;
    try {
      facts = deps.getFacts();
    } catch (error) {
      deps.recordDiagnostic('viewer-activity-error', `事实快照读取失败：${errorMessage(error)}`);
      return;
    }
    let signals: ReturnType<typeof detectViewerActivity>;
    try {
      signals = detectViewerActivity(facts);
    } catch (error) {
      // 识别引擎契约是永不抛出；兜底捕获以防事实形状意外，只记诊断不停采集
      deps.recordDiagnostic('viewer-activity-error', `识别引擎异常：${errorMessage(error)}`);
      return;
    }
    if (signals.length === 0) return;
    if (!detected) {
      detected = true;
      const first = signals[0];
      deps.recordDiagnostic(
        'viewer-activity-detected',
        `action=${first.actionId} openedVia=${first.openedVia} channel=${first.channelId}（共 ${signals.length} 组合）`,
      );
    }
    const fingerprint = activityFingerprint(facts);
    if (fingerprint !== lastFingerprint) {
      // 新 target / 通道 / 动作：稳定窗口重新起算
      lastFingerprint = fingerprint;
      stableDeadline = deps.now() + VIEWER_STABLE_WINDOW_MS;
      return;
    }
    if (deps.now() < stableDeadline) return;
    deps.recordDiagnostic(
      'viewer-auto-stop',
      `Viewer 活动稳定 ${VIEWER_STABLE_WINDOW_MS}ms 无新 target/通道/动作，自动收尾（导出仍由用户决定）`,
    );
    stop();
    // 自动收尾失败必须显式记账（P3-R11-2）：stop() 拒绝 / 同步抛错只记
    // viewer-auto-stop-failed 诊断——workspace 保持 active，下次启动走
    // 恢复导出；绝不产生未处理 Promise 拒绝，也绝不重抛中断轮询调用方。
    try {
      const result: unknown = deps.autoStop();
      if (
        result &&
        typeof result === 'object' &&
        typeof (result as Promise<void>).catch === 'function'
      ) {
        (result as Promise<void>).catch(error => {
          deps.recordDiagnostic('viewer-auto-stop-failed', `自动收尾失败：${errorMessage(error)}`);
        });
      }
    } catch (error) {
      deps.recordDiagnostic('viewer-auto-stop-failed', `自动收尾失败：${errorMessage(error)}`);
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(poll, VIEWER_POLL_INTERVAL_MS);
      timer.unref?.();
    },
    stop,
  };
}
