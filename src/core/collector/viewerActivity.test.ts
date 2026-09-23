/**
 * Viewer 活动识别纯模块反例集（规范 §7.3 / §7.4）。
 *
 * 信号规则与 workflowStatusEngine 的 KVM_REACHED 派生保持同一事实组合：
 * 用户动作（click / form-submit）的 target 血缘集合（动作 target + 经
 * openerTargetId / parentTargetId 链关联的后代）内，严格按“动作 → 打开或
 * 导航 → 新渲染/执行表面 → 持续双向通道”出现事实（WS 双向帧 / WebRTC
 * 双向消息 / WebTransport 在场）。
 * 反例约束：
 * - 与 deriveWorkflowStatus 的 viewerActivity 结论必须一致（不出现两套定义，
 *   含畸形时间戳：不可解析按零信号，不得把 0 凑成时序）；
 * - 钩子失败折扣同引擎（对应观察面不可信）；
 * - 永不抛出：畸形事实返回零信号，不抛异常；
 * - activityFingerprint 看动作 / target / 通道 / 导航计数（新事实才重置稳定窗口）。
 */

import { describe, expect, it } from 'vitest';

import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2HttpTransactionRow,
  PackV2RenderSurfaceRow,
  PackV2TargetRow,
} from '../capture-pack-v2/types';
import type { ObserverHookFailure } from './collectorEvidence';
import { deriveWorkflowStatus, type WorkflowFacts, type WorkflowNavigationFact } from './workflowStatusEngine';
import { activityFingerprint, detectViewerActivity } from './viewerActivity';

const T0 = Date.parse('2026-09-21T01:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function tx(overrides: Partial<PackV2HttpTransactionRow> & { id: string }): PackV2HttpTransactionRow {
  return {
    targetId: 'target-root',
    startedAt: at(0),
    method: 'GET',
    url: 'http://bmc.test/',
    resourceType: 'other',
    requestHeaders: {},
    status: 200,
    responseHeaders: {},
    ...overrides,
  };
}

function action(overrides: Partial<PackV2BrowserActionRow> = {}): PackV2BrowserActionRow {
  return {
    id: 'action-0001',
    occurredAt: at(0),
    kind: 'click',
    targetId: 'target-root',
    elementSummary: 'button#console-open',
    ...overrides,
  };
}

function target(overrides: Partial<PackV2TargetRow> & { id: string }): PackV2TargetRow {
  return {
    type: 'page',
    attached: true,
    url: null,
    ...overrides,
  };
}

function channel(overrides: Partial<PackV2ChannelRow> & { id: string }): PackV2ChannelRow {
  return {
    kind: 'websocket',
    url: 'ws://bmc.test/stream',
    targetId: 'target-root',
    createdAt: at(0),
    closedAt: null,
    frameCounts: { up: 2, down: 3 },
    payloadPath: 'raw/websocket/x/frames.bin',
    ...overrides,
  };
}

function nav(overrides: Partial<WorkflowNavigationFact> = {}): WorkflowNavigationFact {
  return {
    occurredAt: at(0),
    targetId: 'target-root',
    url: 'http://bmc.test/viewer',
    ...overrides,
  };
}

function hookFailure(overrides: Partial<ObserverHookFailure> = {}): ObserverHookFailure {
  return { hook: 'crypto', stage: 'install', detail: 'subtle is not extensible', ...overrides };
}

function renderSurface(
  overrides: Partial<PackV2RenderSurfaceRow> = {},
): PackV2RenderSurfaceRow {
  return {
    id: 'render-0001',
    occurredAt: at(2_500),
    targetId: 'target-root',
    surface: 'canvas-context',
    detail: '2d',
    ...overrides,
  };
}

function facts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    transactions: [tx({ id: 'req-1' })],
    actions: [],
    targets: [],
    channels: [],
    navigations: [],
    renderSurfaces: [],
    hookFailures: [],
    ...overrides,
  };
}

/** 完整 Viewer 活动事实：点击 → 主框架导航 → 渲染表面 → WS 双向帧。 */
function viewerActivityFacts(): WorkflowFacts {
  return facts({
    actions: [action({ id: 'action-0001', occurredAt: at(1_000) })],
    navigations: [nav({ occurredAt: at(2_000), url: 'http://bmc.test/viewer' })],
    renderSurfaces: [renderSurface()],
    channels: [channel({ id: 'ws-1', createdAt: at(3_000) })],
  });
}

describe('detectViewerActivity（§7.3 信号）', () => {
  it('点击 → 主框架导航 → 渲染表面 → WS 双向帧：一组信号', () => {
    const signals = detectViewerActivity(viewerActivityFacts());
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      actionId: 'action-0001',
      actionKind: 'click',
      openedVia: 'navigation',
      openedDetail: 'http://bmc.test/viewer',
      viewerTargetId: 'target-root',
      surfaceKind: 'canvas-context',
      surfaceAt: at(2_500),
      channelId: 'ws-1',
      channelKind: 'websocket',
    });
  });

  it('反例：无渲染/执行表面（登录后 Dashboard 后台告警 WS）→ 零信号', () => {
    const snapshot = facts({
      ...viewerActivityFacts(),
      renderSurfaces: [],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('反例：渲染表面属无关窗口 → 零信号', () => {
    const snapshot = facts({
      ...viewerActivityFacts(),
      renderSurfaces: [renderSurface({ targetId: 'target-other' })],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('反例：渲染表面晚于动作但早于 Viewer 导航 → 零信号', () => {
    const snapshot = facts({
      ...viewerActivityFacts(),
      renderSurfaces: [renderSurface({ occurredAt: at(1_500) })],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('反例：通道晚于导航但早于新渲染表面 → 零信号', () => {
    const snapshot = facts({
      ...viewerActivityFacts(),
      channels: [channel({ id: 'ws-1', createdAt: at(2_200) })],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('反例：render-surface 钩子失败 → 页面侧表面不可信，零信号；WASM 事务（CDP 观察）仍可', () => {
    const broken = facts({
      ...viewerActivityFacts(),
      hookFailures: [hookFailure({ hook: 'render-surface' })],
    });
    expect(detectViewerActivity(broken)).toHaveLength(0);
    expect(deriveWorkflowStatus(broken).viewerActivity).toBe(false);

    const wasm = facts({
      ...viewerActivityFacts(),
      renderSurfaces: [],
      transactions: [tx({ id: 'req-wasm', resourceType: 'wasm', startedAt: at(2_200) })],
      hookFailures: [hookFailure({ hook: 'render-surface' })],
    });
    const signals = detectViewerActivity(wasm);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ surfaceKind: 'wasm' });
    expect(deriveWorkflowStatus(wasm).viewerActivity).toBe(true);
  });

  it('form-submit → popup target → WebRTC 双向消息：openedVia=popup', () => {
    const signals = detectViewerActivity(
      facts({
        actions: [action({ id: 'action-0002', occurredAt: at(1_000), kind: 'form-submit' })],
        targets: [target({ id: 'target-popup', type: 'popup', openerTargetId: 'target-root', attachedAt: at(2_000) })],
        renderSurfaces: [renderSurface({ targetId: 'target-popup', occurredAt: at(2_500), surface: 'worker', detail: 'http://bmc.test/viewer-worker.js' })],
        channels: [
          channel({ id: 'rtc-1', kind: 'webrtc', createdAt: at(3_000), frameCounts: { up: 1, down: 1 } }),
        ],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      actionId: 'action-0002',
      actionKind: 'form-submit',
      openedVia: 'popup',
      openedDetail: 'target-popup',
      viewerTargetId: 'target-popup',
      surfaceKind: 'worker',
      channelId: 'rtc-1',
    });
  });

  it('只有用户动作、无导航也无 popup：零信号', () => {
    const signals = detectViewerActivity(facts({ actions: [action()] }));
    expect(signals).toHaveLength(0);
  });

  it('通道先于动作（时间倒序）：零信号', () => {
    const signals = detectViewerActivity(
      facts({
        actions: [action({ occurredAt: at(5_000) })],
        navigations: [nav({ occurredAt: at(6_000) })],
        channels: [channel({ id: 'ws-1', createdAt: at(1_000) })],
      }),
    );
    expect(signals).toHaveLength(0);
  });

  it('单向通道（WS 只有下行帧）：零信号', () => {
    const signals = detectViewerActivity(
      facts({
        actions: [action()],
        navigations: [nav()],
        channels: [channel({ id: 'ws-1', frameCounts: { up: 0, down: 5 } })],
      }),
    );
    expect(signals).toHaveLength(0);
  });

  it('WebTransport 通道在场即通道事实（payload 不可观察）', () => {
    const signals = detectViewerActivity(
      facts({
        actions: [action()],
        navigations: [nav()],
        renderSurfaces: [renderSurface({ occurredAt: at(2_500) })],
        channels: [channel({ id: 'wt-1', kind: 'webtransport', createdAt: at(3_000), frameCounts: null })],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ channelId: 'wt-1', channelKind: 'webtransport' });
  });

  it('钩子失败折扣与引擎一致：webrtc-datachannel 钩子失败 → webrtc 通道不构成', () => {
    const broken = facts({
      actions: [action()],
      navigations: [nav()],
      channels: [channel({ id: 'rtc-1', kind: 'webrtc' })],
      hookFailures: [hookFailure({ hook: 'webrtc-datachannel' })],
    });
    expect(detectViewerActivity(broken)).toHaveLength(0);
    expect(deriveWorkflowStatus(broken).viewerActivity).toBe(false);
  });

  it('action 钩子失败：用户动作事实不可信，零信号', () => {
    const broken = facts({
      ...viewerActivityFacts(),
      hookFailures: [hookFailure({ hook: 'action' })],
    });
    expect(detectViewerActivity(broken)).toHaveLength(0);
  });

  it('crypto 钩子失败不影响 WS 观察面：信号保留', () => {
    const broken = facts({
      ...viewerActivityFacts(),
      hookFailures: [hookFailure({ hook: 'crypto' })],
    });
    expect(detectViewerActivity(broken)).toHaveLength(1);
  });

  it('与 deriveWorkflowStatus.viewerActivity 结论一致（不出现两套定义）', () => {
    const cases: WorkflowFacts[] = [
      viewerActivityFacts(),
      facts({ actions: [action()], targets: [target({ id: 'tp', type: 'popup', attachedAt: at(1) })] }),
      facts({ channels: [channel({ id: 'ws-1' })] }),
      facts({ actions: [action()], navigations: [nav()] }),
      facts(),
    ];
    for (const snapshot of cases) {
      expect(detectViewerActivity(snapshot).length > 0).toBe(
        deriveWorkflowStatus(snapshot).viewerActivity,
      );
    }
  });

  it('永不抛出：畸形事实（非法时间戳 / 缺字段）返回零信号', () => {
    const malformed = {
      transactions: [],
      actions: [
        { id: 'a1', occurredAt: 'not-a-date', kind: 'click', targetId: 't', elementSummary: 'x' },
      ],
      targets: [{ id: 't1', type: 'popup', attached: true, url: null, attachedAt: 'garbage' }],
      channels: [{ id: 'c1', kind: 'websocket', createdAt: '', closedAt: null, frameCounts: null }],
      navigations: [{ occurredAt: '', targetId: '', url: null }],
      hookFailures: [],
    } as unknown as WorkflowFacts;
    expect(() => detectViewerActivity(malformed)).not.toThrow();
    expect(detectViewerActivity(malformed)).toHaveLength(0);
  });

  it('全部时间戳不可解析 → 零信号（两套实现一致，不得把 0 凑成时序）', () => {
    const snapshot = facts({
      actions: [action({ occurredAt: 'not-a-date' })],
      targets: [
        target({
          id: 'target-popup',
          type: 'popup',
          openerTargetId: 'target-root',
          attachedAt: 'garbage',
        }),
      ],
      navigations: [nav({ occurredAt: 'garbage' })],
      channels: [channel({ id: 'ws-1', createdAt: '' })],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('无关 target 的双向 WS → 零信号（通道须属血缘）', () => {
    const snapshot = facts({
      actions: [action({ occurredAt: at(1_000) })],
      navigations: [nav({ occurredAt: at(2_000) })],
      channels: [
        channel({ id: 'ws-other', createdAt: at(3_000), targetId: 'target-other' }),
      ],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('opener 无关的 popup → 零信号（另一棵 opener 子树不算血缘）', () => {
    const snapshot = facts({
      actions: [action({ occurredAt: at(1_000) })],
      targets: [
        target({
          id: 'target-unrelated-popup',
          type: 'popup',
          openerTargetId: 'target-other-window',
          attachedAt: at(2_000),
        }),
      ],
      channels: [channel({ id: 'ws-1', createdAt: at(3_000) })],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('另一窗口的导航 → 零信号（导航须属血缘）', () => {
    const snapshot = facts({
      actions: [action({ occurredAt: at(1_000) })],
      navigations: [nav({ occurredAt: at(2_000), targetId: 'target-other' })],
      channels: [channel({ id: 'ws-1', createdAt: at(3_000) })],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('action→通道→导航倒挂：通道早于打开证据 → 零信号', () => {
    const snapshot = facts({
      actions: [action({ occurredAt: at(1_000) })],
      navigations: [nav({ occurredAt: at(5_000) })],
      channels: [channel({ id: 'ws-1', createdAt: at(2_000) })],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('action.targetId 缺失 → 零信号（保守方向）', () => {
    const snapshot = facts({
      actions: [action({ occurredAt: at(1_000), targetId: '' })],
      navigations: [nav({ occurredAt: at(2_000) })],
      channels: [channel({ id: 'ws-1', createdAt: at(3_000) })],
    });
    expect(detectViewerActivity(snapshot)).toHaveLength(0);
    expect(deriveWorkflowStatus(snapshot).viewerActivity).toBe(false);
  });

  it('链式 opener 血缘的 popup 后代（popup→popup）→ 信号保持', () => {
    const chainFacts = facts({
      actions: [action({ occurredAt: at(1_000) })],
      targets: [
        target({
          id: 'target-popup-a',
          type: 'popup',
          openerTargetId: 'target-root',
          attachedAt: at(2_000),
        }),
        target({
          id: 'target-popup-b',
          type: 'popup',
          openerTargetId: 'target-popup-a',
          attachedAt: at(3_000),
        }),
      ],
      renderSurfaces: [renderSurface({ targetId: 'target-popup-b', occurredAt: at(3_500), surface: 'offscreencanvas', detail: '1280x720' })],
      channels: [
        channel({ id: 'ws-1', createdAt: at(4_000), targetId: 'target-popup-b' }),
      ],
    });
    const signals = detectViewerActivity(chainFacts);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      openedVia: 'popup',
      openedDetail: 'target-popup-a',
      surfaceKind: 'offscreencanvas',
      channelId: 'ws-1',
    });
    expect(deriveWorkflowStatus(chainFacts).viewerActivity).toBe(true);
  });
});

describe('activityFingerprint（稳定窗口重置依据）', () => {
  it('只随动作 / target / 通道 / 导航 / 渲染表面计数变化，事务增长不改变指纹', () => {
    const base = viewerActivityFacts();
    const first = activityFingerprint(base);
    expect(activityFingerprint({ ...base, transactions: [...base.transactions, tx({ id: 'req-2' })] })).toBe(
      first,
    );
    expect(
      activityFingerprint({ ...base, actions: [...base.actions, action({ id: 'action-0009' })] }),
    ).not.toBe(first);
    expect(
      activityFingerprint({ ...base, targets: [...base.targets, target({ id: 'target-x' })] }),
    ).not.toBe(first);
    expect(
      activityFingerprint({ ...base, channels: [...base.channels, channel({ id: 'ws-9' })] }),
    ).not.toBe(first);
    // 新导航重置稳定窗口（§7.4「新的关键资源」）
    expect(
      activityFingerprint({ ...base, navigations: [...base.navigations, nav()] }),
    ).not.toBe(first);
    // 新渲染表面重置稳定窗口（§7.4「新的关键资源」）
    expect(
      activityFingerprint({
        ...base,
        renderSurfaces: [...base.renderSurfaces, renderSurface({ id: 'render-0002' })],
      }),
    ).not.toBe(first);
  });
});
