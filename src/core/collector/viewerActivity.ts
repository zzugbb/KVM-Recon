/**
 * Viewer 活动识别纯模块（规范 §7.3，阶段 3 第 3 刀）。
 *
 * 从 WorkflowFacts 识别 Viewer 活动组合信号：用户动作（click / form-submit）
 * 之后出现 popup target 或主框架导航，且之后建立持续双向通道。与
 * workflowStatusEngine 的 KVM_REACHED 派生共用同一事实组合与钩子失败折扣，
 * 不出现两套定义（单测以 deriveWorkflowStatus.viewerActivity 对照）。
 *
 * 纯函数、永不抛出：畸形事实按保守缺失处理，不构成信号。
 * 信号供自动收尾（§7.4）与诊断展示使用；识别失败不影响采集。
 */

import type { PackV2ChannelRow } from '../capture-pack-v2/types';
import { timeOf, type WorkflowFacts } from './workflowStatusEngine';

/** 一组被观察到的 Viewer 活动组合（§7.3）。 */
export interface ViewerActivitySignal {
  /** 触发组合的用户动作行 id。 */
  actionId: string;
  actionKind: string;
  actionAt: string;
  /** 动作后的目标打开证据：popup target 或主框架导航。 */
  openedVia: 'popup' | 'navigation';
  /** popup target id（openedVia=popup）或导航 URL（openedVia=navigation）。 */
  openedDetail: string;
  /** 动作后建立的持续双向通道 id。 */
  channelId: string;
  channelKind: string;
  channelCreatedAt: string;
}

function isBidirectionalChannel(
  channel: PackV2ChannelRow,
  brokenHooks: ReadonlySet<string>,
): boolean {
  if (channel.kind === 'websocket') {
    // WS 走 CDP Network 域观察，不受页面观察脚本钩子影响
    return !!channel.frameCounts && channel.frameCounts.up > 0 && channel.frameCounts.down > 0;
  }
  if (channel.kind === 'webrtc') {
    if (brokenHooks.has('webrtc') || brokenHooks.has('webrtc-datachannel')) return false;
    return !!channel.frameCounts && channel.frameCounts.up > 0 && channel.frameCounts.down > 0;
  }
  if (channel.kind === 'webtransport') {
    if (brokenHooks.has('webtransport')) return false;
    // 入站流读取即消费（规范 §8.5）：payload 不可观察，通道在场即事实
    return true;
  }
  return false;
}

/**
 * 识别 Viewer 活动信号（每组动作一条：取最早的合格打开证据与最早的合格通道）。
 * 永不抛出：字段缺失 / 时间不可解析按保守处理，不构成信号。
 */
export function detectViewerActivity(facts: WorkflowFacts): ViewerActivitySignal[] {
  const brokenHooks = new Set(facts.hookFailures.map(failure => failure.hook));
  // 钩子失败记账溢出（*）或动作观察面失败：用户动作事实不可信
  if (brokenHooks.has('*') || brokenHooks.has('action')) return [];
  const signals: ViewerActivitySignal[] = [];
  for (const action of facts.actions) {
    if (action.kind !== 'click' && action.kind !== 'form-submit') continue;
    const actionAt = timeOf(action.occurredAt);
    if (!actionAt) continue;

    let openedVia: 'popup' | 'navigation' | null = null;
    let openedDetail = '';
    let openedAt = Number.POSITIVE_INFINITY;
    for (const target of facts.targets) {
      if (target.type !== 'popup' || target.attachedAt === undefined) continue;
      const at = timeOf(target.attachedAt);
      if (at < actionAt || at >= openedAt) continue;
      openedVia = 'popup';
      openedDetail = target.id;
      openedAt = at;
    }
    for (const navigation of facts.navigations) {
      const at = timeOf(navigation.occurredAt);
      if (at < actionAt || at > openedAt) continue;
      openedVia = 'navigation';
      openedDetail = navigation.url ?? '';
      openedAt = at;
    }
    if (!openedVia) continue;

    let channel: PackV2ChannelRow | null = null;
    let channelAt = Number.POSITIVE_INFINITY;
    for (const candidate of facts.channels) {
      const at = timeOf(candidate.createdAt);
      if (at < actionAt || at > channelAt) continue;
      if (!isBidirectionalChannel(candidate, brokenHooks)) continue;
      channel = candidate;
      channelAt = at;
    }
    if (!channel) continue;

    signals.push({
      actionId: action.id,
      actionKind: action.kind,
      actionAt: action.occurredAt,
      openedVia,
      openedDetail,
      channelId: channel.id,
      channelKind: channel.kind,
      channelCreatedAt: channel.createdAt,
    });
  }
  return signals;
}

/**
 * 活动指纹（§7.4 稳定窗口重置依据）：动作 / target / 通道计数。
 * 新 target、通道或用户动作出现 → 指纹变化 → 稳定窗口重置；
 * 事务行增长（后台轮询流量）不重置窗口。
 */
export function activityFingerprint(facts: WorkflowFacts): string {
  return `${facts.actions.length}/${facts.targets.length}/${facts.channels.length}`;
}
