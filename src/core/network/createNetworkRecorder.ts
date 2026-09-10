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
  windowRole?: 'main' | 'popup';
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
  responseContentType?: string;
  redirectLocation?: string;
  responseStructure?: {
    bodyKind: 'json-object' | 'json-array' | 'text' | 'html' | 'empty' | 'other';
    jsonKeys: string[];
    jsonShape: Record<string, string>;
  };
  tags: HttpTag[];
  windowRole?: 'main' | 'popup';
}

interface WebSocketCreatedInput {
  id: string;
  timestamp: string;
  url: string;
  subProtocols: string[];
  requestHeaders: HeaderMap;
  windowRole?: 'main' | 'popup';
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
  windowRole?: 'main' | 'popup';
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

type HttpResponseStructure = NonNullable<HttpRequestRecord['responseStructure']>;

function tagHttp(url: string): HttpTag[] {
  const lower = url.toLowerCase();
  const tags: HttpTag[] = [];
  if (
    /\/api\/(?:secure_session|session|session_encrypted)|sessionservice\/sessions|sessionservice\.createsession|\/sysmgmt\/2015\/bmc\/session|\/json\/login_session|login/.test(
      lower,
    )
  ) {
    tags.push('login');
  }
  if (/kvm\/token|setkvmkey|starth5kvm|kvmservice|generate(?:startup)?file/.test(lower)) {
    tags.push('kvm-token');
  }
  if (/kvm|console|viewer|vconsole|ircport|\/irc\.js|\/wss\/irc|\/vnc\//.test(lower) && !tags.includes('kvm-token')) {
    tags.push('kvm-entry');
  }
  return tags;
}

function tagWebSocket(url: string): WebSocketTag[] {
  const lower = url.toLowerCase();
  if (
    /\/kvm(?:\/|\?|$)|\/kvm\/video|\/websocket(?:\?|$)|\/vnc\/vconsole|:5900\/(?:$|\?|vkvm\/?)|\/wss\/ircport|:(?:2198|2199|8208)\/(?:websocket)?(?:\?|$)/.test(
      lower,
    )
  ) {
    return ['kvm-video'];
  }
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

function responseContentType(headers: HeaderMap): string {
  return (
    Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || ''
  );
}

function responseRedirectLocation(headers: HeaderMap): string {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === 'location')?.[1] || '';
}

function isHtmlText(text: string) {
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 512).toLowerCase();
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    /^<html[\s>]/.test(head) ||
    (head.includes('<head') && head.includes('<body'))
  );
}

function structureBody(body = ''): HttpResponseStructure {
  const parsed = parseBody(body);
  let bodyKind: HttpResponseStructure['bodyKind'] = 'other';
  if (body === '') bodyKind = 'empty';
  else if (typeof parsed === 'string' && isHtmlText(parsed)) bodyKind = 'html';
  else if (Array.isArray(parsed)) bodyKind = 'json-array';
  else if (parsed && typeof parsed === 'object') bodyKind = 'json-object';
  else if (typeof parsed === 'string') bodyKind = 'text';

  const jsonShape: Record<string, string> = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      jsonShape[key] = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    }
  }

  return {
    bodyKind,
    jsonKeys: collectJsonKeys(parsed),
    jsonShape,
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
  const bytes = payloadToBytes(payload);
  const text =
    typeof payload === 'string' ? payload : new TextDecoder('utf8', { fatal: false }).decode(payload);
  if (text.includes('AMI_IVTP_CONNECTION_ALLOWED')) return 'AMI_IVTP_CONNECTION_ALLOWED';
  if (text.startsWith('RFB 003.')) return text.trim();
  if (text.startsWith('APCP')) return 'DELL_APCP';
  if (bytes[0] === 0xfe && bytes[1] === 0xf6) return 'HUAWEI_KVM_FEF6';
  if ([0x13, 0x14, 0x17, 0x22, 0x35, 0x3a, 0x50, 0x53].includes(bytes[0] || 0)) {
    return 'AMI_IVTP_BINARY';
  }
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
  let paused = false;

  return {
    setPaused(next: boolean) {
      paused = next;
    },
    isPaused() {
      return paused;
    },
    recordHttpRequest(input: HttpRequestInput) {
      if (paused) return;
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
        responseContentType: '',
        redirectLocation: '',
        responseStructure: structureBody(),
        tags: tagHttp(input.url),
        ...(input.windowRole ? { windowRole: input.windowRole } : {}),
      });
    },
    recordHttpResponse(input: HttpResponseInput) {
      const existing = httpRequests.get(input.id);
      if (!existing) return;
      existing.status = input.status;
      existing.responseHeaders = redactHeaders(input.responseHeaders);
      existing.responseBodySummary = summarizeBody(input.responseBody);
      existing.responseContentType = responseContentType(input.responseHeaders);
      existing.redirectLocation = responseRedirectLocation(input.responseHeaders);
      existing.responseStructure = structureBody(input.responseBody);
    },
    recordHttpResponseBody(input: HttpResponseBodyInput) {
      const existing = httpRequests.get(input.id);
      if (!existing) return;
      existing.responseBodySummary = summarizeBody(input.responseBody);
      existing.responseStructure = structureBody(input.responseBody);
    },
    recordWebSocketCreated(input: WebSocketCreatedInput) {
      if (paused) return;
      webSockets.set(input.id, {
        id: input.id,
        createdAt: input.timestamp,
        url: redactUrl(input.url),
        subProtocols: input.subProtocols,
        requestHeaders: redactHeaders(input.requestHeaders),
        binaryFrameCount: 0,
        textFrameCount: 0,
        tags: tagWebSocket(input.url),
        ...(input.windowRole ? { windowRole: input.windowRole } : {}),
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
      if (paused) return;
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
