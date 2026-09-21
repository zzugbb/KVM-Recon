import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { createMockKvmServer, type MockKvmHandle, type MockKvmUrlSet } from '../mock-kvm/createMockKvmServer';
import { buildPackV2FileName } from './buildPackV2FileName';
import { incompleteReasonInfo } from './incompleteReasons';
import {
  classificationStatusFromKvmFamilyDetection,
  derivePackIntegrity,
} from './packStatus';
import {
  validatePackV2Consistency,
  type PackV2ConsistencyProblemCode,
} from './packV2Consistency';
import { buildPackV2ReportHtml, buildPackV2StartHereMarkdown } from './packV2Layout';
import { scoreCapturedKvmFamily } from '../signatures/detectKvmFamily';
import { harContentOf, harEntry, harPostDataOf, headerOf } from '../collector/harBuilder';
import type {
  AdapterDossierStep,
  PackV2AdapterDossier,
  PackV2AiIndex,
  PackV2BodyRef,
  PackV2BrowserActionRow,
  PackV2BrowserConsoleRow,
  PackV2BrowserStorageFile,
  PackV2BrowserTimelineRow,
  PackV2CdpCommandRow,
  PackV2CdpEventRow,
  PackV2ChannelRow,
  PackV2ChannelsFile,
  PackV2CryptoCallRow,
  PackV2HttpTransactionRow,
  PackV2Integrity,
  PackV2Manifest,
  PackV2NetLogFile,
  PackV2RelationRow,
  PackV2ReplayChannelsFile,
  PackV2ReplayManifest,
  PackV2ReplayRequestRow,
  PackV2ResourceRow,
  PackV2ScriptEntry,
  PackV2ScriptsIndex,
  PackV2TargetRow,
  PackV2TargetsFile,
  PackV2ValueFlow,
  PackV2WsFrameIndexRow,
  PackV2WsMetadata,
  ValueFlowEdge,
  ValueFlowNode,
} from './types';
import { UNTRUSTED_PAGE_CONTENT_MARKER } from './types';

/**
 * Capture Pack 2.0 样例包生成器（规范 §19 阶段 0）。
 *
 * 由固定 seed 的随机 URL Mock KVM 实际驱动（fetch + WebSocket）生成，
 * 展示 §11 全部必需文件与「COMPLETE + KVM_REACHED + UNKNOWN」验收场景
 * （规范 §20）：协议完全未知，但资料完整，可离场适配。
 *
 * 固定 seed 时输出逐字节确定：URL 归一化到固定 authority，时间戳为
 * 逻辑时钟（startedAt + 递增偏移），不依赖真实端口与系统时区。
 */

const SAMPLE_SEED = 'kvm-recon-v2-sample';
const SAMPLE_STARTED_AT = '2026-09-18T14:35:22+08:00';
const SAMPLE_CANONICAL_HOST = '127.0.0.1';
const SAMPLE_CANONICAL_PORT = 48080;
const SAMPLE_HTTP_BASE = `http://${SAMPLE_CANONICAL_HOST}:${SAMPLE_CANONICAL_PORT}`;
const SAMPLE_WS_BASE = `ws://${SAMPLE_CANONICAL_HOST}:${SAMPLE_CANONICAL_PORT}`;
const SAMPLE_DEVICE_LABEL = '样例设备 / 未知厂商';

export interface SampleCapturePackV2Options {
  seed?: string;
  startedAt?: string;
}

export interface SampleArtifact {
  path: string;
  content: string | Uint8Array;
}

export interface SampleCapturePackV2Result {
  fileName: string;
  manifest: PackV2Manifest;
  integrity: PackV2Integrity;
  aiIndex: PackV2AiIndex;
  urls: MockKvmUrlSet;
  artifacts: SampleArtifact[];
}

function sha256Hex(content: string | Uint8Array): string {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return createHash('sha256').update(data).digest('hex');
}

function isoAt(baseStartedAt: string, offsetSeconds: number): string {
  const match = baseStartedAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/);
  if (!match) {
    throw new Error(`样例 startedAt 必须是带时区偏移的 ISO 时间：${baseStartedAt}`);
  }
  const [, year, month, day, hour, minute, second, offset] = match;
  const epoch = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const shifted = new Date(epoch + offsetSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${offset}`
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** 1x1 RGBA PNG（占位样例截图；真实画面由阶段 2 采集器生成）。 */
function sampleViewerPng(rgba: [number, number, number, number]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(Buffer.from([0x00, ...rgba]));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idat),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function jsonl(rows: ReadonlyArray<unknown>): string {
  if (rows.length === 0) return '';
  return `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
}

function json2(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

interface DrivenHttpExchange {
  id: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestContentType: string | null;
  requestBody: string | null;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  kind: PackV2ResourceRow['kind'];
  targetId: string;
  atSeconds: number;
}

async function driveMockKvm(handle: MockKvmHandle): Promise<{
  exchanges: DrivenHttpExchange[];
  wsMessages: Array<{ direction: 'up' | 'down'; opcode: 'text' | 'binary'; payload: Uint8Array }>;
  cryptoCalls: Array<{ input: string; output: string; atSeconds: number }>;
  /** 登录响应 Set-Cookie 建立的会话 Cookie（name=value 形式）。 */
  sessionCookie: string;
  /** 登录响应 csrfToken（启动请求 CSRF 头的实际值）。 */
  csrfToken: string;
  /** KVM 启动响应的 viewerToken（WS 握手查询参数 t 的实际值）。 */
  viewerToken: string;
}> {
  const exchanges: DrivenHttpExchange[] = [];
  let clock = 0;
  const nextClock = () => {
    clock += 1;
    return clock;
  };

  const record = async (input: {
    id: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
    kind: DrivenHttpExchange['kind'];
  }): Promise<DrivenHttpExchange> => {
    const response = await fetch(input.url, {
      method: input.method || 'GET',
      headers: input.headers,
      body: input.body ?? undefined,
    });
    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) {
      responseHeaders['set-cookie'] = setCookies.join('\n');
    }
    const exchange: DrivenHttpExchange = {
      id: input.id,
      method: input.method || 'GET',
      url: input.url,
      requestHeaders: input.headers || {},
      requestContentType: input.headers?.['content-type'] || null,
      requestBody: input.body ?? null,
      status: response.status,
      responseHeaders,
      responseBody,
      kind: input.kind,
      targetId: 'target-page-0001',
      atSeconds: nextClock(),
    };
    exchanges.push(exchange);
    return exchange;
  };

  const loginPage = await record({
    id: 'http-000001',
    url: handle.urls.loginPage,
    kind: 'document',
  });

  // 登录页隐藏挑战 nonce：样例走摘要凭据登录（Lenovo/Nettrix 等登录加密变体形态），
  // 密码字段提交的是 SHA-256(passphrase:nonce)，crypto 调用事实写入 raw/runtime/crypto.jsonl。
  const nonceMatch = new RegExp(`name="${handle.loginFieldNames.nonce}" value="([^"]+)"`).exec(
    loginPage.responseBody,
  );
  const loginNonce = nonceMatch ? nonceMatch[1] : '';
  const credentialInput = `operator-passphrase:${loginNonce}`;
  const credentialDigest = createHash('sha256').update(credentialInput).digest('hex');

  const loginApi = await record({
    id: 'http-000002',
    url: handle.urls.loginApi,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      [handle.loginFieldNames.user]: 'operator',
      [handle.loginFieldNames.password]: credentialDigest,
    }),
    kind: 'xhr',
  });

  const sessionCookie = (loginApi.responseHeaders['set-cookie'] || '').split(';')[0];
  const loginPayload = JSON.parse(loginApi.responseBody) as { sessionToken: string; csrfToken: string };

  await record({
    id: 'http-000003',
    url: handle.urls.consoleEntry,
    headers: { cookie: sessionCookie },
    kind: 'document',
  });

  // KVM 启动请求：Session Cookie + CSRF 头（服务端逐一校验，缺失或错误返回 401/403）。
  const launchApi = await record({
    id: 'http-000004',
    url: handle.urls.kvmLaunch,
    method: 'POST',
    headers: {
      cookie: sessionCookie,
      [handle.csrfHeaderName]: loginPayload.csrfToken,
    },
    kind: 'xhr',
  });
  if (launchApi.status !== 200) {
    throw new Error(`样例 KVM 启动请求失败：${launchApi.status}`);
  }
  const launchPayload = JSON.parse(launchApi.responseBody) as {
    viewerToken: string;
    streamPath: string;
  };
  if (launchPayload.streamPath !== handle.paths.websocket) {
    throw new Error('样例启动响应的 streamPath 与 Mock WS 路径不一致');
  }

  await record({
    id: 'http-000005',
    url: handle.urls.viewerPage,
    headers: { cookie: sessionCookie },
    kind: 'document',
  });

  await record({
    id: 'http-000006',
    url: handle.urls.viewerWorker,
    headers: { cookie: sessionCookie },
    kind: 'script',
  });

  // 驱动双向 WebSocket：3 个初始下行帧 → 上行文本 → 回显 → 上行二进制 → 回显 → 关闭。
  // 握手与 Viewer 页脚本一致：URL 查询参数 t 携带 viewerToken，Cookie 头携带会话
  // （服务端在升级握手里校验二者；message 事件可能同批同步派发，必须用常驻队列消费）。
  // Node（undici）的 WebSocket 运行时支持 { headers } 选项，DOM 类型声明未包含，这里收窄类型。
  const WebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  const wsMessages: Array<{ direction: 'up' | 'down'; opcode: 'text' | 'binary'; payload: Uint8Array }> = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocketWithHeaders(
      `${handle.urls.websocket}?t=${encodeURIComponent(launchPayload.viewerToken)}`,
      { headers: { cookie: sessionCookie } },
    );
    ws.binaryType = 'arraybuffer';
    const messageQueue: Array<{ opcode: 'text' | 'binary'; data: Uint8Array }> = [];
    let notify: (() => void) | null = null;
    ws.addEventListener('error', () => reject(new Error('样例 WebSocket 连接失败')));
    ws.addEventListener('message', event => {
      const data =
        typeof event.data === 'string'
          ? new Uint8Array(Buffer.from(event.data, 'utf8'))
          : new Uint8Array(event.data as ArrayBuffer);
      messageQueue.push({ opcode: typeof event.data === 'string' ? 'text' : 'binary', data });
      if (notify) {
        const ready = notify;
        notify = null;
        ready();
      }
    });
    const nextMessage = () =>
      new Promise<{ opcode: 'text' | 'binary'; data: Uint8Array }>(resolveMessage => {
        if (messageQueue.length > 0) {
          resolveMessage(messageQueue.shift()!);
          return;
        }
        notify = () => resolveMessage(messageQueue.shift()!);
      });
    ws.addEventListener('open', () => {
      void (async () => {
        try {
          for (let index = 0; index < 3; index += 1) {
            const message = await nextMessage();
            wsMessages.push({ direction: 'down', opcode: message.opcode, payload: message.data });
          }
          const upText = 'hello-control';
          ws.send(upText);
          wsMessages.push({
            direction: 'up',
            opcode: 'text',
            payload: new Uint8Array(Buffer.from(upText, 'utf8')),
          });
          let echo = await nextMessage();
          wsMessages.push({ direction: 'down', opcode: echo.opcode, payload: echo.data });
          const upBinary = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
          ws.send(upBinary);
          wsMessages.push({ direction: 'up', opcode: 'binary', payload: upBinary });
          echo = await nextMessage();
          wsMessages.push({ direction: 'down', opcode: echo.opcode, payload: echo.data });
          ws.close(1000, 'sample-done');
          ws.addEventListener('close', () => resolve());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  });

  return {
    exchanges,
    wsMessages,
    cryptoCalls: [
      {
        input: credentialInput,
        output: credentialDigest,
        atSeconds: loginApi.atSeconds,
      },
    ],
    sessionCookie,
    csrfToken: loginPayload.csrfToken,
    viewerToken: launchPayload.viewerToken,
  };
}

function normalizeUrl(url: string, handle: MockKvmHandle): string {
  return url
    .replace(`${handle.base}/`, `${SAMPLE_HTTP_BASE}/`)
    .replace(`ws://${handle.host}:${handle.port}/`, `${SAMPLE_WS_BASE}/`);
}

function buildSummaryMarkdown(manifest: PackV2Manifest, urls: MockKvmUrlSet, websocketUrl: string): string {
  return [
    '# AI 分析摘要（样例包）',
    '',
    `目标：${manifest.target.host}:${manifest.target.port}（设备说明：${manifest.job.deviceLabel}）`,
    '',
    '本包由完全未知协议的本地 Mock KVM 生成：所有 URL 均为随机值，不命中任何厂商签名。',
    'classificationStatus=UNKNOWN 只表示当前没有已知协议候选，不影响资料完整性。',
    '',
    '适配链：登录交互 → Session/Cookie 建立 → KVM 点击 → 启动请求 → Viewer 打开 → 脚本/Worker → 实时通道。',
    '',
    `入口页：${urls.loginPage}`,
    `登录接口：${urls.loginApi}`,
    `KVM 启动：${urls.kvmLaunch}`,
    `Viewer 页：${urls.viewerPage}`,
    `实时通道：${websocketUrl}`,
    '',
    '每一步的证据 ID 与文件路径见 ai/adapter-dossier.json。',
    '',
  ].join('\n');
}

export async function createSampleCapturePackV2(
  options: SampleCapturePackV2Options = {},
): Promise<SampleCapturePackV2Result> {
  const seed = options.seed ?? SAMPLE_SEED;
  const startedAt = options.startedAt ?? SAMPLE_STARTED_AT;

  const handle = await createMockKvmServer({ seed });
  try {
    const { exchanges, wsMessages, cryptoCalls, sessionCookie, csrfToken, viewerToken } =
      await driveMockKvm(handle);

    const urls: MockKvmUrlSet = {
      loginPage: normalizeUrl(handle.urls.loginPage, handle),
      loginApi: normalizeUrl(handle.urls.loginApi, handle),
      consoleEntry: normalizeUrl(handle.urls.consoleEntry, handle),
      kvmLaunch: normalizeUrl(handle.urls.kvmLaunch, handle),
      viewerPage: normalizeUrl(handle.urls.viewerPage, handle),
      viewerWorker: normalizeUrl(handle.urls.viewerWorker, handle),
      websocket: normalizeUrl(handle.urls.websocket, handle),
    };
    // 实际建立的 WS 通道 URL：Viewer 页脚本与样例驱动都以查询参数 t 携带
    // viewerToken（与 Mock 服务端握手校验一致），记录的是真实连接 URL。
    const websocketConnectUrl = `${urls.websocket}?t=${encodeURIComponent(viewerToken)}`;

    // 离线分类（只在签名库上运行，不影响采集与完整度，规范 §15）。
    const detection = scoreCapturedKvmFamily(
      { basic: {}, paths: {}, tls: { certificate: null } },
      {
        httpRequests: exchanges
          .filter(exchange => exchange.kind !== 'document')
          .map(exchange => ({ url: normalizeUrl(exchange.url, handle), resourceType: 'XHR' })),
        webSockets: [{ url: websocketConnectUrl }],
        webSocketFrames: wsMessages
          .filter(message => message.direction === 'down' && message.opcode === 'binary')
          .map(message => ({
            headHex: Buffer.from(message.payload.subarray(0, 8)).toString('hex'),
          })),
      },
    );
    const classificationStatus = classificationStatusFromKvmFamilyDetection(detection.primary);

    const shortId = sha256Hex(seed).slice(0, 6);
    const startedAtMatch = startedAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    const startedStamp = startedAtMatch
      ? `${startedAtMatch[1]}${startedAtMatch[2]}${startedAtMatch[3]}-${startedAtMatch[4]}${startedAtMatch[5]}${startedAtMatch[6]}`
      : 'unknown-start';
    const jobId = `${startedStamp}-${shortId}`;
    const endedAt = isoAt(startedAt, 15);
    const sampleTool = { name: 'KVM-Recon', version: '0.3.0-dev', buildId: 'sample' } as const;

    // ---- 正文 blob store（SHA-256 寻址，去重） ----
    const httpBodies = new Map<string, string>();
    const httpBodyRef = (content: string | null): PackV2BodyRef | undefined => {
      if (content === null) return undefined;
      const digest = sha256Hex(content);
      if (!httpBodies.has(digest)) {
        httpBodies.set(digest, content);
      }
      return { sha256: digest, bytes: Buffer.byteLength(content, 'utf8'), path: `raw/http/bodies/${digest}` };
    };

    // 请求发起与引用关系（initiator / referer，规范 §8.2）。
    const initiatorFor = (exchange: DrivenHttpExchange): PackV2HttpTransactionRow['initiator'] => {
      switch (exchange.id) {
        case 'http-000002':
          return {
            type: 'script',
            url: urls.loginPage,
            lineNumber: 12,
            stackTrace: [{ url: urls.loginPage, functionName: 'submitLogin', lineNumber: 12 }],
          };
        case 'http-000004':
          return {
            type: 'script',
            url: urls.consoleEntry,
            lineNumber: 18,
            stackTrace: [
              { url: urls.consoleEntry, functionName: 'HTMLButtonElement.click', lineNumber: 18 },
            ],
          };
        case 'http-000005':
          return { type: 'script', url: urls.consoleEntry, lineNumber: 18 };
        case 'http-000006':
          return { type: 'parser', url: urls.viewerPage, lineNumber: 14 };
        default:
          return { type: 'other' };
      }
    };
    const refererFor = (exchange: DrivenHttpExchange): string | undefined => {
      switch (exchange.id) {
        case 'http-000002':
        case 'http-000003':
          return urls.loginPage;
        case 'http-000004':
        case 'http-000005':
          return urls.consoleEntry;
        case 'http-000006':
          return urls.viewerPage;
        default:
          return undefined;
      }
    };

    const transactions: PackV2HttpTransactionRow[] = exchanges.map(exchange => ({
      id: exchange.id,
      targetId: exchange.targetId,
      frameId: 'frame-0001',
      windowId: 'window-0001',
      startedAt: isoAt(startedAt, exchange.atSeconds),
      method: exchange.method,
      url: normalizeUrl(exchange.url, handle),
      resourceType: exchange.kind,
      requestHeaders: exchange.requestHeaders,
      requestBody: httpBodyRef(exchange.requestBody),
      status: exchange.status,
      responseHeaders: exchange.responseHeaders,
      contentEncoding: exchange.responseHeaders['content-encoding'] ?? null,
      responseBody: httpBodyRef(exchange.responseBody),
      initiator: initiatorFor(exchange),
      referer: refererFor(exchange),
      timing: { sendMs: 1, waitMs: 4, receiveMs: 5 },
      connectionId: 'conn-0001',
      remoteIpAddress: SAMPLE_CANONICAL_HOST,
      remotePort: SAMPLE_CANONICAL_PORT,
    }));

    const resources: PackV2ResourceRow[] = transactions.map(transaction => ({
      id: transaction.id,
      kind: transaction.resourceType as PackV2ResourceRow['kind'],
      url: transaction.url,
      method: transaction.method,
      status: transaction.status,
      contentType: transaction.responseHeaders['content-type'] || null,
      targetId: transaction.targetId,
      occurredAt: transaction.startedAt,
      requestBody: transaction.requestBody,
      responseBody: transaction.responseBody,
    }));

    const loginExchange = transactions[1];
    const launchExchange = transactions[3];
    const viewerPageExchange = transactions[4];
    const workerExchange = transactions[5];

    const targets: PackV2TargetRow[] = [
      {
        id: 'target-page-0001',
        type: 'page',
        attached: true,
        url: urls.loginPage,
        attachedAt: isoAt(startedAt, 0),
      },
      {
        id: 'target-worker-0001',
        type: 'worker',
        attached: true,
        url: urls.viewerWorker,
        parentTargetId: 'target-page-0001',
        attachedAt: isoAt(startedAt, 7),
      },
    ];

    const framesBinParts: Uint8Array[] = [];
    let payloadOffset = 0;
    const frameIndex: PackV2WsFrameIndexRow[] = wsMessages.map((message, index) => {
      const payloadLength = message.payload.byteLength;
      const row: PackV2WsFrameIndexRow = {
        frameIndex: index,
        direction: message.direction,
        opcode: message.opcode,
        // Mock 帧均为单帧消息（无分片）。
        fin: true,
        timestamp: isoAt(startedAt, 9 + index),
        payloadOffset,
        payloadLength,
      };
      framesBinParts.push(message.payload);
      payloadOffset += payloadLength;
      return row;
    });
    const framesBin = new Uint8Array(
      Buffer.concat(framesBinParts.map(part => Buffer.from(part))),
    );

    const wsChannel: PackV2ChannelRow = {
      id: 'ws-0001',
      kind: 'websocket',
      url: websocketConnectUrl,
      targetId: 'target-page-0001',
      createdAt: isoAt(startedAt, 9),
      closedAt: isoAt(startedAt, 9 + frameIndex.length),
      frameCounts: {
        up: wsMessages.filter(message => message.direction === 'up').length,
        down: wsMessages.filter(message => message.direction === 'down').length,
      },
      payloadPath: 'raw/websocket/ws-0001/frames.bin',
    };

    const channels: PackV2ChannelRow[] = [wsChannel];

    const sessionCookieName = (loginExchange.responseHeaders['set-cookie'] || '').split('=')[0];

    // ---- 脚本索引：网络脚本 / Worker 入口 / 页面内联脚本 ----
    const loginDigestScriptMatch = /<script id="login-digest">([\s\S]*?)<\/script>/.exec(
      exchanges[0].responseBody,
    );
    const loginDigestScriptSource = loginDigestScriptMatch ? loginDigestScriptMatch[1] : '';
    const loginDigestScriptDigest = sha256Hex(loginDigestScriptSource);
    const inlineScriptMatch = /<script id="viewer-bootstrap">([\s\S]*?)<\/script>/.exec(
      exchanges[4].responseBody,
    );
    const inlineScriptSource = inlineScriptMatch ? inlineScriptMatch[1] : '';
    const inlineScriptDigest = sha256Hex(inlineScriptSource);

    const scripts: PackV2ScriptEntry[] = [
      {
        id: 'script-net-0001',
        kind: 'network-script',
        url: workerExchange.url,
        targetId: 'target-page-0001',
        bodyRef: workerExchange.responseBody,
      },
      {
        id: 'script-worker-0001',
        kind: 'worker',
        url: workerExchange.url,
        targetId: 'target-worker-0001',
        createdBy: 'target-page-0001',
        bodyRef: workerExchange.responseBody,
      },
      {
        id: 'script-inline-0000',
        kind: 'inline',
        url: transactions[0].url,
        targetId: 'target-page-0001',
        createdBy: 'target-page-0001',
        bodyRef: {
          sha256: loginDigestScriptDigest,
          bytes: Buffer.byteLength(loginDigestScriptSource, 'utf8'),
          path: `raw/scripts/files/${loginDigestScriptDigest}`,
        },
      },
      {
        id: 'script-inline-0001',
        kind: 'inline',
        url: viewerPageExchange.url,
        targetId: 'target-page-0001',
        createdBy: 'target-page-0001',
        bodyRef: {
          sha256: inlineScriptDigest,
          bytes: Buffer.byteLength(inlineScriptSource, 'utf8'),
          path: `raw/scripts/files/${inlineScriptDigest}`,
        },
      },
    ];

    // ---- 运行时 crypto 调用事实（规范 §8.6）----
    const runtimeBodies = new Map<string, string>();
    const runtimeBodyRef = (content: string): PackV2BodyRef => {
      const digest = sha256Hex(content);
      if (!runtimeBodies.has(digest)) {
        runtimeBodies.set(digest, content);
      }
      return { sha256: digest, bytes: Buffer.byteLength(content, 'utf8'), path: `raw/runtime/bodies/${digest}` };
    };
    const cryptoRows: PackV2CryptoCallRow[] = cryptoCalls.map((call, index) => ({
      id: `crypto-${String(index + 1).padStart(4, '0')}`,
      occurredAt: isoAt(startedAt, call.atSeconds),
      targetId: 'target-page-0001',
      kind: 'digest',
      algorithm: 'SHA-256',
      algorithmParams: {},
      // 摘要由登录页内联脚本（WebCrypto）执行；脚本本体已入脚本索引。
      scriptId: 'script-inline-0000',
      scriptUrl: transactions[0].url,
      lineNumber: 9,
      inputRef: runtimeBodyRef(call.input),
      outputRef: runtimeBodyRef(call.output),
    }));

    // ---- 值传播（规范 §8.6 / §16） ----
    const valueNodes: ValueFlowNode[] = [
      {
        id: 'value-0001',
        kind: 'http-response',
        name: `${sessionCookieName}（登录响应 Set-Cookie）`,
        evidencePath: 'raw/http/transactions.jsonl',
        evidenceId: loginExchange.id,
      },
      {
        id: 'value-0002',
        kind: 'cookie',
        name: sessionCookieName,
        evidencePath: 'raw/browser/storage.json',
      },
      {
        id: 'value-0003',
        kind: 'header',
        name: 'cookie',
        evidencePath: 'raw/http/transactions.jsonl',
        evidenceId: launchExchange.id,
      },
      {
        id: 'value-0004',
        kind: 'header',
        name: 'cookie',
        evidencePath: 'raw/websocket/ws-0001/metadata.json',
        evidenceId: 'ws-0001',
      },
      {
        id: 'value-0005',
        kind: 'http-response',
        name: 'viewerToken（KVM 启动响应）',
        evidencePath: 'raw/http/transactions.jsonl',
        evidenceId: launchExchange.id,
      },
      {
        id: 'value-0006',
        kind: 'ws-frame',
        name: '首条上行控制帧',
        evidencePath: 'raw/websocket/ws-0001/frames.index.jsonl',
        evidenceId: 'ws-0001',
      },
      {
        id: 'value-0007',
        kind: 'http-response',
        name: '登录挑战 nonce（登录页隐藏字段）',
        evidencePath: 'raw/http/transactions.jsonl',
        evidenceId: 'http-000001',
      },
      {
        id: 'value-0008',
        kind: 'crypto-output',
        name: 'SHA-256 摘要凭据（crypto-0001 输出）',
        evidencePath: 'raw/runtime/crypto.jsonl',
        evidenceId: 'crypto-0001',
      },
      {
        id: 'value-0009',
        kind: 'http-request-body',
        name: '登录请求凭据字段',
        evidencePath: 'raw/http/transactions.jsonl',
        evidenceId: 'http-000002',
      },
      {
        id: 'value-0010',
        kind: 'http-response',
        name: 'csrfToken（登录响应）',
        evidencePath: 'raw/http/transactions.jsonl',
        evidenceId: 'http-000002',
      },
      {
        id: 'value-0011',
        kind: 'header',
        name: `${handle.csrfHeaderName}（KVM 启动请求 CSRF 头）`,
        evidencePath: 'raw/http/transactions.jsonl',
        evidenceId: 'http-000004',
      },
      {
        id: 'value-0012',
        kind: 'url-param',
        name: 'WS 握手查询参数 t（viewerToken）',
        evidencePath: 'raw/websocket/ws-0001/metadata.json',
        evidenceId: 'ws-0001',
      },
    ];
    const valueEdges: ValueFlowEdge[] = [
      {
        from: 'value-0001',
        to: 'value-0002',
        relation: 'propagated-to',
        evidencePath: 'raw/http/transactions.jsonl',
        replaySubstitution: true,
      },
      {
        from: 'value-0002',
        to: 'value-0003',
        relation: 'propagated-to',
        evidencePath: 'raw/http/transactions.jsonl',
        replaySubstitution: true,
      },
      {
        from: 'value-0002',
        to: 'value-0004',
        relation: 'propagated-to',
        evidencePath: 'raw/websocket/ws-0001/metadata.json',
        replaySubstitution: true,
      },
      // viewerToken 经 WS 握手查询参数 t 传递（服务端在升级握手时校验）。
      {
        from: 'value-0005',
        to: 'value-0012',
        relation: 'propagated-to',
        evidencePath: 'raw/websocket/ws-0001/metadata.json',
        replaySubstitution: true,
      },
      {
        from: 'value-0007',
        to: 'value-0008',
        relation: 'derived-from',
        evidencePath: 'raw/runtime/crypto.jsonl',
        replaySubstitution: true,
      },
      {
        from: 'value-0008',
        to: 'value-0009',
        relation: 'used-in',
        evidencePath: 'raw/http/transactions.jsonl',
        replaySubstitution: true,
      },
      {
        from: 'value-0010',
        to: 'value-0011',
        relation: 'propagated-to',
        evidencePath: 'raw/http/transactions.jsonl',
        replaySubstitution: true,
      },
    ];

    const valueFlow: PackV2ValueFlow = {
      schemaVersion: '2.0.0',
      nodes: valueNodes,
      edges: valueEdges,
    };

    // ---- Adapter dossier 候选链（规范 §12） ----
    const dossierSteps: AdapterDossierStep[] = [
      {
        role: 'login-interaction',
        title: '操作员提交登录表单（SHA-256 摘要凭据）',
        evidenceIds: ['http-000001', 'http-000002', 'crypto-0001', 'value-0007'],
        evidencePaths: ['raw/http/transactions.jsonl', 'raw/runtime/crypto.jsonl'],
        occurredAt: isoAt(startedAt, 2),
      },
      {
        role: 'session-established',
        title: '登录响应建立 Session Cookie',
        evidenceIds: ['http-000002', 'value-0001'],
        evidencePaths: ['raw/http/transactions.jsonl', 'ai/value-flow.json'],
        occurredAt: isoAt(startedAt, 2),
      },
      {
        role: 'kvm-click',
        title: '操作员点击「打开远程控制台」',
        evidenceIds: ['action-0002'],
        evidencePaths: ['raw/browser/actions.jsonl'],
        occurredAt: isoAt(startedAt, 4),
      },
      {
        role: 'launch-request',
        title: 'KVM 启动请求返回 viewerToken 与通道路径',
        evidenceIds: ['http-000004', 'value-0005'],
        evidencePaths: ['raw/http/transactions.jsonl', 'ai/value-flow.json'],
        occurredAt: isoAt(startedAt, 4),
      },
      {
        role: 'viewer-opened',
        title: 'Viewer 页面打开并创建解码 Worker',
        evidenceIds: ['http-000005', 'target-worker-0001', 'script-inline-0001'],
        evidencePaths: ['raw/http/transactions.jsonl', 'raw/browser/targets.json', 'raw/scripts/index.json'],
        occurredAt: isoAt(startedAt, 5),
      },
      {
        role: 'script-worker-wasm',
        title: 'Worker 入口源码与页面内联脚本完整落盘',
        evidenceIds: ['http-000006', 'script-worker-0001', 'script-inline-0001'],
        evidencePaths: ['raw/http/transactions.jsonl', 'raw/scripts/index.json'],
        occurredAt: isoAt(startedAt, 6),
      },
      {
        role: 'realtime-channel',
        title: '双向 WebSocket 通道建立并记录全部帧',
        evidenceIds: ['ws-0001', 'value-0006'],
        evidencePaths: [
          'raw/websocket/ws-0001/metadata.json',
          'raw/websocket/ws-0001/frames.index.jsonl',
        ],
        occurredAt: isoAt(startedAt, 9),
      },
    ];

    // ---- Replay（规范 §16）----
    // 动态值语义：requiresDynamicValueIds 只能引用请求发生前已存在、需要在
    // Replay 中替换的值（登录请求依赖 nonce 与摘要输出；启动请求依赖已建立的
    // Session Cookie 与登录响应的 csrfToken——不是本次请求响应才产生的值）。
    const replayManifest: PackV2ReplayManifest = {
      schemaVersion: '2.0.0',
      replayable: true,
      clockPolicy: 'deterministic-accelerated',
      requests: [
        {
          requestId: 'http-000002',
          url: loginExchange.url,
          method: 'POST',
          requiresDynamicValueIds: ['value-0007', 'value-0008'],
        },
        {
          requestId: 'http-000004',
          url: launchExchange.url,
          method: 'POST',
          requiresDynamicValueIds: ['value-0002', 'value-0010'],
        },
      ],
      channels: [
        // WS 握手实际依赖：Session Cookie（value-0002，服务端严格比对签发值）
        // 与 viewerToken（value-0005，查询参数 t）。
        {
          channelId: 'ws-0001',
          kind: 'websocket',
          framesIndexPath: 'raw/websocket/ws-0001/frames.index.jsonl',
          requiresDynamicValueIds: ['value-0002', 'value-0005'],
        },
      ],
    };

    const replayHttpRows: PackV2ReplayRequestRow[] = [
      {
        requestId: 'http-000002',
        url: loginExchange.url,
        method: 'POST',
        requestBodyPath: loginExchange.requestBody?.path || null,
        responseBodyPath: loginExchange.responseBody?.path || null,
        occurredAt: loginExchange.startedAt,
      },
      {
        requestId: 'http-000004',
        url: launchExchange.url,
        method: 'POST',
        requestBodyPath: launchExchange.requestBody?.path || null,
        responseBodyPath: launchExchange.responseBody?.path || null,
        occurredAt: launchExchange.startedAt,
      },
    ];

    const replayChannels: PackV2ReplayChannelsFile = {
      schemaVersion: '2.0.0',
      channels: replayManifest.channels,
    };

    // ---- raw/browser ----
    const timeline: PackV2BrowserTimelineRow[] = [
      { occurredAt: isoAt(startedAt, 1), kind: 'navigation', targetId: 'target-page-0001', url: urls.loginPage },
      { occurredAt: isoAt(startedAt, 3), kind: 'navigation', targetId: 'target-page-0001', url: urls.consoleEntry },
      { occurredAt: isoAt(startedAt, 5), kind: 'navigation', targetId: 'target-page-0001', url: urls.viewerPage },
      { occurredAt: isoAt(startedAt, 7), kind: 'worker-created', targetId: 'target-worker-0001', url: urls.viewerWorker },
      { occurredAt: isoAt(startedAt, 9), kind: 'channel-opened', targetId: 'target-page-0001', url: websocketConnectUrl },
      { occurredAt: isoAt(startedAt, 11), kind: 'dom-snapshot-saved', targetId: 'target-page-0001', detail: 'raw/browser/dom-snapshots/0001-login.html' },
      { occurredAt: isoAt(startedAt, 12), kind: 'dom-snapshot-saved', targetId: 'target-page-0001', detail: 'raw/browser/dom-snapshots/0002-console-entry.html' },
      { occurredAt: isoAt(startedAt, 13), kind: 'dom-snapshot-saved', targetId: 'target-page-0001', detail: 'raw/browser/dom-snapshots/0003-viewer.html' },
      { occurredAt: isoAt(startedAt, 14), kind: 'screenshot-saved', targetId: 'target-page-0001', detail: 'raw/browser/screenshots/viewer-initial.png' },
      { occurredAt: isoAt(startedAt, 15), kind: 'screenshot-saved', targetId: 'target-page-0001', detail: 'raw/browser/screenshots/viewer-stable.png' },
    ];

    const actions: PackV2BrowserActionRow[] = [
      {
        id: 'action-0001',
        occurredAt: isoAt(startedAt, 2),
        kind: 'form-submit',
        targetId: 'target-page-0001',
        elementSummary: '#login-submit 登录',
        url: urls.loginPage,
      },
      {
        id: 'action-0002',
        occurredAt: isoAt(startedAt, 4),
        kind: 'click',
        targetId: 'target-page-0001',
        elementSummary: '#console-open 打开远程控制台',
        url: urls.consoleEntry,
      },
    ];

    const storage: PackV2BrowserStorageFile = {
      schemaVersion: '2.0.0',
      targetId: 'target-page-0001',
      capturedAt: isoAt(startedAt, 10),
      cookies: [
        {
          name: sessionCookieName,
          value: (loginExchange.responseHeaders['set-cookie'] || '').split(';')[0].split('=').slice(1).join('='),
          domain: SAMPLE_CANONICAL_HOST,
          path: '/',
        },
      ],
      localStorage: {},
      // 页面脚本实际写入 sessionStorage 的值：登录后存 csrfToken，
      // 启动成功后存 viewerToken（键名来自 Mock 登录页/控制台页内联脚本）。
      sessionStorage: {
        [handle.csrfStorageKey]: csrfToken,
        [handle.viewerTokenStorageKey]: viewerToken,
      },
      indexedDb: [],
      cacheStorage: [],
    };

    const consoleRows: PackV2BrowserConsoleRow[] = [
      {
        occurredAt: isoAt(startedAt, 8),
        targetId: 'target-worker-0001',
        level: 'log',
        text: '{"type":"worker-ready"}',
      },
    ];

    // ---- raw/cdp journal（协议无关原始事件样例） ----
    const cdpEvents: PackV2CdpEventRow[] = [];
    let cdpSeq = 0;
    for (const transaction of transactions) {
      cdpSeq += 1;
      cdpEvents.push({
        seq: cdpSeq,
        timestamp: transaction.startedAt,
        method: 'Network.requestWillBeSent',
        sessionId: 'session-page-0001',
        targetId: 'target-page-0001',
        params: {
          requestId: transaction.id,
          request: { url: transaction.url, method: transaction.method, headers: transaction.requestHeaders },
          type: transaction.resourceType,
        },
      });
      cdpSeq += 1;
      cdpEvents.push({
        seq: cdpSeq,
        timestamp: transaction.startedAt,
        method: 'Network.responseReceived',
        sessionId: 'session-page-0001',
        targetId: 'target-page-0001',
        params: {
          requestId: transaction.id,
          response: { url: transaction.url, status: transaction.status, headers: transaction.responseHeaders },
          type: transaction.resourceType,
        },
      });
    }
    cdpEvents.push(
      {
        seq: (cdpSeq += 1),
        timestamp: isoAt(startedAt, 9),
        method: 'Network.webSocketCreated',
        sessionId: 'session-page-0001',
        targetId: 'target-page-0001',
        params: { requestId: 'ws-0001', url: websocketConnectUrl, initiator: { type: 'script' } },
      },
      {
        seq: (cdpSeq += 1),
        timestamp: isoAt(startedAt, 9),
        method: 'Network.webSocketHandshakeResponseReceived',
        sessionId: 'session-page-0001',
        targetId: 'target-page-0001',
        params: { requestId: 'ws-0001', status: 101 },
      },
    );
    for (const frame of frameIndex) {
      cdpEvents.push({
        seq: (cdpSeq += 1),
        timestamp: frame.timestamp,
        method: frame.direction === 'up' ? 'Network.webSocketFrameSent' : 'Network.webSocketFrameReceived',
        sessionId: 'session-page-0001',
        targetId: 'target-page-0001',
        params: { requestId: 'ws-0001', frameIndex: frame.frameIndex, opcode: frame.opcode },
      });
    }

    const cdpCommands: PackV2CdpCommandRow[] = [
      { seq: 1, timestamp: isoAt(startedAt, 0), method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true } },
      { seq: 2, timestamp: isoAt(startedAt, 0), method: 'Network.enable' },
      { seq: 3, timestamp: isoAt(startedAt, 0), method: 'Network.setCacheDisabled', params: { disabled: true } },
      { seq: 4, timestamp: isoAt(startedAt, 0), method: 'Page.enable' },
      { seq: 5, timestamp: isoAt(startedAt, 0), method: 'Runtime.enable' },
      { seq: 6, timestamp: isoAt(startedAt, 0), method: 'Target.attachToTarget', params: { targetId: 'target-worker-0001', flatten: true } },
    ];

    const netlog: PackV2NetLogFile = {
      schemaVersion: '2.0.0',
      captureMode: 'IncludeSensitive',
      events: [
        { type: 'SOCKET_CONNECT', time: 't+0', params: { address: `${SAMPLE_CANONICAL_HOST}:${SAMPLE_CANONICAL_PORT}` } },
        { type: 'HTTP_STREAM_JOB', time: 't+1', params: { url: urls.loginPage } },
        { type: 'SOCKET_ALIVE', time: 't+9', params: { ws: true } },
      ],
      // Chromium NetLog 原始常量原样保留（规范 §8.1：未识别字段不裁剪）。
      constants: {
        logEventTypes: { SOCKET_CONNECT: 22, HTTP_STREAM_JOB: 65, SOCKET_ALIVE: 21 },
        logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2, PHASE_NONE: 0 },
        logSourceType: { URL_REQUEST: 1, SOCKET: 3 },
      },
      // 未识别字段透传演示：Chromium 后续版本新增字段不被丢弃。
      unknownFutureField: { keepVerbatim: true },
    };

    const wsMetadata: PackV2WsMetadata = {
      schemaVersion: '2.0.0',
      channelId: 'ws-0001',
      url: websocketConnectUrl,
      targetId: 'target-page-0001',
      createdAt: wsChannel.createdAt,
      closedAt: wsChannel.closedAt,
      requestedSubProtocols: [],
      acceptedSubProtocol: null,
      extensions: [],
      closeCode: 1000,
      closeReason: 'sample-done',
      handshakeStatus: 101,
      // 握手请求头来自实际连接事实：样例驱动（与 Viewer 页脚本一致）携带的会话 Cookie。
      requestHeaders: { cookie: sessionCookie },
      responseHeaders: { upgrade: 'websocket', connection: 'Upgrade' },
      frameCounts: wsChannel.frameCounts || { up: 0, down: 0 },
      framesBinPath: 'raw/websocket/ws-0001/frames.bin',
    };

    // ---- catalog/relations ----
    const relations: PackV2RelationRow[] = [
      ...transactions.map(transaction => ({
        from: 'target-page-0001',
        to: transaction.id,
        relation: 'initiated' as const,
        occurredAt: transaction.startedAt,
        evidencePath: 'raw/http/transactions.jsonl',
      })),
      {
        from: 'target-page-0001',
        to: 'script-worker-0001',
        relation: 'created',
        occurredAt: isoAt(startedAt, 7),
        evidencePath: 'raw/scripts/index.json',
      },
      {
        from: 'target-page-0001',
        to: 'ws-0001',
        relation: 'opened',
        occurredAt: isoAt(startedAt, 9),
        evidencePath: 'raw/websocket/ws-0001/metadata.json',
      },
      // 注：页面脚本分别创建 Worker 与 WebSocket，采集事实无法证明二者绑定，
      // 因此不编造 target-worker-0001 → ws-0001 的 attached 关系。
      {
        from: 'value-0001',
        to: 'value-0002',
        relation: 'value-flow',
        occurredAt: isoAt(startedAt, 2),
        evidencePath: 'ai/value-flow.json',
      },
    ];

    // ---- 阶段 A：内容 artifacts（不含状态文件与 checksums） ----
    const contentArtifacts: SampleArtifact[] = [
      { path: '00_START_HERE.md', content: buildPackV2StartHereMarkdown() },
      { path: 'ai/value-flow.json', content: json2(valueFlow) },
      { path: 'catalog/resources.jsonl', content: jsonl(resources) },
      { path: 'catalog/targets.json', content: json2({ schemaVersion: '2.0.0', targets } satisfies PackV2TargetsFile) },
      { path: 'catalog/channels.json', content: json2({ schemaVersion: '2.0.0', channels } satisfies PackV2ChannelsFile) },
      { path: 'catalog/relations.jsonl', content: jsonl(relations) },
      { path: 'raw/cdp/events.jsonl', content: jsonl(cdpEvents) },
      { path: 'raw/cdp/commands.jsonl', content: jsonl(cdpCommands) },
      { path: 'raw/netlog/netlog.json', content: json2(netlog) },
      { path: 'raw/http/transactions.jsonl', content: jsonl(transactions) },
      { path: 'raw/websocket/ws-0001/metadata.json', content: json2(wsMetadata) },
      { path: 'raw/websocket/ws-0001/frames.index.jsonl', content: jsonl(frameIndex) },
      { path: 'raw/websocket/ws-0001/frames.bin', content: framesBin },
      { path: 'raw/realtime/webrtc.jsonl', content: '' },
      { path: 'raw/realtime/webtransport.jsonl', content: '' },
      { path: 'raw/realtime/sse.jsonl', content: '' },
      { path: 'raw/realtime/downloads.jsonl', content: '' },
      { path: 'raw/runtime/crypto.jsonl', content: jsonl(cryptoRows) },
      { path: 'raw/browser/timeline.jsonl', content: jsonl(timeline) },
      { path: 'raw/browser/actions.jsonl', content: jsonl(actions) },
      { path: 'raw/browser/targets.json', content: json2({ schemaVersion: '2.0.0', targets } satisfies PackV2TargetsFile) },
      { path: 'raw/browser/storage.json', content: json2(storage) },
      { path: 'raw/browser/console.jsonl', content: jsonl(consoleRows) },
      { path: 'raw/browser/dom-snapshots/0001-login.html', content: exchanges[0].responseBody },
      { path: 'raw/browser/dom-snapshots/0002-console-entry.html', content: exchanges[2].responseBody },
      { path: 'raw/browser/dom-snapshots/0003-viewer.html', content: exchanges[4].responseBody },
      // Viewer 初始与稳定阶段截图（规范 §7.4）。阶段 0 为两张不同的占位样例图，
      // 真实画面截图由阶段 2 采集器生成。
      { path: 'raw/browser/screenshots/viewer-initial.png', content: sampleViewerPng([0x42, 0xc7, 0xb7, 0xff]) },
      { path: 'raw/browser/screenshots/viewer-stable.png', content: sampleViewerPng([0x4b, 0xc2, 0x7a, 0xff]) },
      { path: 'raw/scripts/index.json', content: json2({ schemaVersion: '2.0.0', scripts } satisfies PackV2ScriptsIndex) },
      { path: `raw/scripts/files/${inlineScriptDigest}`, content: inlineScriptSource },
      { path: `raw/scripts/files/${loginDigestScriptDigest}`, content: loginDigestScriptSource },
      {
        path: 'raw/probe/index.json',
        content: json2({ schemaVersion: '2.0.0', probeRan: false, facts: [] }),
      },
      { path: 'replay/manifest.json', content: json2(replayManifest) },
      { path: 'replay/http.jsonl', content: jsonl(replayHttpRows) },
      { path: 'replay/channels.json', content: json2(replayChannels) },
    ];

    for (const [digest, content] of httpBodies) {
      contentArtifacts.push({ path: `raw/http/bodies/${digest}`, content });
    }
    for (const [digest, content] of runtimeBodies) {
      contentArtifacts.push({ path: `raw/runtime/bodies/${digest}`, content });
    }

    // schema/ 目录：包内自带 2.0 Schema 副本（由仓库 schema/2.0/ 读取）。
    const schemaDir = 'schema/2.0';
    const schemaNames = readdirSync(schemaDir)
      .filter(name => name.endsWith('.schema.json'))
      .sort();
    for (const name of schemaNames) {
      contentArtifacts.push({
        path: `schema/${name}`,
        content: readFileSync(join(schemaDir, name)),
      });
    }

    // HAR（互操作副本，不取代原始索引与正文，规范 §8.2）。
    contentArtifacts.push({
      path: 'raw/http/session.har',
      content: json2(buildSampleHar(sampleTool, transactions, httpBodies)),
    });

    // ---- 预验证：完整度门禁从已写入内容验证得出，而不是预先声明 ----
    const preCheck = validatePackV2Consistency(contentArtifacts, {
      requireChecksumFile: false,
      requireStatusFiles: false,
    });
    const hasProblem = (...codes: PackV2ConsistencyProblemCode[]) =>
      preCheck.problems.some(problem => codes.includes(problem.code));
    const hasProblemUnder = (prefix: string) =>
      preCheck.problems.some(
        problem => problem.path === prefix || problem.path?.startsWith(`${prefix}/`) === true,
      );
    // 结构性问题（Schema 自校验失败 / 00_START_HERE 契约 / 非法顶层条目 / 重复路径）
    // 属于导出包自校验门禁（规范 §14 条件 10）。
    const structuralProblems = preCheck.problems.filter(problem =>
      [
        'SCHEMA_VIOLATION',
        'PACK_SCHEMA_MISSING',
        'START_HERE_INVALID',
        'UNEXPECTED_TOP_LEVEL_ENTRY',
        'DUPLICATE_PATH',
      ].includes(problem.code),
    );

    // 从实际观察到的驱动事实派生证据摘要（规范 §14 输入形态）。
    const loginOk = exchanges[1].status === 200;
    const viewerReady = exchanges[4].status === 200 && exchanges[5].status === 200;
    const wsDownCount = wsMessages.filter(message => message.direction === 'down').length;
    const wsUpCount = wsMessages.filter(message => message.direction === 'up').length;
    const wsFlowComplete = wsDownCount >= 5 && wsUpCount >= 2;
    const workflowStatus = viewerReady && wsFlowComplete
      ? 'KVM_REACHED'
      : loginOk
        ? 'LOGIN_REACHED'
        : 'TARGET_OPENED';
    const derived = derivePackIntegrity({
      // 驱动器在任何请求前就绪记录。
      collectorReadyBeforeFirstNavigation: true,
      rawJournalsClosed: !hasProblemUnder('raw/cdp') && !hasProblemUnder('raw/netlog'),
      browserStateWritten:
        !hasProblemUnder('raw/browser') &&
        !hasProblem('MISSING_SCREENSHOT', 'MISSING_DOM_SNAPSHOT'),
      evidenceReferencesClosed: !hasProblem(
        'DANGLING_BODY_REF',
        'BODY_HASH_MISMATCH',
        'DANGLING_SCRIPT_REF',
        'CHANNEL_FILE_MISSING',
        'FRAME_OFFSET_MISMATCH',
        'CHANNEL_COUNT_MISMATCH',
        'UNKNOWN_EVIDENCE_ID',
        'VALUE_FLOW_UNKNOWN_NODE',
        'REPLAY_UNKNOWN_ID',
      ),
      storageLimitReached: false,
      targetAttachFailures: [],
      missingBodies: exchanges
        .filter(exchange => exchange.status === null || exchange.responseBody === '')
        .map(exchange => ({ id: exchange.id, detail: '响应正文为空或状态未知' })),
      missingWorkerSources: [],
      channelGaps: wsFlowComplete
        ? []
        : [{ id: 'ws-0001', detail: '双向 WebSocket 帧未采集完整' }],
      unsupportedChannels: [],
      journalWriteFailures: [],
      exportValidationFailures: structuralProblems.map(problem => ({
        id: problem.path || problem.code,
        detail: problem.detail,
      })),
      workflowStatus,
    });

    // ---- 状态文件（manifest / integrity / ai 派生内容） ----
    const manifest: PackV2Manifest = {
      schemaVersion: '2.0.0',
      tool: sampleTool,
      job: {
        id: jobId,
        shortId,
        startedAt,
        endedAt,
        deviceLabel: SAMPLE_DEVICE_LABEL,
      },
      target: {
        host: SAMPLE_CANONICAL_HOST,
        port: SAMPLE_CANONICAL_PORT,
        scheme: 'http',
        originalInput: `${SAMPLE_CANONICAL_HOST}:${SAMPLE_CANONICAL_PORT}`,
      },
      captureIntegrity: derived.captureIntegrity,
      workflowStatus,
      classificationStatus,
      security: { dataHandling: 'UNREDACTED', containsSensitiveData: true },
      environment: {
        chromium: '152.0.7977.76',
        electron: '44.3.0',
        os: 'darwin 25.6.0',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.76 Safari/537.36',
        language: 'zh-CN',
        timezone: 'Asia/Shanghai',
        screen: '3008x1702@2x',
      },
    };

    const integrity: PackV2Integrity = {
      schemaVersion: '2.0.0',
      captureIntegrity: derived.captureIntegrity,
      reasons: derived.reasons,
      gates: derived.gates.map(gate => ({ ...gate })),
      generatedAt: endedAt,
    };

    const adapterDossier: PackV2AdapterDossier = {
      schemaVersion: '2.0.0',
      status: {
        captureIntegrity: manifest.captureIntegrity,
        workflowStatus: manifest.workflowStatus,
        classificationStatus: manifest.classificationStatus,
      },
      candidateChain: dossierSteps,
    };

    const aiIndex: PackV2AiIndex = {
      schemaVersion: '2.0.0',
      readingOrder: ['00_START_HERE.md', 'ai/index.json', 'ai/adapter-dossier.json'],
      capturedPageContent: UNTRUSTED_PAGE_CONTENT_MARKER,
      job: { id: jobId, deviceLabel: SAMPLE_DEVICE_LABEL, startedAt },
      target: { host: SAMPLE_CANONICAL_HOST, port: SAMPLE_CANONICAL_PORT, scheme: 'http' },
      tool: manifest.tool,
      status: {
        captureIntegrity: manifest.captureIntegrity,
        workflowStatus: manifest.workflowStatus,
        classificationStatus: manifest.classificationStatus,
      },
      loginCandidateRequestIds: ['http-000002'],
      kvmLaunchCandidateRequestIds: ['http-000004'],
      viewerTargetIds: ['target-page-0001', 'target-worker-0001'],
      dynamicScriptIds: ['script-inline-0001'],
      workerIds: ['script-worker-0001'],
      wasmIds: [],
      websocketChannelIds: ['ws-0001'],
      webrtcChannelIds: [],
      webtransportChannelIds: [],
      evidenceGraphPath: 'catalog/relations.jsonl',
      valueFlowPath: 'ai/value-flow.json',
      missingEvidencePath: 'ai/missing-evidence.json',
      replayEntryPath: 'replay/manifest.json',
    };

    // ---- 阶段 B：状态文件 + checksums ----
    const artifacts: SampleArtifact[] = [
      ...contentArtifacts,
      { path: 'manifest.json', content: json2(manifest) },
      { path: 'integrity.json', content: json2(integrity) },
      { path: 'report.html', content: buildPackV2ReportHtml(manifest) },
      { path: 'ai/index.json', content: json2(aiIndex) },
      { path: 'ai/summary.md', content: buildSummaryMarkdown(manifest, urls, websocketConnectUrl) },
      { path: 'ai/adapter-dossier.json', content: json2(adapterDossier) },
      {
        path: 'ai/missing-evidence.json',
        content: json2({
          schemaVersion: '2.0.0',
          captureIntegrity: manifest.captureIntegrity,
          items: derived.reasons.map(code => {
            const info = incompleteReasonInfo(code);
            return { reason: code, title: info.title, detail: info.summary };
          }),
        }),
      },
    ];

    // checksums.sha256（规范 §11；排除自身）。
    const checksumLines = [...artifacts]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map(artifact => `${sha256Hex(artifact.content)}  ${artifact.path}`);
    artifacts.push({ path: 'checksums.sha256', content: `${checksumLines.join('\n')}\n` });

    // ---- 终检：声明的状态必须通过独立一致性验证器 ----
    const finalCheck = validatePackV2Consistency(artifacts);
    if (!finalCheck.valid) {
      throw new Error(
        `样例包一致性验证失败：${finalCheck.problems
          .map(problem => `${problem.code}: ${problem.detail}`)
          .join('; ')}`,
      );
    }

    const fileName = buildPackV2FileName({
      startedAt,
      targetHost: manifest.target.host,
      workflowStatus: manifest.workflowStatus,
      captureIntegrity: manifest.captureIntegrity,
      shortJobId: shortId,
    });

    return { fileName, manifest, integrity, aiIndex, urls, artifacts };
  } finally {
    await handle.close();
  }
}

function buildSampleHar(
  tool: { name: string; version: string },
  transactions: PackV2HttpTransactionRow[],
  httpBodies: Map<string, string>,
): unknown {
  // 复用真实 harBuilder 的条目构造：HAR 形状只有一处定义，样例与真实构建不得漂移
  const textOf = (ref?: { sha256: string }): string | null => {
    const text = ref ? httpBodies.get(ref.sha256) : undefined;
    return text === undefined ? null : text;
  };
  return {
    log: {
      version: '1.2',
      creator: { name: tool.name, version: tool.version },
      entries: transactions.map(transaction => {
        const postData = harPostDataOf(
          headerOf(transaction.requestHeaders, 'content-type'),
          transaction.requestBody,
          textOf(transaction.requestBody),
        );
        const responseContent = harContentOf(
          headerOf(transaction.responseHeaders, 'content-type'),
          transaction.responseBody,
          textOf(transaction.responseBody),
        );
        return harEntry(transaction, responseContent, postData);
      }),
    },
  };
}

export function sampleArtifactToBuffer(content: string | Uint8Array): Buffer {
  return toBuffer(content);
}
