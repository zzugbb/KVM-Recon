/**
 * 非 WS 实时通道采集（规范 §8.5）：WebRTC / WebTransport / SSE 生命周期行
 * 与消息正文（BodyStore raw/realtime/bodies）、浏览器下载行
 * （raw/realtime/downloads.jsonl + raw/realtime/downloads）。
 *
 * WebTransport 入站流 / datagram 读走即消费，tee 会改变页面行为，因此
 * 只落生命周期行，并对每个 transport 显式记 unsupportedChannels 缺口；
 * 不假装 payload 已采集。
 */

import { createBodyStore } from '../body-store/createBodyStore';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import {
  type PackV2BodyRef,
  type PackV2ChannelRow,
  type PackV2DownloadRow,
  type PackV2SseEventRow,
  type PackV2WebRtcEventRow,
  type PackV2WebTransportEventRow,
  type SseLifecycleKind,
  type WebRtcEventKind,
  type WebTransportEventKind,
} from '../capture-pack-v2/types';
import type { CollectorEvidence } from './collectorEvidence';
import { isRecord, optionalNumber, optionalString, stringValue } from './cdpValues';

const WEBRTC_PATH = 'raw/realtime/webrtc.jsonl';
const WEBTRANSPORT_PATH = 'raw/realtime/webtransport.jsonl';
const SSE_PATH = 'raw/realtime/sse.jsonl';
const DOWNLOADS_PATH = 'raw/realtime/downloads.jsonl';
const BODIES_NAMESPACE = 'raw/realtime/bodies';
const DOWNLOADS_NAMESPACE = 'raw/realtime/downloads';

const WEBRTC_KINDS = new Set<WebRtcEventKind>([
  'peer-connection-created',
  'offer',
  'answer',
  'ice-candidate',
  'dtls-fingerprint',
  'stats',
  'datachannel-opened',
  'datachannel-closed',
  'datachannel-message',
  'other',
]);

const WEBTRANSPORT_KINDS = new Set<WebTransportEventKind>([
  'created',
  'connected',
  'closed',
  'stream-opened',
  'stream-message',
  'datagram',
  'other',
]);

const SSE_KINDS = new Set<SseLifecycleKind>(['connected', 'event', 'error', 'closed']);

export interface RealtimeObserverKinds {
  webrtc: 'webrtc';
  webtransport: 'webtransport';
  sse: 'sse';
}

export interface RealtimeCollector {
  /** 观察脚本 binding 事件（attach 层已按 kind 路由）。 */
  recordObserverEvent(
    kind: 'webrtc' | 'webtransport' | 'sse',
    payload: Record<string, unknown>,
    targetId: string,
    occurredAt: string,
  ): Promise<void>;
  recordDownloadStart(input: {
    id: string;
    url: string;
    targetId: string;
    occurredAt: string;
    suggestedFileName?: string;
    mimeType?: string;
  }): Promise<void>;
  patchDownload(
    id: string,
    patch: {
      completed?: boolean;
      occurredAt?: string;
      suggestedFileName?: string;
      mimeType?: string;
      fileRef?: PackV2BodyRef;
    },
  ): Promise<void>;
  /** 下载文件内容落盘（调用方已接管下载重定向时）。 */
  storeDownloadFile(bytes: Uint8Array): Promise<PackV2BodyRef>;
  /** catalog/channels.json 的通道行（webrtc / webtransport / sse / download）。 */
  channelRows(): PackV2ChannelRow[];
}

interface WebRtcChannelState {
  targetId: string;
  createdAt: string;
  closedAt: string | null;
  up: number;
  down: number;
}

interface WebTransportChannelState {
  targetId: string;
  url: string;
  createdAt: string;
  closedAt: string | null;
}

interface SseChannelState {
  targetId: string;
  url: string;
  createdAt: string;
  closedAt: string | null;
  down: number;
}

function directionOf(value: unknown): 'up' | 'down' | undefined {
  return value === 'up' || value === 'down' ? value : undefined;
}

function decodeB64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

export function createRealtimeCollector(
  workspace: JobWorkspace,
  evidence: CollectorEvidence,
): RealtimeCollector {
  const bodies = createBodyStore({ workspace, namespace: BODIES_NAMESPACE });
  const downloadBodies = createBodyStore({ workspace, namespace: DOWNLOADS_NAMESPACE });
  const webRtcChannels = new Map<string, WebRtcChannelState>();
  const webTransportChannels = new Map<string, WebTransportChannelState>();
  const sseChannels = new Map<string, SseChannelState>();
  const downloads = new Map<string, PackV2DownloadRow>();
  const webTransportGapRecorded = new Set<string>();

  async function storeBody(bytes: Buffer): Promise<PackV2BodyRef> {
    const writer = await bodies.openWriter();
    try {
      await writer.write(bytes);
      return await writer.finish();
    } catch (error) {
      // 捕获实时消息落盘失败：磁盘不足或工作区不可写
      // 策略：abort 临时文件后抛出，由调用方记缺口
      try {
        await writer.abort();
      } catch (abortError) {
        void abortError;
      }
      throw error;
    }
  }

  /** journal 行写入失败持久作证（journalWriteFailures），丢失不只留进程内计数。 */
  async function appendJournalRow(
    path: string,
    gapId: string,
    describe: string,
    row: object,
  ): Promise<void> {
    try {
      await workspace.appendJsonl(path, row);
    } catch (error) {
      evidence.recordGap(
        'journalWriteFailures',
        gapId,
        `${describe}写入失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async function recordWebRtc(payload: Record<string, unknown>, targetId: string, occurredAt: string): Promise<void> {
    const peerConnectionId = stringValue(payload.pcId) || 'pc-unknown';
    let channel = webRtcChannels.get(peerConnectionId);
    if (!channel) {
      channel = { targetId, createdAt: occurredAt, closedAt: null, up: 0, down: 0 };
      webRtcChannels.set(peerConnectionId, channel);
    }
    const kindRaw = stringValue(payload.eventKind) as WebRtcEventKind;
    const kind = WEBRTC_KINDS.has(kindRaw) ? kindRaw : 'other';
    const detail = isRecord(payload.detail) ? payload.detail : undefined;
    if (kind === 'other' && detail && detail.closed === true && !channel.closedAt) {
      channel.closedAt = occurredAt;
    }
    const row: PackV2WebRtcEventRow = {
      occurredAt,
      targetId,
      peerConnectionId,
      kind,
    };
    const direction = directionOf(payload.direction);
    if (direction) row.direction = direction;
    const dataChannelId = optionalString(payload.dataChannelId);
    if (dataChannelId) row.dataChannelId = dataChannelId;
    const messageIndex = optionalNumber(payload.messageIndex);
    if (messageIndex !== undefined) row.messageIndex = messageIndex;
    if (kind === 'datachannel-message') {
      row.fin = payload.fin === false ? false : true;
      const bytes = decodeB64(payload.messageB64);
      if (bytes) {
        row.messageRef = await storeBody(bytes);
      }
      if (direction === 'up') channel.up += 1;
      else if (direction === 'down') channel.down += 1;
    }
    if (detail) row.detail = detail;
    await appendJournalRow(WEBRTC_PATH, peerConnectionId, 'WebRTC 事件行', row);
  }

  async function recordWebTransport(
    payload: Record<string, unknown>,
    targetId: string,
    occurredAt: string,
  ): Promise<void> {
    const transportId = stringValue(payload.wtId) || 'wt-unknown';
    let channel = webTransportChannels.get(transportId);
    if (!channel) {
      channel = {
        targetId,
        url: stringValue(payload.url) || '',
        createdAt: occurredAt,
        closedAt: null,
      };
      webTransportChannels.set(transportId, channel);
    }
    if (!webTransportGapRecorded.has(transportId)) {
      webTransportGapRecorded.add(transportId);
      // 入站流 / datagram 读取即消费，tee 改变页面行为（规范 §8.5 / §2.2）
      evidence.recordGap(
        'unsupportedChannels',
        transportId,
        `WebTransport payload 不可观察（读取流会改变页面行为），仅记录生命周期（url=${channel.url}）`,
      );
    }
    const kindRaw = stringValue(payload.eventKind) as WebTransportEventKind;
    const kind = WEBTRANSPORT_KINDS.has(kindRaw) ? kindRaw : 'other';
    if (kind === 'closed' && !channel.closedAt) channel.closedAt = occurredAt;
    const row: PackV2WebTransportEventRow = {
      occurredAt,
      targetId,
      transportId,
      kind,
    };
    const direction = directionOf(payload.direction);
    if (direction) row.direction = direction;
    const streamId = optionalString(payload.streamId);
    if (streamId) row.streamId = streamId;
    const detail = isRecord(payload.detail) ? payload.detail : undefined;
    if (detail) row.detail = detail;
    await appendJournalRow(WEBTRANSPORT_PATH, transportId, 'WebTransport 事件行', row);
  }

  async function recordSse(payload: Record<string, unknown>, targetId: string, occurredAt: string): Promise<void> {
    const sseId = stringValue(payload.sseId) || 'sse-unknown';
    const url = stringValue(payload.url);
    let channel = sseChannels.get(sseId);
    if (!channel) {
      channel = { targetId, url, createdAt: occurredAt, closedAt: null, down: 0 };
      sseChannels.set(sseId, channel);
    }
    const kindRaw = stringValue(payload.eventKind) as SseLifecycleKind;
    if (!SSE_KINDS.has(kindRaw)) {
      // 页面可任意调用 binding：未知 kind 丢弃并记账，
      // 不伪造成生命周期事件（映射成 closed 会在目录里误关通道）
      evidence.droppedEvent('sse-observer', new Error(`SSE 事件 kind 未知：${kindRaw || '(empty)'}`));
      return;
    }
    const kind = kindRaw;
    if (kind === 'closed' && !channel.closedAt) channel.closedAt = occurredAt;
    const row: PackV2SseEventRow = {
      id: sseId,
      occurredAt,
      targetId,
      url,
      kind,
    };
    const event = optionalString(payload.event);
    if (event) row.event = event;
    const serverEventId = optionalString(payload.serverEventId);
    if (serverEventId) row.serverEventId = serverEventId;
    const retryMs = optionalNumber(payload.retryMs);
    if (retryMs !== undefined) row.retryMs = retryMs;
    if (kind === 'event') {
      const bytes = decodeB64(payload.dataB64);
      if (bytes) {
        row.dataRef = await storeBody(bytes);
      }
      channel.down += 1;
    }
    await appendJournalRow(SSE_PATH, sseId, 'SSE 事件行', row);
  }

  return {
    async recordObserverEvent(kind, payload, targetId, occurredAt) {
      if (kind === 'webrtc') return recordWebRtc(payload, targetId, occurredAt);
      if (kind === 'webtransport') return recordWebTransport(payload, targetId, occurredAt);
      return recordSse(payload, targetId, occurredAt);
    },
    async recordDownloadStart(input) {
      const row: PackV2DownloadRow = {
        id: input.id,
        occurredAt: input.occurredAt,
        targetId: input.targetId,
        url: input.url,
        suggestedFileName: input.suggestedFileName,
        mimeType: input.mimeType,
        completed: false,
      };
      downloads.set(input.id, row);
      await appendJournalRow(DOWNLOADS_PATH, input.id, '下载开始行', row);
    },
    async patchDownload(id, patch) {
      const row = downloads.get(id);
      if (!row) {
        evidence.recordGap('channelGaps', id, '下载进度事件缺少对应的 downloadWillBegin 行');
        return;
      }
      if (patch.completed !== undefined) row.completed = patch.completed;
      if (patch.suggestedFileName !== undefined) row.suggestedFileName = patch.suggestedFileName;
      if (patch.mimeType !== undefined) row.mimeType = patch.mimeType;
      if (patch.fileRef !== undefined) row.fileRef = patch.fileRef;
      await appendJournalRow(DOWNLOADS_PATH, id, '下载进度行', row);
    },
    async storeDownloadFile(bytes) {
      const writer = await downloadBodies.openWriter();
      try {
        await writer.write(bytes);
        return await writer.finish();
      } catch (error) {
        // 捕获下载文件落盘失败：abort 后抛出，由调用方记缺口
        try {
          await writer.abort();
        } catch (abortError) {
          void abortError;
        }
        throw error;
      }
    },
    channelRows() {
      const rows: PackV2ChannelRow[] = [];
      for (const [id, channel] of webRtcChannels) {
        rows.push({
          id,
          kind: 'webrtc',
          url: null,
          targetId: channel.targetId,
          createdAt: channel.createdAt,
          closedAt: channel.closedAt,
          frameCounts: { up: channel.up, down: channel.down },
          payloadPath: null,
        });
      }
      for (const [id, channel] of webTransportChannels) {
        rows.push({
          id,
          kind: 'webtransport',
          url: channel.url || null,
          targetId: channel.targetId,
          createdAt: channel.createdAt,
          closedAt: channel.closedAt,
          frameCounts: null,
          payloadPath: null,
        });
      }
      for (const [id, channel] of sseChannels) {
        rows.push({
          id,
          kind: 'sse',
          url: channel.url || null,
          targetId: channel.targetId,
          createdAt: channel.createdAt,
          closedAt: channel.closedAt,
          frameCounts: { up: 0, down: channel.down },
          payloadPath: null,
        });
      }
      for (const [id, row] of downloads) {
        rows.push({
          id,
          kind: 'download',
          url: row.url,
          targetId: row.targetId,
          createdAt: row.occurredAt,
          closedAt: row.completed ? row.occurredAt : null,
          frameCounts: null,
          payloadPath: row.fileRef?.path ?? null,
        });
      }
      return rows;
    },
  };
}
