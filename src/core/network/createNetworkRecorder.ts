import { redactSensitiveData, redactUrl } from '../redaction/redactSensitiveData';

type HeaderMap = Record<string, string>;
type HttpTag = 'login' | 'kvm-token' | 'kvm-entry';
type WebSocketTag = 'kvm-video' | 'vmedia' | 'unknown';

interface CreateNetworkRecorderOptions {
  frameHeadBytes: number;
}

interface HttpRequestInput {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: HeaderMap;
  requestBody?: string;
}

interface HttpResponseInput {
  id: string;
  status: number;
  responseHeaders: HeaderMap;
  responseBody?: string;
}

interface HttpResponseBodyInput {
  id: string;
  responseBody: string;
}

export interface HttpRequestRecord {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  requestHeaders: HeaderMap;
  responseHeaders: HeaderMap;
  requestBodySummary: {
    bytes: number;
    redactedFields: string[];
    jsonKeys?: string[];
  };
  responseBodySummary: {
    bytes: number;
    redactedFields: string[];
    jsonKeys?: string[];
  };
  tags: HttpTag[];
}

interface WebSocketCreatedInput {
  id: string;
  timestamp: string;
  url: string;
  subProtocols: string[];
  requestHeaders: HeaderMap;
}

interface WebSocketHandshakeInput {
  id: string;
  subProtocols: string[];
  requestHeaders: HeaderMap;
}

interface WebSocketFrameInput {
  socketId: string;
  timestamp: string;
  direction: 'up' | 'down';
  opcode: 'text' | 'binary';
  payload: string | Uint8Array;
}

interface WebSocketClosedInput {
  id: string;
  timestamp: string;
}

export interface WebSocketRecord {
  id: string;
  createdAt: string;
  closedAt?: string;
  url: string;
  subProtocols: string[];
  requestHeaders: HeaderMap;
  binaryFrameCount: number;
  textFrameCount: number;
  tags: WebSocketTag[];
}

export interface WebSocketFrameRecord {
  socketId: string;
  timestamp: string;
  direction: 'up' | 'down';
  opcode: 'text' | 'binary';
  bytes: number;
  headHex: string;
  sampled: boolean;
  magic?: string;
}

interface NetworkRecorderSnapshot {
  httpRequests: HttpRequestRecord[];
  webSockets: WebSocketRecord[];
  webSocketFrames: WebSocketFrameRecord[];
}

function tagHttp(url: string): HttpTag[] {
  const lower = url.toLowerCase();
  const tags: HttpTag[] = [];
  if (/\/api\/session|sessionservice\/sessions|login/.test(lower)) {
    tags.push('login');
  }
  if (/kvm\/token|setkvmkey|kvmservice/.test(lower)) {
    tags.push('kvm-token');
  }
  if (/kvm|console|viewer/.test(lower) && !tags.includes('kvm-token')) {
    tags.push('kvm-entry');
  }
  return tags;
}

function tagWebSocket(url: string): WebSocketTag[] {
  const lower = url.toLowerCase();
  if (/\/kvm|websocket|\/kvm\/video/.test(lower)) return ['kvm-video'];
  if (/vm|media|cd-server/.test(lower)) return ['vmedia'];
  return ['unknown'];
}

function summarizeBody(body = '') {
  const parsed = parseBody(body);
  const redactedFields = collectSensitiveFieldNames(parsed);
  return {
    bytes: body.length,
    redactedFields,
    jsonKeys: collectJsonKeys(parsed),
  };
}

function collectJsonKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(item => collectJsonKeys(item)))];
  }
  return [...new Set(Object.keys(value).concat(...Object.values(value).flatMap(collectJsonKeys)))];
}

function parseBody(body: string): unknown {
  if (!body) return '';
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function collectSensitiveFieldNames(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(item => collectSensitiveFieldNames(item)))];
  }

  const fields: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (/password|passwd|pwd|token|csrf|cookie|sessionid|authparam/i.test(key)) {
      fields.push(key);
    }
    fields.push(...collectSensitiveFieldNames(child));
  }
  return [...new Set(fields)];
}

function redactHeaders(headers: HeaderMap): HeaderMap {
  return redactSensitiveData(headers).data;
}

function payloadToBytes(payload: string | Uint8Array): Uint8Array {
  if (typeof payload === 'string') {
    return new TextEncoder().encode(payload);
  }
  return payload;
}

function detectFrameMagic(payload: string | Uint8Array): string | undefined {
  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  if (text.includes('AMI_IVTP_CONNECTION_ALLOWED')) return 'AMI_IVTP_CONNECTION_ALLOWED';
  return undefined;
}

function toHex(bytes: Uint8Array, take: number) {
  return Array.from(bytes.slice(0, take))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function createNetworkRecorder(options: CreateNetworkRecorderOptions) {
  const httpRequests = new Map<string, HttpRequestRecord>();
  const webSockets = new Map<string, WebSocketRecord>();
  const webSocketFrames: WebSocketFrameRecord[] = [];

  return {
    recordHttpRequest(input: HttpRequestInput) {
      httpRequests.set(input.id, {
        id: input.id,
        timestamp: input.timestamp,
        method: input.method,
        url: redactUrl(input.url),
        resourceType: input.resourceType,
        status: null,
        requestHeaders: redactHeaders(input.requestHeaders),
        responseHeaders: {},
        requestBodySummary: summarizeBody(input.requestBody),
        responseBodySummary: summarizeBody(),
        tags: tagHttp(input.url),
      });
    },
    recordHttpResponse(input: HttpResponseInput) {
      const existing = httpRequests.get(input.id);
      if (!existing) return;
      existing.status = input.status;
      existing.responseHeaders = redactHeaders(input.responseHeaders);
      existing.responseBodySummary = summarizeBody(input.responseBody);
    },
    recordHttpResponseBody(input: HttpResponseBodyInput) {
      const existing = httpRequests.get(input.id);
      if (!existing) return;
      existing.responseBodySummary = summarizeBody(input.responseBody);
    },
    recordWebSocketCreated(input: WebSocketCreatedInput) {
      webSockets.set(input.id, {
        id: input.id,
        createdAt: input.timestamp,
        url: redactUrl(input.url),
        subProtocols: input.subProtocols,
        requestHeaders: redactHeaders(input.requestHeaders),
        binaryFrameCount: 0,
        textFrameCount: 0,
        tags: tagWebSocket(input.url),
      });
    },
    recordWebSocketHandshake(input: WebSocketHandshakeInput) {
      const socket = webSockets.get(input.id);
      if (!socket) return;
      socket.subProtocols = input.subProtocols;
      socket.requestHeaders = redactHeaders(input.requestHeaders);
    },
    recordWebSocketClosed(input: WebSocketClosedInput) {
      const socket = webSockets.get(input.id);
      if (!socket) return;
      socket.closedAt = input.timestamp;
    },
    recordWebSocketFrame(input: WebSocketFrameInput) {
      const socket = webSockets.get(input.socketId);
      if (socket) {
        if (input.opcode === 'binary') socket.binaryFrameCount += 1;
        else socket.textFrameCount += 1;
      }

      const bytes = payloadToBytes(input.payload);
      const magic = detectFrameMagic(input.payload);
      webSocketFrames.push({
        socketId: input.socketId,
        timestamp: input.timestamp,
        direction: input.direction,
        opcode: input.opcode,
        bytes: bytes.length,
        headHex: toHex(bytes, options.frameHeadBytes),
        sampled: true,
        ...(magic ? { magic } : {}),
      });
    },
    toJSON(): NetworkRecorderSnapshot {
      return {
        httpRequests: Array.from(httpRequests.values()),
        webSockets: Array.from(webSockets.values()),
        webSocketFrames: [...webSocketFrames],
      };
    },
  };
}
