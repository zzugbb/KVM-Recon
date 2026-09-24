/**
 * WebSocket 原始通道：握手元数据 + 全部双向帧（规范 §8.5）。
 * frames.bin 按到达顺序追加，释放只 close，不截断到 64 帧。
 *
 * FIN 边界：CDP 的 webSocketFrame 事件不携带 FIN 位。唯一可观察事实是
 * 「后续帧是 continuation」——即前一帧不是消息末帧。因此每帧的索引行
 * 延迟到下一帧到达时才落盘（fin = 下一帧不是 continuation）；通道关闭
 * 时补写最后一帧（fin = true，语义为「未观察到后续 continuation」）。
 * pending 帧的 payload 一并延迟写入，崩溃时 frames.bin 不会超前索引。
 *
 * 失败粘性：某 socket 的帧写入一旦失败（磁盘不足/工作区不可写），该
 * socket 后续帧全部跳过并记 channelGaps 缺口，绝不继续向已不一致的
 * bin/index 交替写入。
 */

import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PACK_V2_SCHEMA_VERSION, type PackV2ChannelRow, type PackV2WsFrameIndexRow, type PackV2WsMetadata, type WsFrameOpcode } from '../capture-pack-v2/types';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import type { CollectorEvidence } from './collectorEvidence';
import { protocolList, headerValue } from './cdpValues';

export interface OpenSocketInput {
  channelId: string;
  url: string;
  targetId: string;
  createdAt: string;
}

export interface SocketFrameInput {
  direction: 'up' | 'down';
  opcode: WsFrameOpcode;
  timestamp: string;
  payload: Uint8Array;
}

interface PendingFrame {
  direction: 'up' | 'down';
  opcode: WsFrameOpcode;
  timestamp: string;
  payload: Buffer;
}

interface SocketState {
  meta: PackV2WsMetadata;
  pending: PendingFrame | null;
  payloadOffset: number;
  frameIndex: number;
  handle: FileHandle | null;
  chain: Promise<void>;
  failed: boolean;
  closed: boolean;
}

export interface WebSocketCollector {
  open(input: OpenSocketInput): void;
  handshakeRequest(channelId: string, headers: Record<string, string>): void;
  handshakeResponse(channelId: string, status: number, headers: Record<string, string>): void;
  addFrame(channelId: string, frame: SocketFrameInput): Promise<void>;
  close(channelId: string, closedAt: string, closeCode?: number | null, closeReason?: string | null): Promise<void>;
  flush(): Promise<void>;
  /** catalog/channels.json 的通道行（kind=websocket）。 */
  channelRows(): PackV2ChannelRow[];
  /** 派生引擎只读快照：握手 URL / 请求头 / 元数据路径（value-flow 派生用）。 */
  handshakeFacts(): Array<{
    channelId: string;
    url: string;
    createdAt: string;
    requestHeaders: Record<string, string>;
    metadataPath: string;
  }>;
}

function metadataPath(dirId: string): string {
  return `raw/websocket/${dirId}/metadata.json`;
}

function indexPath(dirId: string): string {
  return `raw/websocket/${dirId}/frames.index.jsonl`;
}

function binPath(dirId: string): string {
  return `raw/websocket/${dirId}/frames.bin`;
}

export function createWebSocketCollector(
  workspace: JobWorkspace,
  evidence: CollectorEvidence,
): WebSocketCollector {
  // 原始 channelId 作身份键（保真）；落盘目录名清洗后冲突时追加序号去重
  const sockets = new Map<string, SocketState>();
  const dirIds = new Map<string, string>();
  const usedDirIds = new Set<string>();

  function dirIdFor(channelId: string): string {
    const known = dirIds.get(channelId);
    if (known) return known;
    let safe = channelId.replace(/[^A-Za-z0-9._-]+/g, '_');
    if (!safe) throw new Error(`非法 WebSocket channelId：${channelId}`);
    if (usedDirIds.has(safe)) {
      let suffix = 2;
      while (usedDirIds.has(`${safe}-${suffix}`)) suffix += 1;
      safe = `${safe}-${suffix}`;
    }
    usedDirIds.add(safe);
    dirIds.set(channelId, safe);
    return safe;
  }

  function requireSocket(channelId: string): SocketState {
    const socket = sockets.get(channelId);
    if (!socket) throw new Error(`未知 WebSocket：${channelId}`);
    return socket;
  }

  function serialize(socket: SocketState, channelId: string, run: () => Promise<void>): Promise<void> {
    const next = socket.chain.then(run, run);
    socket.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function ensureHandle(socket: SocketState): Promise<FileHandle> {
    if (socket.handle) return socket.handle;
    const absolute = join(workspace.dir, socket.meta.framesBinPath);
    await mkdir(dirname(absolute), { recursive: true });
    socket.handle = await open(absolute, 'a');
    return socket.handle;
  }

  /** 落盘 pending 帧（fin 由调用方从下一帧推导）。 */
  async function flushPending(socket: SocketState, channelId: string, fin: boolean): Promise<void> {
    const pending = socket.pending;
    if (!pending) return;
    socket.pending = null;
    if (socket.failed) return;
    const handle = await ensureHandle(socket);
    if (pending.payload.byteLength > 0) {
      await handle.write(pending.payload);
    }
    const row: PackV2WsFrameIndexRow = {
      frameIndex: socket.frameIndex,
      direction: pending.direction,
      opcode: pending.opcode,
      fin,
      timestamp: pending.timestamp,
      payloadOffset: socket.payloadOffset,
      payloadLength: pending.payload.byteLength,
    };
    socket.frameIndex += 1;
    socket.payloadOffset += pending.payload.byteLength;
    if (pending.direction === 'up') socket.meta.frameCounts.up += 1;
    else socket.meta.frameCounts.down += 1;
    await workspace.appendJsonl(indexPath(dirIdFor(channelId)), row);
  }

  async function markFailed(socket: SocketState, channelId: string, stage: string, error: unknown): Promise<void> {
    socket.failed = true;
    socket.pending = null;
    evidence.recordGap(
      'channelGaps',
      channelId,
      `帧写入失败（${stage}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  async function writeMetadata(socket: SocketState, channelId: string): Promise<void> {
    await workspace.writeArtifact(
      metadataPath(dirIdFor(channelId)),
      `${JSON.stringify(socket.meta, null, 2)}\n`,
    );
  }

  return {
    open(input) {
      const channelId = input.channelId;
      sockets.set(channelId, {
        meta: {
          schemaVersion: PACK_V2_SCHEMA_VERSION,
          channelId,
          url: input.url,
          targetId: input.targetId,
          createdAt: input.createdAt,
          closedAt: null,
          requestedSubProtocols: [],
          acceptedSubProtocol: null,
          extensions: [],
          closeCode: null,
          closeReason: null,
          handshakeStatus: 101,
          requestHeaders: {},
          responseHeaders: {},
          frameCounts: { up: 0, down: 0 },
          framesBinPath: binPath(dirIdFor(channelId)),
        },
        pending: null,
        payloadOffset: 0,
        frameIndex: 0,
        handle: null,
        chain: Promise.resolve(),
        failed: false,
        closed: false,
      });
    },
    handshakeRequest(channelId, headers) {
      const socket = requireSocket(channelId);
      socket.meta.requestHeaders = headers;
      socket.meta.requestedSubProtocols = protocolList(headers);
    },
    handshakeResponse(channelId, status, headers) {
      const socket = requireSocket(channelId);
      socket.meta.responseHeaders = headers;
      socket.meta.handshakeStatus = status;
      const accepted = headerValue(headers, 'sec-websocket-protocol');
      socket.meta.acceptedSubProtocol = accepted ?? null;
      const extensions = headerValue(headers, 'sec-websocket-extensions');
      socket.meta.extensions = extensions
        ? extensions
            .split(',')
            .map(item => item.trim())
            .filter(Boolean)
        : [];
    },
    async addFrame(channelId, frame) {
      const socket = sockets.get(channelId);
      if (!socket) throw new Error(`未知 WebSocket：${channelId}`);
      if (socket.closed) {
        evidence.recordGap('channelGaps', channelId, '关闭后到达的帧（计数保留，内容丢弃）');
        return;
      }
      if (socket.failed) {
        evidence.recordGap('channelGaps', channelId, '写失败粘性：帧丢弃');
        return;
      }
      const release = workspace.trackInFlightWrite();
      try {
        await serialize(socket, channelId, async () => {
          try {
            workspace.assertWritable();
            // FIN 后视推导：pending 帧的 fin = 本帧不是 continuation
            await flushPending(socket, channelId, frame.opcode !== 'continuation');
            socket.pending = {
              direction: frame.direction,
              opcode: frame.opcode,
              timestamp: frame.timestamp,
              payload: Buffer.from(frame.payload),
            };
          } catch (error) {
            await markFailed(socket, channelId, 'addFrame', error);
            throw error;
          }
        });
      } finally {
        release();
      }
    },
    async close(channelId, closedAt, closeCode, closeReason) {
      const socket = requireSocket(channelId);
      const release = workspace.trackInFlightWrite();
      try {
        await serialize(socket, channelId, async () => {
          socket.closed = true;
          try {
            workspace.assertWritable();
            await flushPending(socket, channelId, true);
          } catch (error) {
            await markFailed(socket, channelId, 'close', error);
          }
          socket.meta.closedAt = closedAt;
          if (closeCode !== undefined) socket.meta.closeCode = closeCode;
          if (closeReason !== undefined) socket.meta.closeReason = closeReason;
          try {
            await writeMetadata(socket, channelId);
          } catch (error) {
            evidence.recordGap(
              'channelGaps',
              channelId,
              `metadata 写入失败：${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        });
      } finally {
        release();
      }
    },
    async flush() {
      // 逐 socket best-effort：任一 socket 失败记 channelGaps 后继续其余
      // socket（pending 帧 + metadata 不被牵连丢失）；首个错误仍抛给调用方
      // （stop 序列里由 safeStep 记账），不静默吞掉。
      let firstError: unknown;
      let failed = false;
      for (const [channelId, socket] of sockets.entries()) {
        const release = workspace.trackInFlightWrite();
        try {
          await serialize(socket, channelId, async () => {
            socket.closed = true;
            try {
              await flushPending(socket, channelId, true);
            } catch (error) {
              await markFailed(socket, channelId, 'flush', error);
            }
            if (socket.handle) {
              await socket.handle.sync();
              await socket.handle.close();
              socket.handle = null;
            }
            await writeMetadata(socket, channelId);
          });
        } catch (error) {
          if (!failed) {
            firstError = error;
            failed = true;
          }
          evidence.recordGap(
            'channelGaps',
            channelId,
            `flush 失败（帧/元数据可能不完整）：${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          release();
        }
      }
      if (failed) throw firstError;
    },
    channelRows() {
      return [...sockets.values()].map(socket => ({
        id: socket.meta.channelId,
        kind: 'websocket' as const,
        url: socket.meta.url,
        targetId: socket.meta.targetId,
        createdAt: socket.meta.createdAt,
        closedAt: socket.meta.closedAt,
        frameCounts: socket.failed ? null : { ...socket.meta.frameCounts },
        payloadPath: socket.meta.framesBinPath,
      }));
    },
    handshakeFacts() {
      return [...sockets.values()].map(socket => ({
        channelId: socket.meta.channelId,
        url: socket.meta.url,
        createdAt: socket.meta.createdAt,
        requestHeaders: { ...socket.meta.requestHeaders },
        metadataPath: metadataPath(dirIdFor(socket.meta.channelId)),
      }));
    },
  };
}
