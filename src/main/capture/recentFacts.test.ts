import { describe, expect, it } from 'vitest';

import { MAX_RECENT_FACTS, recentFactsOf } from './recentFacts';
import type { WorkflowFacts } from '../../core/collector/workflowStatusEngine';
import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2RenderSurfaceRow,
  PackV2TargetRow,
} from '../../core/capture-pack-v2/types';

/**
 * 规范 §5.2「最近事实」：非敏感摘要、时间序、上限截断只影响展示。
 * 反例先行：URL query 里的会话 token 绝不进入摘要文本。
 */

function factsOf(partial: Partial<WorkflowFacts>): WorkflowFacts {
  return {
    transactions: [],
    actions: partial.actions ?? [],
    targets: partial.targets ?? [],
    channels: partial.channels ?? [],
    navigations: partial.navigations ?? [],
    renderSurfaces: partial.renderSurfaces ?? [],
    hookFailures: [],
  };
}

describe('recentFactsOf（最近事实摘要）', () => {
  it('归并各维度并按时间排序，输出稳定 ID 与类型', () => {
    const target: PackV2TargetRow = {
      id: 'target-page-0001',
      type: 'page',
      attached: true,
      url: 'https://10.10.8.111/',
      attachedAt: '2026-09-23T10:00:01.000Z',
    };
    const channel: PackV2ChannelRow = {
      id: 'ws-0001',
      kind: 'websocket',
      url: 'wss://10.10.8.111/stream',
      targetId: 'target-page-0001',
      createdAt: '2026-09-23T10:00:03.000Z',
      closedAt: null,
      payloadPath: null,
    };
    const action: PackV2BrowserActionRow = {
      id: 'action-0001',
      occurredAt: '2026-09-23T10:00:02.000Z',
      kind: 'click',
      targetId: 'target-page-0001',
      elementSummary: '#open-kvm',
    };
    const facts = factsOf({ targets: [target], channels: [channel], actions: [action] });
    const entries = recentFactsOf(facts);
    expect(entries.map(entry => entry.kind)).toEqual([
      'target-attached',
      'user-action',
      'channel-opened',
    ]);
    expect(entries[0].text).toContain('target-page-0001');
    expect(entries[2].text).toContain('ws-0001');
    expect(entries[2].text).toContain('wss://10.10.8.111/stream');
  });

  it('反例：URL query/fragment 里的 token 绝不进入摘要文本', () => {
    const channel: PackV2ChannelRow = {
      id: 'ws-0001',
      kind: 'websocket',
      url: 'wss://10.10.8.111/stream?viewerToken=SECRET-TOKEN&sid=abc',
      targetId: null,
      createdAt: '2026-09-23T10:00:03.000Z',
      closedAt: null,
      payloadPath: null,
    };
    const entries = recentFactsOf(factsOf({ channels: [channel] }));
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain('wss://10.10.8.111/stream');
    expect(entries[0].text).not.toContain('SECRET-TOKEN');
    expect(entries[0].text).not.toContain('?');
  });

  it('反例：URL 无法解析时只显示 ID，不显示原始串', () => {
    const channel: PackV2ChannelRow = {
      id: 'ws-0002',
      kind: 'websocket',
      url: 'not a url %%%',
      targetId: null,
      createdAt: '2026-09-23T10:00:03.000Z',
      closedAt: null,
      payloadPath: null,
    };
    const entries = recentFactsOf(factsOf({ channels: [channel] }));
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('通道开启（websocket）：ws-0002');
  });

  it('没有 attachedAt 的 target 不产生条目（不知道挂载时刻就不编造时间）', () => {
    const target: PackV2TargetRow = {
      id: 'target-page-0002',
      type: 'page',
      attached: true,
      url: null,
    };
    expect(recentFactsOf(factsOf({ targets: [target] })).some(entry => entry.text.includes('target-page-0002'))).toBe(false);
  });

  it('超过上限时保留最新条目（截断只影响展示）', () => {
    const surfaces: PackV2RenderSurfaceRow[] = Array.from({ length: MAX_RECENT_FACTS + 10 }, (_, index) => ({
      id: `render-${String(index).padStart(4, '0')}`,
      occurredAt: new Date(Date.UTC(2026, 8, 23, 10, 0, index)).toISOString(),
      targetId: 'target-page-0001',
      surface: 'canvas',
      detail: null,
    }));
    const entries = recentFactsOf(factsOf({ renderSurfaces: surfaces }));
    expect(entries).toHaveLength(MAX_RECENT_FACTS);
    expect(entries[0].text).toContain('render-0010');
    expect(entries[MAX_RECENT_FACTS - 1].text).toContain('render-0039');
  });
});
