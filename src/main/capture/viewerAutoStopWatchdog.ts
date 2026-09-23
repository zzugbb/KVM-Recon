/**
 * Viewer 自动收尾看门狗（规范 §7.4）。
 *
 * 采集期间每 2s 轮询会话事实快照，检测到 Viewer 活动（§7.3 信号）后
 * 启动稳定窗口：新 target / 通道 / 导航 / 用户动作（活动指纹变化）重置
 * 窗口；窗口静默通过后仍须在途非持续 HTTP 请求全部落盘（§7.4），否则
 * 推迟收尾；全部就绪 → 只触发收尾（controller.stop()），绝不自动导出、
 * 不关窗、不弹保存框。检测到 Viewer 活动时对 viewer target 补
 * viewer-initial 阶段截图（§7.4「至少完成 Viewer 初始与稳定阶段截图」；
 * 识别是事实驱动的，检出前无法预知哪个 target 是 viewer）。识别 /
 * 快照读取 / 阶段截图抛错只记诊断，绝不停采集。
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
  /** 在途非持续 HTTP 请求（createCaptureSession.pendingNonStreamingRequests()）。 */
  pendingNonStreamingRequests(): ReadonlyArray<{ id: string; url: string }>;
  /** viewer-initial 阶段截图（createCaptureSession.captureViewerInitialScreenshot(targetId)；§7.4）。 */
  captureViewerInitialState(targetId: string): boolean | Promise<boolean>;
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
  let lastDeferredPendingCount = 0;
  const capturedInitialTargetIds = new Set<string>();
  const pendingInitialCaptures = new Set<Promise<void>>();

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
    // 规范 §7.4「至少完成 Viewer 初始与稳定阶段截图」：检测到 Viewer 活动
    // 时对 viewer target 补 viewer-initial 阶段截图。同一 target 只截一次：
    // 标记先于调用（每轮轮询重复检出不得重复截图），失败不重试——失败已
    // 记诊断，缺截图由一致性验证器如实报缺口，识别 / 收尾照常继续。
    for (const signal of signals) {
      const targetId = signal.viewerTargetId;
      if (capturedInitialTargetIds.has(targetId)) continue;
      capturedInitialTargetIds.add(targetId);
      try {
        const result: unknown = deps.captureViewerInitialState(targetId);
        if (
          result &&
          typeof result === 'object' &&
          typeof (result as Promise<boolean>).then === 'function'
        ) {
          let pending!: Promise<void>;
          pending = (result as Promise<boolean>)
            .then(captured => {
              if (!captured) {
                deps.recordDiagnostic(
                  'viewer-initial-screenshot-failed',
                  `viewer-initial 阶段截图返回失败（target ${targetId}）`,
                );
              }
            })
            .catch(error => {
              deps.recordDiagnostic(
                'viewer-initial-screenshot-failed',
                `viewer-initial 阶段截图失败（target ${targetId}）：${errorMessage(error)}`,
              );
            })
            .finally(() => pendingInitialCaptures.delete(pending));
          pendingInitialCaptures.add(pending);
        } else if (result !== true) {
          deps.recordDiagnostic(
            'viewer-initial-screenshot-failed',
            `viewer-initial 阶段截图返回失败（target ${targetId}）`,
          );
        }
      } catch (error) {
        deps.recordDiagnostic(
          'viewer-initial-screenshot-failed',
          `viewer-initial 阶段截图失败（target ${targetId}）：${errorMessage(error)}`,
        );
      }
    }
    const fingerprint = activityFingerprint(facts);
    if (fingerprint !== lastFingerprint) {
      // 新 target / 通道 / 导航 / 动作：稳定窗口重新起算
      lastFingerprint = fingerprint;
      stableDeadline = deps.now() + VIEWER_STABLE_WINDOW_MS;
      return;
    }
    if (deps.now() < stableDeadline) return;
    // 阶段截图是 COMPLETE 门禁的一部分。截图 CDP 命令尚未落盘时不能先
    // stop/finalize；稳定窗口仍从首次检出时计算，Promise settled 后下一轮
    // 可立即继续，不额外再等一个完整稳定窗口。
    if (pendingInitialCaptures.size > 0) return;
    // 规范 §7.4「非持续响应正文全部落盘」：在途非持续 HTTP 请求未完成
    // 时不得收尾——stop 会把未完成请求按 'unfinished' 提交并记缺口，等于
    // 把「还在落盘」错记成「应有而未有」。推迟到请求完成（下一轮轮询）；
    // 诊断只在计数变化时记一次（有界）。
    const pending = deps.pendingNonStreamingRequests();
    if (pending.length > 0) {
      if (pending.length !== lastDeferredPendingCount) {
        lastDeferredPendingCount = pending.length;
        const sample = pending.slice(0, 5).map(hop => hop.url).join(' ');
        deps.recordDiagnostic(
          'viewer-auto-stop-deferred',
          `Viewer 活动已稳定，但在途非持续 HTTP 请求 ${pending.length} 个未落盘，推迟自动收尾：${sample}`,
        );
      }
      return;
    }
    lastDeferredPendingCount = 0;
    deps.recordDiagnostic(
      'viewer-auto-stop',
      `Viewer 活动稳定 ${VIEWER_STABLE_WINDOW_MS}ms 无新 target/通道/导航/动作，自动收尾（导出仍由用户决定）`,
    );
    stop();
    // 自动收尾失败必须显式记账：stop() 拒绝 / 同步抛错只记
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
