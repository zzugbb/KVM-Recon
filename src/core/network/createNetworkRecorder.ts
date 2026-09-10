import { redactSensitiveData, redactUrl } from '../redaction/redactSensitiveData';

type HeaderMap = Record<string, string>;
type HttpTag = 'login' | 'kvm-token' | 'kvm-entry';
type WebSocketTag = 'kvm-video' | 'vmedia' | 'unknown';
type StructuredBodySample =
  | string
  | number
  | boolean
  | null
  | StructuredBodySample[]
  | { [key: string]: StructuredBodySample };

interface CreateNetworkRecorderOptions {
  frameHeadBytes: number;
  idleQuietMs?: number;
  idleTimeoutMs?: number;
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
    sample?: StructuredBodySample;
  };
  responseBodySummary: {
    bytes: number;
    redactedFields: string[];
    jsonKeys?: string[];
    sample?: StructuredBodySample;
  };
  responseContentType?: string;
  redirectLocation?: string;
  responseStructure?: {
    bodyKind: 'json-object' | 'json-array' | 'form' | 'text' | 'html' | 'empty' | 'other';
    jsonKeys: string[];
    jsonShape: Record<string, string>;
    jsonPaths: Record<string, string>;
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
  handshakeStatus?: number;
  responseHeaders?: HeaderMap;
  responseSubProtocol?: string;
  binaryFrameCount: number;
  textFrameCount: number;
  tags: WebSocketTag[];
  windowRole?: 'main' | 'popup';
}

interface WebSocketHandshakeResponseInput {
  id: string;
  status: number;
  responseHeaders: HeaderMap;
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

export interface NetworkIdleResult {
  timedOut: boolean;
  pendingTaskCount: number;
  inFlightRequestIds: string[];
}

type HttpResponseStructure = NonNullable<HttpRequestRecord['responseStructure']>;

function headerValue(headers: HeaderMap, name: string): string {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] || '';
}

function hasLegacyKvmReferer(headers: HeaderMap) {
  const referer = `${headerValue(headers, 'referer')} ${headerValue(headers, 'referrer')}`.toLowerCase();
  return /\/bmc\/(?:pages\/remote\/kvm_by_html5\.html|resources\/js\/module\/remote\/html5\/)/.test(
    referer,
  );
}

function tagHttp(input: HttpRequestInput): HttpTag[] {
  const lower = input.url.toLowerCase();
  const isStaticAsset = /\.(?:png|jpe?g|gif|svg|ico|css|js|map|woff2?|ttf|eot)(?:[?#]|$)/i.test(lower);
  const explicitLogin =
    /\/api\/(?:secure_session|session|session_encrypted)|sessionservice\/sessions|sessionservice\.createsession|\/sysmgmt\/2015\/bmc\/session|\/json\/login_session|\/bmc\/php\/(?:dologin|login|gettoken)\.php/.test(
      lower,
    );
  const genericLogin = /(?:^|\/)(?:login|signin)(?:[/?#.]|$)/.test(lower);
  const interactiveRequest =
    input.method.toUpperCase() === 'POST' || /^(?:xhr|fetch)$/i.test(input.resourceType);
  const legacyKvmSupport =
    /\/bmc\/php\/(?:setpropertybymethod|getmultiproperty|processparameter|editcookie)\.php/.test(
      lower,
    ) && hasLegacyKvmReferer(input.requestHeaders);
  const tags: HttpTag[] = [];
  if (!isStaticAsset && (explicitLogin || (genericLogin && interactiveRequest))) {
    tags.push('login');
  }
  if (
    /kvm\/token|setkvmkey|starth5kvm|kvmservice|generate(?:startup)?file|\/bmc\/php\/gettoken\.php/.test(
      lower,
    ) ||
    legacyKvmSupport
  ) {
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
    /\/kvm(?:\/|\?|$)|\/kvm\/video|\/vnc\/vconsole|:5900\/(?:$|\?|vkvm\/?)|\/wss\/ircport|:(?:2198|2199|8208)\/(?:websocket)?(?:\?|$)/.test(
      lower,
    )
  ) {
    return ['kvm-video'];
  }
  if (/vm|media|cd-server/.test(lower)) return ['vmedia'];
  return ['unknown'];
}

function summarizeBody(body = '', contentType = '') {
  const parsed = parseBody(body, contentType);
  const redactedFields = collectSensitiveFieldNames(parsed);
  const sample = sampleStructuredBody(parsed);
  return {
    bytes: body.length,
    redactedFields,
    jsonKeys: collectJsonKeys(parsed),
    ...(sample === undefined ? {} : { sample }),
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

function structureBody(body = '', contentType = ''): HttpResponseStructure {
  const isForm = isUrlEncodedBody(body, contentType);
  const parsed = parseBody(body, contentType);
  let bodyKind: HttpResponseStructure['bodyKind'] = 'other';
  if (body === '') bodyKind = 'empty';
  else if (isForm) bodyKind = 'form';
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
    jsonPaths: collectJsonPaths(parsed),
  };
}

function collectJsonPaths(value: unknown, prefix = '$'): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const paths: Record<string, string> = {};
  if (Array.isArray(value)) {
    const first = value[0];
    if (first !== undefined) {
      Object.assign(paths, collectJsonPaths(first, `${prefix}[]`));
    }
    return paths;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    paths[path] = Array.isArray(child) ? 'array' : child === null ? 'null' : typeof child;
    Object.assign(paths, collectJsonPaths(child, path));
  }
  return paths;
}

function normalizeSample(value: unknown, key = '', depth = 0): StructuredBodySample {
  void key;
  if (depth > 6) return '<truncated>';
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const redactedUrl = redactUrl(value);
    return redactedUrl.length > 512 ? `${redactedUrl.slice(0, 512)}<truncated>` : redactedUrl;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map(item => normalizeSample(item, key, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, StructuredBodySample> = {};
    for (const [childKey, child] of Object.entries(value).slice(0, 80)) {
      output[childKey] = normalizeSample(child, childKey, depth + 1);
    }
    return output;
  }
  return String(value);
}

function redactTextSample(text: string): string {
  return redactUrl(text)
    .replace(/((?:password|passwd|pwd|token|csrf|cookie|sessionid|session_id|authparam|garc|x-auth-token)=)([^&;\s]+)/gi, (_match, prefix, value) => {
      return `${prefix}${redactSensitiveData({ value }).data.value}`;
    })
    .slice(0, 512);
}

function sampleStructuredBody(parsed: unknown): StructuredBodySample | undefined {
  if (typeof parsed === 'string') {
    const text = parsed.trim();
    if (!text || isHtmlText(text)) return undefined;
    return redactTextSample(text);
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  return redactSensitiveData(normalizeSample(parsed)).data;
}

function collectJsonKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(item => collectJsonKeys(item)))];
  }
  return [...new Set(Object.keys(value).concat(...Object.values(value).flatMap(collectJsonKeys)))];
}

function contentTypeFromHeaders(headers: HeaderMap): string {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
}

function isUrlEncodedBody(body: string, contentType = '') {
  if (!body) return false;
  if (/application\/x-www-form-urlencoded/i.test(contentType)) return true;
  const trimmed = body.trim();
  if (!trimmed || trimmed.includes('<') || trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return /^[A-Za-z0-9_.:%\-[\]]+=[\s\S]*$/.test(trimmed) && trimmed.includes('=');
}

function parseUrlEncodedBody(body: string): Record<string, string | string[]> {
  const params = new URLSearchParams(body);
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    const existing = output[key];
    if (existing === undefined) {
      output[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      output[key] = [existing, value];
    }
  }
  return output;
}

function parseBody(body: string, contentType = ''): unknown {
  if (!body) return '';
  if (isUrlEncodedBody(body, contentType)) {
    return parseUrlEncodedBody(body);
  }
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
  const pendingTasks = new Set<Promise<unknown>>();
  const inFlightHttpRequestIds = new Set<string>();
  let lastActivityAt = Date.now();
  let paused = false;

  function markActivity() {
    lastActivityAt = Date.now();
  }

  function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    trackPending(task: Promise<unknown>) {
      markActivity();
      pendingTasks.add(task);
      void task.finally(() => {
        pendingTasks.delete(task);
        markActivity();
      });
      return task;
    },
    async waitForIdle(): Promise<NetworkIdleResult> {
      const quietMs = options.idleQuietMs ?? 120;
      const timeoutMs = options.idleTimeoutMs ?? 5000;
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (
          pendingTasks.size === 0 &&
          inFlightHttpRequestIds.size === 0 &&
          Date.now() - lastActivityAt >= quietMs
        ) {
          return {
            timedOut: false,
            pendingTaskCount: 0,
            inFlightRequestIds: [],
          };
        }
        await sleep(Math.min(quietMs, 25));
      }
      return {
        timedOut: true,
        pendingTaskCount: pendingTasks.size,
        inFlightRequestIds: Array.from(inFlightHttpRequestIds).sort(),
      };
    },
    markHttpRequestFinished(id: string) {
      if (inFlightHttpRequestIds.delete(id)) {
        markActivity();
      }
    },
    setPaused(next: boolean) {
      paused = next;
    },
    isPaused() {
      return paused;
    },
    recordHttpRequest(input: HttpRequestInput) {
      if (paused) return;
      markActivity();
      inFlightHttpRequestIds.add(input.id);
      httpRequests.set(input.id, {
        id: input.id,
        timestamp: input.timestamp,
        method: input.method,
        url: redactUrl(input.url),
        resourceType: input.resourceType,
        status: null,
        requestHeaders: redactHeaders(input.requestHeaders),
        responseHeaders: {},
        requestBodySummary: summarizeBody(input.requestBody, contentTypeFromHeaders(input.requestHeaders)),
        responseBodySummary: summarizeBody(),
        responseContentType: '',
        redirectLocation: '',
        responseStructure: structureBody(),
        tags: tagHttp(input),
        ...(input.windowRole ? { windowRole: input.windowRole } : {}),
      });
    },
    recordHttpResponse(input: HttpResponseInput) {
      const existing = httpRequests.get(input.id);
      if (!existing) return;
      markActivity();
      existing.status = input.status;
      existing.responseHeaders = redactHeaders(input.responseHeaders);
      existing.responseBodySummary = summarizeBody(input.responseBody, contentTypeFromHeaders(input.responseHeaders));
      existing.responseContentType = responseContentType(input.responseHeaders);
      existing.redirectLocation = responseRedirectLocation(input.responseHeaders);
      existing.responseStructure = structureBody(input.responseBody, existing.responseContentType);
    },
    recordHttpResponseBody(input: HttpResponseBodyInput) {
      const existing = httpRequests.get(input.id);
      if (!existing) return;
      markActivity();
      existing.responseBodySummary = summarizeBody(input.responseBody, existing.responseContentType);
      existing.responseStructure = structureBody(input.responseBody, existing.responseContentType);
    },
    recordWebSocketCreated(input: WebSocketCreatedInput) {
      if (paused) return;
      webSockets.set(input.id, {
        id: input.id,
        createdAt: input.timestamp,
        url: redactUrl(input.url),
        subProtocols: input.subProtocols,
        requestHeaders: redactHeaders(input.requestHeaders),
        responseHeaders: {},
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
    recordWebSocketHandshakeResponse(input: WebSocketHandshakeResponseInput) {
      const socket = webSockets.get(input.id);
      if (!socket) return;
      const headers = redactHeaders(input.responseHeaders);
      socket.handshakeStatus = input.status;
      socket.responseHeaders = headers;
      socket.responseSubProtocol =
        Object.entries(headers).find(([key]) => key.toLowerCase() === 'sec-websocket-protocol')?.[1] || '';
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
