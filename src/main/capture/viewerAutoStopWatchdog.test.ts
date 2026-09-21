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

function viewerFacts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    transactions: [],
    actions: [action()],
    targets: [],
    channels: [channel({ id: 'ws-1' })],
    navigations: [nav()],
    hookFailures: [],
    ...overrides,
  };
}

function setupDeps(initial: WorkflowFacts) {
  let current = initial;
  const getFacts = vi.fn(() => current);
  const recordDiagnostic = vi.fn();
  const autoStop = vi.fn();
  return {
    getFacts,
    recordDiagnostic,
    autoStop,
    setFacts(next: WorkflowFacts) {
      current = next;
    },
    deps: {
      getFacts: () => getFacts(),
      now: () => Date.now(),
      recordDiagnostic: (kind: string, detail: string) => recordDiagnostic(kind, detail),
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
});
