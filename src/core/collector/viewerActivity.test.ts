/**
 * 阶段 3 第 3 刀：Viewer 活动识别纯模块反例集（规范 §7.3 / §7.4）。
 *
 * 信号规则与 workflowStatusEngine 的 KVM_REACHED 派生保持同一事实组合：
 * 用户动作（click / form-submit）之后出现 popup target 或主框架导航，
 * 且之后建立持续双向通道（WS 双向帧 / WebRTC 双向消息 / WebTransport 在场）。
 * 反例约束：
 * - 与 deriveWorkflowStatus 的 viewerActivity 结论必须一致（不出现两套定义）；
 * - 钩子失败折扣同引擎（对应观察面不可信）；
 * - 永不抛出：畸形事实返回零信号，不抛异常；
 * - activityFingerprint 只看动作 / target / 通道计数（新事实才重置稳定窗口）。
 */

import { describe, expect, it } from 'vitest';

import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2HttpTransactionRow,
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

function facts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    transactions: [tx({ id: 'req-1' })],
    actions: [],
    targets: [],
    channels: [],
    navigations: [],
    hookFailures: [],
    ...overrides,
  };
}

/** 完整 Viewer 活动事实：点击 → 主框架导航 → WS 双向帧。 */
function viewerActivityFacts(): WorkflowFacts {
  return facts({
    actions: [action({ id: 'action-0001', occurredAt: at(1_000) })],
    navigations: [nav({ occurredAt: at(2_000), url: 'http://bmc.test/viewer' })],
    channels: [channel({ id: 'ws-1', createdAt: at(3_000) })],
  });
}

describe('detectViewerActivity（§7.3 信号）', () => {
  it('点击 → 主框架导航 → WS 双向帧：一组信号', () => {
    const signals = detectViewerActivity(viewerActivityFacts());
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      actionId: 'action-0001',
      actionKind: 'click',
      openedVia: 'navigation',
      openedDetail: 'http://bmc.test/viewer',
      channelId: 'ws-1',
      channelKind: 'websocket',
    });
  });

  it('form-submit → popup target → WebRTC 双向消息：openedVia=popup', () => {
    const signals = detectViewerActivity(
      facts({
        actions: [action({ id: 'action-0002', occurredAt: at(1_000), kind: 'form-submit' })],
        targets: [target({ id: 'target-popup', type: 'popup', attachedAt: at(2_000) })],
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
        channels: [channel({ id: 'wt-1', kind: 'webtransport', frameCounts: null })],
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
});

describe('activityFingerprint（稳定窗口重置依据）', () => {
  it('只随动作 / target / 通道计数变化，事务增长不改变指纹', () => {
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
  });
});
