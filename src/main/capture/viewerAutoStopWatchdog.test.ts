/**
 * 阶段 3 第 3 刀：Viewer 自动收尾看门狗反例集（规范 §7.4）。
 *
 * 行为契约：
 * - 2s 轮询事实快照，检测到 Viewer 活动 → 记 viewer-activity-detected 诊断；
 * - 新 target / 通道 / 动作（指纹变化）重置 15s 稳定窗口；
 * - 窗口静默通过 → 只触发收尾（autoStop），不导出、不关窗、不弹保存框；
 * - 识别 / 快照读取抛错只记诊断，采集继续；
 * - 无 Viewer 活动永不自动收尾；stop() 后停止轮询且不再触发。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2RenderSurfaceRow,
  PackV2TargetRow,
} from '../../core/capture-pack-v2/types';
import type { WorkflowFacts, WorkflowNavigationFact } from '../../core/collector/workflowStatusEngine';
import {
  createViewerAutoStopWatchdog,
  VIEWER_POLL_INTERVAL_MS,
  VIEWER_STABLE_WINDOW_MS,
} from './viewerAutoStopWatchdog';

const T0 = Date.parse('2026-09-21T02:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function action(overrides: Partial<PackV2BrowserActionRow> = {}): PackV2BrowserActionRow {
  return {
    id: 'action-0001',
    occurredAt: at(1_000),
    kind: 'click',
    targetId: 'target-root',
    elementSummary: 'button#console-open',
    ...overrides,
  };
}

function target(overrides: Partial<PackV2TargetRow> & { id: string }): PackV2TargetRow {
  return { type: 'page', attached: true, url: null, ...overrides };
}

function channel(overrides: Partial<PackV2ChannelRow> & { id: string }): PackV2ChannelRow {
  return {
    kind: 'websocket',
    url: 'ws://bmc.test/stream',
    targetId: 'target-root',
    createdAt: at(3_000),
    closedAt: null,
    frameCounts: { up: 2, down: 3 },
    payloadPath: 'raw/websocket/x/frames.bin',
    ...overrides,
  };
}

function nav(overrides: Partial<WorkflowNavigationFact> = {}): WorkflowNavigationFact {
  return { occurredAt: at(2_000), targetId: 'target-root', url: 'http://bmc.test/viewer', ...overrides };
}

function renderSurface(overrides: Partial<PackV2RenderSurfaceRow> = {}): PackV2RenderSurfaceRow {
  return {
    id: 'render-0001',
    occurredAt: at(2_500),
    targetId: 'target-root',
    surface: 'canvas-context',
    detail: '2d',
    ...overrides,
  };
}

function viewerFacts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    transactions: [],
    actions: [action()],
    targets: [],
    channels: [channel({ id: 'ws-1' })],
    navigations: [nav()],
    renderSurfaces: [renderSurface()],
    hookFailures: [],
    ...overrides,
  };
}

function setupDeps(initial: WorkflowFacts) {
  let current = initial;
  let pending: Array<{ id: string; url: string }> = [];
  const getFacts = vi.fn(() => current);
  const recordDiagnostic = vi.fn();
  const autoStop = vi.fn();
  const captureViewerInitialState = vi.fn<
    (targetId: string) => boolean | Promise<boolean>
  >((_targetId: string) => true);
  return {
    getFacts,
    recordDiagnostic,
    autoStop,
    captureViewerInitialState,
    setFacts(next: WorkflowFacts) {
      current = next;
    },
    setPending(next: Array<{ id: string; url: string }>) {
      pending = next;
    },
    deps: {
      getFacts: () => getFacts(),
      now: () => Date.now(),
      recordDiagnostic: (kind: string, detail: string) => recordDiagnostic(kind, detail),
      pendingNonStreamingRequests: () => pending,
      captureViewerInitialState: (targetId: string) => captureViewerInitialState(targetId),
      autoStop: () => autoStop(),
    },
  };
}

describe('viewerAutoStopWatchdog（§7.4 自动收尾）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('检测 → 稳定窗口静默通过 → 只触发收尾一次', () => {
    const harness = setupDeps(viewerFacts());
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();

    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS);
    expect(harness.autoStop).not.toHaveBeenCalled();
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      'viewer-activity-detected',
      expect.stringContaining('action-0001'),
    );

    // 稳定窗口内持续轮询：无新事实 → 不收尾
    vi.advanceTimersByTime(VIEWER_STABLE_WINDOW_MS - 1_000);
    expect(harness.autoStop).not.toHaveBeenCalled();

    // 窗口静默通过 → 自动收尾（只 stop，导出仍由用户决定）
    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS + 1_000);
    expect(harness.autoStop).toHaveBeenCalledTimes(1);
    expect(harness.recordDiagnostic).toHaveBeenCalledWith('viewer-auto-stop', expect.any(String));

    // 收尾触发后不再轮询、不再重复触发
    const calls = harness.getFacts.mock.calls.length;
    vi.advanceTimersByTime(VIEWER_STABLE_WINDOW_MS * 2);
    expect(harness.autoStop).toHaveBeenCalledTimes(1);
    expect(harness.getFacts.mock.calls.length).toBe(calls);
  });

  it('窗口内新动作出现 → 重置稳定窗口，不提前收尾', () => {
    const harness = setupDeps(viewerFacts());
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();

    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS); // 检测 + 窗口起算
    // 窗口内 6s：新动作（指纹变化）→ 重置
    vi.advanceTimersByTime(6_000);
    harness.setFacts(
      viewerFacts({ actions: [action(), action({ id: 'action-0002', occurredAt: at(10_000) })] }),
    );
    vi.advanceTimersByTime(VIEWER_STABLE_WINDOW_MS - 1_000);
    expect(harness.autoStop).not.toHaveBeenCalled();
    // 原窗口早已过，但重置后的窗口未到：仍不收尾
    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS);
    expect(harness.autoStop).not.toHaveBeenCalled();
    // 重置后满 15s 静默 → 收尾
    vi.advanceTimersByTime(VIEWER_STABLE_WINDOW_MS);
    expect(harness.autoStop).toHaveBeenCalledTimes(1);
  });

  it('无 Viewer 活动：永不自动收尾', () => {
    const harness = setupDeps({
      transactions: [],
      actions: [action()],
      targets: [target({ id: 'target-root' })],
      channels: [],
      navigations: [nav()],
      renderSurfaces: [],
      hookFailures: [],
    });
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();
    vi.advanceTimersByTime(VIEWER_STABLE_WINDOW_MS * 4);
    expect(harness.autoStop).not.toHaveBeenCalled();
    expect(harness.recordDiagnostic).not.toHaveBeenCalledWith(
      'viewer-activity-detected',
      expect.any(String),
    );
  });

  it('事实快照读取抛错：只记诊断，采集继续，后续恢复检测仍可收尾', () => {
    const harness = setupDeps(viewerFacts());
    const boom = new Error('workspace closed');
    const failing: typeof harness.getFacts = vi.fn(() => {
      throw boom;
    });
    const deps = {
      ...harness.deps,
      getFacts: () => failing(),
    };
    const watchdog = createViewerAutoStopWatchdog(deps);
    watchdog.start();

    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS);
    expect(harness.recordDiagnostic).toHaveBeenCalledWith('viewer-activity-error', expect.stringContaining('workspace closed'));
    expect(harness.autoStop).not.toHaveBeenCalled();

    // 读取恢复后（现场事实仍在）：检测 → 稳定 → 收尾照常
    const restored = createViewerAutoStopWatchdog({
      ...harness.deps,
    });
    watchdog.stop();
    restored.start();
    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS + VIEWER_STABLE_WINDOW_MS + VIEWER_POLL_INTERVAL_MS);
    expect(harness.autoStop).toHaveBeenCalledTimes(1);
  });

  it('stop() 后停止轮询：不再检测也不再触发', () => {
    const harness = setupDeps(viewerFacts());
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();
    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS);
    watchdog.stop();
    const calls = harness.getFacts.mock.calls.length;
    vi.advanceTimersByTime(VIEWER_STABLE_WINDOW_MS * 2);
    expect(harness.getFacts.mock.calls.length).toBe(calls);
    expect(harness.autoStop).not.toHaveBeenCalled();
  });

  // 第 11 轮审核 P3-R11-2：自动收尾失败必须显式记账（viewer-auto-stop-failed），
  // 绝不产生未处理 Promise 拒绝；workspace 保持 active，下次启动走恢复导出。
  it('自动收尾 stop() 拒绝：记 viewer-auto-stop-failed 诊断，不产生未处理拒绝（P3-R11-2）', async () => {
    const harness = setupDeps(viewerFacts());
    const failing = vi.fn(() => Promise.reject(new Error('收尾失败：workspace 损坏')));
    const deps = { ...harness.deps, autoStop: () => failing() };
    const watchdog = createViewerAutoStopWatchdog(deps);
    watchdog.start();

    await vi.advanceTimersByTimeAsync(
      VIEWER_POLL_INTERVAL_MS + VIEWER_STABLE_WINDOW_MS + VIEWER_POLL_INTERVAL_MS,
    );
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      'viewer-auto-stop-failed',
      expect.stringContaining('收尾失败：workspace 损坏'),
    );
  });

  it('自动收尾 autoStop 同步抛错：同样记 viewer-auto-stop-failed 诊断（P3-R11-2）', async () => {
    const harness = setupDeps(viewerFacts());
    const throwing = vi.fn(() => {
      throw new Error('同步抛错');
    });
    const deps = { ...harness.deps, autoStop: () => throwing() };
    const watchdog = createViewerAutoStopWatchdog(deps);
    watchdog.start();

    await vi.advanceTimersByTimeAsync(
      VIEWER_POLL_INTERVAL_MS + VIEWER_STABLE_WINDOW_MS + VIEWER_POLL_INTERVAL_MS,
    );
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      'viewer-auto-stop-failed',
      expect.stringContaining('同步抛错'),
    );
  });

  // 第五轮 G2（规范 §7.4「非持续响应正文全部落盘」）：稳定窗口静默通过但
  // 仍有在途非持续 HTTP 请求时不得自动收尾——stop 会把未完成请求按
  // 'unfinished' 提交并记 missingBodies 缺口，等于把「还在落盘」错记成
  // 「应有而未有」；必须推迟到在途请求完成。
  it('稳定窗口通过但在途非持续 HTTP 未完成：推迟自动收尾，落盘后立即收尾', () => {
    const harness = setupDeps(viewerFacts());
    harness.setPending([{ id: 'req-1', url: 'http://bmc.test/api/session' }]);
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();

    vi.advanceTimersByTime(
      VIEWER_POLL_INTERVAL_MS + VIEWER_STABLE_WINDOW_MS + VIEWER_POLL_INTERVAL_MS,
    );
    expect(harness.autoStop).not.toHaveBeenCalled();
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      'viewer-auto-stop-deferred',
      expect.stringContaining('http://bmc.test/api/session'),
    );

    // 在途请求完成（pending 清空）→ 下一轮轮询立即收尾，无需重新等待稳定窗口
    harness.setPending([]);
    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS);
    expect(harness.autoStop).toHaveBeenCalledTimes(1);
  });

  it('推迟诊断有界：pending 计数不变不重复记，计数变化再记一次', () => {
    const harness = setupDeps(viewerFacts());
    harness.setPending([{ id: 'req-1', url: 'http://bmc.test/api/session' }]);
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();

    vi.advanceTimersByTime(
      VIEWER_POLL_INTERVAL_MS + VIEWER_STABLE_WINDOW_MS + VIEWER_POLL_INTERVAL_MS * 3,
    );
    const deferredCalls = harness.recordDiagnostic.mock.calls.filter(
      call => call[0] === 'viewer-auto-stop-deferred',
    );
    expect(deferredCalls).toHaveLength(1);

    // 计数变化（第二个在途请求）→ 再记一次
    harness.setPending([
      { id: 'req-1', url: 'http://bmc.test/api/session' },
      { id: 'req-2', url: 'http://bmc.test/api/status' },
    ]);
    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS);
    const deferredCallsAfter = harness.recordDiagnostic.mock.calls.filter(
      call => call[0] === 'viewer-auto-stop-deferred',
    );
    expect(deferredCallsAfter).toHaveLength(2);
    expect(harness.autoStop).not.toHaveBeenCalled();
  });

  // 第五轮 G3（规范 §7.4「至少完成 Viewer 初始与稳定阶段截图」）：检测到
  // Viewer 活动时对 viewer target 补 viewer-initial 阶段截图；同一 target
  // 只截一次（每轮轮询重复检测不得重复截图）。
  it('检出 Viewer 活动 → 对 viewer target 补 viewer-initial 阶段截图，同 target 只截一次', () => {
    const harness = setupDeps(viewerFacts());
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();

    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS);
    expect(harness.captureViewerInitialState).toHaveBeenCalledTimes(1);
    expect(harness.captureViewerInitialState).toHaveBeenCalledWith('target-root');

    // 后续轮询重复检出同一 viewer target：不重复截图
    vi.advanceTimersByTime(VIEWER_POLL_INTERVAL_MS * 3);
    expect(harness.captureViewerInitialState).toHaveBeenCalledTimes(1);
  });

  it('viewer-initial 截图失败：只记诊断，不中断检测与后续自动收尾', async () => {
    const harness = setupDeps(viewerFacts());
    harness.captureViewerInitialState.mockImplementation(() =>
      Promise.reject(new Error('截图超时（模拟）')),
    );
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();

    await vi.advanceTimersByTimeAsync(VIEWER_POLL_INTERVAL_MS);
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      'viewer-initial-screenshot-failed',
      expect.stringContaining('截图超时'),
    );
    // 识别 / 收尾照常：稳定窗口静默通过后仍自动收尾
    await vi.advanceTimersByTimeAsync(VIEWER_STABLE_WINDOW_MS + VIEWER_POLL_INTERVAL_MS);
    expect(harness.autoStop).toHaveBeenCalledTimes(1);
  });

  it('viewer-initial 截图仍在执行时不先 stop；落盘完成后下一轮才收尾', async () => {
    const harness = setupDeps(viewerFacts());
    let release!: (captured: boolean) => void;
    harness.captureViewerInitialState.mockImplementation(
      () => new Promise<boolean>(resolve => {
        release = resolve;
      }),
    );
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();

    await vi.advanceTimersByTimeAsync(
      VIEWER_STABLE_WINDOW_MS + VIEWER_POLL_INTERVAL_MS * 2,
    );
    expect(harness.autoStop).not.toHaveBeenCalled();
    release(true);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(VIEWER_POLL_INTERVAL_MS);
    expect(harness.autoStop).toHaveBeenCalledTimes(1);
  });

  it('viewer-initial 同步返回 false 时显式记失败诊断', async () => {
    const harness = setupDeps(viewerFacts());
    harness.captureViewerInitialState.mockImplementation(() => false);
    const watchdog = createViewerAutoStopWatchdog(harness.deps);
    watchdog.start();
    await vi.advanceTimersByTimeAsync(VIEWER_POLL_INTERVAL_MS);
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      'viewer-initial-screenshot-failed',
      expect.stringContaining('返回失败'),
    );
  });
});
