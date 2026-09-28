/**
 * 最近事实摘要（规范 §5.2「最近事实」：只展示非敏感摘要，不承担原始数据存储）。
 *
 * 从采集会话的只读事实快照归并出时间序的短行 feed：稳定 ID + 类型 + URL 的
 * origin。URL 的 path/query/fragment 都可能携带会话值，最近事实不展示；
 * 原始 URL 仍在包内。所有摘要字段均设展示上限，避免状态 IPC 被页面值撑大。
 */

import type {
  WorkflowFacts,
  WorkflowNavigationFact,
} from '../../core/collector/workflowStatusEngine';
import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2RenderSurfaceRow,
  PackV2TargetRow,
} from '../../core/capture-pack-v2/types';

export type RecentFactKind =
  | 'target-attached'
  | 'channel-opened'
  | 'user-action'
  | 'navigation'
  | 'render-surface';

export interface RecentFactEntry {
  occurredAt: string;
  kind: RecentFactKind;
  text: string;
}

/** 界面 feed 上限：超出部分丢弃最旧条目（截断只影响展示，原始事实在包内）。 */
export const MAX_RECENT_FACTS = 30;

function short(value: string, limit = 80): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** URL 只保留 origin；路径也可能直接包含会话 token。 */
function safeUrlText(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return short(parsed.origin, 160);
  } catch {
    return '';
  }
}

function targetEntry(target: PackV2TargetRow): RecentFactEntry | null {
  if (!target.attachedAt) return null;
  return {
    occurredAt: target.attachedAt,
    kind: 'target-attached',
    text: `target 挂载（${short(target.type)}）：${short(target.id)}`,
  };
}

function channelEntry(channel: PackV2ChannelRow): RecentFactEntry {
  const url = safeUrlText(channel.url);
  return {
    occurredAt: channel.createdAt,
    kind: 'channel-opened',
    text: `通道开启（${short(channel.kind)}）：${short(channel.id)}${url ? ` → ${url}` : ''}`,
  };
}

function actionEntry(action: PackV2BrowserActionRow): RecentFactEntry {
  return {
    occurredAt: action.occurredAt,
    kind: 'user-action',
    // 页面元素摘要来自设备 DOM，可能包含敏感文字；最近事实只显示稳定索引。
    text: `用户动作（${short(action.kind)}）：${short(action.id)}`,
  };
}

function navigationEntry(navigation: WorkflowNavigationFact): RecentFactEntry {
  const url = safeUrlText(navigation.url);
  return {
    occurredAt: navigation.occurredAt,
    kind: 'navigation',
    text: `主框架导航：${short(navigation.targetId)}${url ? ` → ${url}` : ''}`,
  };
}

function renderSurfaceEntry(surface: PackV2RenderSurfaceRow): RecentFactEntry {
  return {
    occurredAt: surface.occurredAt,
    kind: 'render-surface',
    text: `新渲染表面（${short(surface.surface)}）：${short(surface.id)}`,
  };
}

export function recentFactsOf(facts: WorkflowFacts): RecentFactEntry[] {
  const entries: RecentFactEntry[] = [];
  for (const target of facts.targets) {
    const entry = targetEntry(target);
    if (entry) entries.push(entry);
  }
  for (const channel of facts.channels) {
    entries.push(channelEntry(channel));
  }
  for (const action of facts.actions) {
    entries.push(actionEntry(action));
  }
  for (const navigation of facts.navigations) {
    entries.push(navigationEntry(navigation));
  }
  for (const surface of facts.renderSurfaces) {
    entries.push(renderSurfaceEntry(surface));
  }
  entries.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  return entries.slice(-MAX_RECENT_FACTS);
}
