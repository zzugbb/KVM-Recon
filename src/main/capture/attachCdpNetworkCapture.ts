import { Buffer } from 'node:buffer';

import type { createNetworkRecorder } from '../../core/network/createNetworkRecorder';

type NetworkRecorder = ReturnType<typeof createNetworkRecorder>;

export interface CdpDebuggerLike {
  attach(protocolVersion: string): Promise<void> | void;
  sendCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> | unknown;
  on(
    event: 'message',
    listener: (
      event: unknown,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => void,
  ): void;
}

interface AttachCdpNetworkCaptureInput {
  cdp: CdpDebuggerLike;
  recorder: NetworkRecorder;
  now?: () => string;
  windowRole?: 'main' | 'popup';
}

type HeaderMap = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function headersValue(value: unknown): HeaderMap {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, nextValue]) => [key, nextValue]),
  );
}

function protocolList(headers: HeaderMap): string[] {
  const protocolHeader = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === 'sec-websocket-protocol',
  )?.[1];
  if (!protocolHeader) return [];
  return protocolHeader
    .split(',')
    .map(protocol => protocol.trim())
    .filter(Boolean);
}

function decodeFramePayload(payloadData: string, opcode: 'text' | 'binary'): string | Uint8Array {
  if (opcode === 'text') return payloadData;
  return new Uint8Array(Buffer.from(payloadData, 'base64'));
}

function decodeResponseBody(result: unknown): string {
  if (!isRecord(result)) return '';
  const body = stringValue(result.body);
  if (result.base64Encoded === true) {
    return Buffer.from(body, 'base64').toString('utf8');
  }
  return body;
}

function opcodeName(opcode: number): 'text' | 'binary' {
  return opcode === 1 ? 'text' : 'binary';
}

function scopedId(requestId: string, sessionId?: string) {
  return sessionId ? `${sessionId}::${requestId}` : requestId;
}

const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

interface ResponseCaptureMetadata {
  id: string;
  url: string;
  resourceType: string;
  contentType: string;
}

interface RequestChainState {
  hopIds: string[];
  pendingRequestHeaders: HeaderMap[];
  pendingResponseHeaders: Array<{ status: number; headers: HeaderMap }>;
  requestExtraHopIds: string[];
  requestExtraHopSet: Set<string>;
  responseExtraHopIds: string[];
  responseExtraHopSet: Set<string>;
  extraInfoDecisionHopSet: Set<string>;
}

function bodySkipReason(metadata: ResponseCaptureMetadata | undefined, encodedBytes: number) {
  if (!metadata) return 'missing-response-metadata';
  if (/^(?:data|blob):/i.test(metadata.url)) return 'inline-or-blob-url';
  if (encodedBytes > MAX_RESPONSE_BODY_BYTES) return `response-too-large:${encodedBytes}`;
  if (/^(?:eventsource|websocket)$/i.test(metadata.resourceType)) return 'streaming-resource';
  if (/^(?:image|media|font|stylesheet)$/i.test(metadata.resourceType)) {
    return `binary-resource:${metadata.resourceType.toLowerCase()}`;
  }
  if (
    /^(?:image|audio|video|font)\//i.test(metadata.contentType) ||
    /application\/(?:octet-stream|pdf|zip|x-rar|wasm)/i.test(metadata.contentType) ||
    /text\/event-stream/i.test(metadata.contentType)
  ) {
    return `unsupported-content-type:${metadata.contentType}`;
  }
  return '';
}

export async function attachCdpNetworkCapture(input: AttachCdpNetworkCaptureInput): Promise<void> {
  const now = input.now ?? (() => new Date().toISOString());
  const requestChains = new Map<string, RequestChainState>();
  const responseMetadata = new Map<string, ResponseCaptureMetadata>();
  const ignoredRequestIds = new Set<string>();

  function chainFor(baseId: string) {
    const existing = requestChains.get(baseId);
    if (existing) return existing;
    const created: RequestChainState = {
      hopIds: [],
      pendingRequestHeaders: [],
      pendingResponseHeaders: [],
      requestExtraHopIds: [],
      requestExtraHopSet: new Set(),
      responseExtraHopIds: [],
      responseExtraHopSet: new Set(),
      extraInfoDecisionHopSet: new Set(),
    };
    requestChains.set(baseId, created);
    return created;
  }

  function activeHopId(baseId: string) {
    const ids = requestChains.get(baseId)?.hopIds || [];
    return ids[ids.length - 1] || baseId;
  }

  function drainExtraInfo(baseId: string) {
    const chain = chainFor(baseId);
    while (chain.pendingRequestHeaders.length > 0 && chain.requestExtraHopIds.length > 0) {
      input.recorder.mergeHttpRequestHeaders(
        chain.requestExtraHopIds.shift()!,
        chain.pendingRequestHeaders.shift()!,
      );
    }
    while (chain.pendingResponseHeaders.length > 0 && chain.responseExtraHopIds.length > 0) {
      const extra = chain.pendingResponseHeaders.shift()!;
      const id = chain.responseExtraHopIds.shift()!;
      input.recorder.recordHttpResponse({
        id,
        status: extra.status,
        responseHeaders: extra.headers,
      });
      const metadata = responseMetadata.get(id);
      if (metadata && !metadata.contentType) {
        metadata.contentType =
          Object.entries(extra.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ||
          '';
      }
    }
  }

  function expectExtraInfo(baseId: string, id: string, expected: boolean) {
    const chain = chainFor(baseId);
    chain.extraInfoDecisionHopSet.add(id);
    if (!expected) return;
    if (!chain.requestExtraHopSet.has(id)) {
      chain.requestExtraHopIds.push(id);
      chain.requestExtraHopSet.add(id);
    }
    if (!chain.responseExtraHopSet.has(id)) {
      chain.responseExtraHopIds.push(id);
      chain.responseExtraHopSet.add(id);
    }
    drainExtraInfo(baseId);
  }

  function expectFinalExtraInfoIfUnknown(baseId: string, id: string) {
    const chain = chainFor(baseId);
    if (!chain.extraInfoDecisionHopSet.has(id)) {
      expectExtraInfo(baseId, id, true);
    }
  }

  async function recordResponseBody(requestId: string, id: string, sessionId?: string) {
    try {
      const result = await input.cdp.sendCommand('Network.getResponseBody', { requestId }, sessionId);
      const responseBody = decodeResponseBody(result);
      const responseBytes = Buffer.byteLength(responseBody, 'utf8');
      if (responseBytes > MAX_RESPONSE_BODY_BYTES) {
        input.recorder.markHttpResponseBodySkipped(id, `response-too-large:${responseBytes}`);
        return;
      }
      input.recorder.recordHttpResponseBody({
        id,
        responseBody,
      });
    } catch {
      // 捕获响应体不可读取：可能由缓存、重定向、二进制流或 CDP 生命周期限制导致
      // 策略：保留请求/响应头和状态码，跳过 body 摘要，避免中断现场采集
      input.recorder.markHttpResponseBodySkipped(id, 'get-response-body-failed');
    }
  }

  await input.cdp.attach('1.3');
  await input.cdp.sendCommand('Network.enable');
  try {
    await input.cdp.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (error) {
    // 捕获旧 Chromium/Electron 不支持 Target auto-attach：保留当前 webContents 的 Network 采集
    // 策略：不阻断现场采集，弹窗仍由 Electron did-create-window 单独附加
    void error;
  }

  input.cdp.on('message', (_event, method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') {
      const attachedSessionId = stringValue(params.sessionId);
      if (attachedSessionId) {
        void input.cdp.sendCommand('Network.enable', {}, attachedSessionId);
      }
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const request = isRecord(params.request) ? params.request : {};
      const requestId = stringValue(params.requestId);
      const baseId = scopedId(requestId, sessionId);
      const url = stringValue(request.url);
      if (/^(?:data|blob):/i.test(url)) {
        ignoredRequestIds.add(baseId);
        return;
      }
      const chain = chainFor(baseId);
      const redirectResponse = isRecord(params.redirectResponse) ? params.redirectResponse : null;
      const redirectedFromId = redirectResponse ? chain.hopIds[chain.hopIds.length - 1] : undefined;
      if (redirectResponse && redirectedFromId) {
        expectExtraInfo(baseId, redirectedFromId, params.redirectHasExtraInfo !== false);
        input.recorder.recordHttpResponse({
          id: redirectedFromId,
          status: numberValue(redirectResponse.status),
          responseHeaders: headersValue(redirectResponse.headers),
        });
        input.recorder.markHttpResponseBodySkipped(redirectedFromId, 'redirect-response');
        input.recorder.markHttpRequestFinished(redirectedFromId);
      }
      const redirectHop = chain.hopIds.length;
      const id = redirectHop === 0 ? baseId : `${baseId}::redirect-${redirectHop}`;
      chain.hopIds.push(id);
      input.recorder.recordHttpRequest({
        id,
        timestamp: now(),
        method: stringValue(request.method),
        url,
        resourceType: stringValue(params.type),
        requestHeaders: headersValue(request.headers),
        requestBody: stringValue(request.postData),
        networkRequestId: baseId,
        redirectHop,
        redirectedFromId,
        windowRole: input.windowRole,
      });
      responseMetadata.set(id, {
        id,
        url,
        resourceType: stringValue(params.type),
        contentType: '',
      });
      drainExtraInfo(baseId);
      return;
    }

    if (method === 'Network.requestWillBeSentExtraInfo') {
      const baseId = scopedId(stringValue(params.requestId), sessionId);
      if (ignoredRequestIds.has(baseId)) return;
      chainFor(baseId).pendingRequestHeaders.push(headersValue(params.headers));
      drainExtraInfo(baseId);
      return;
    }

    if (method === 'Network.responseReceived') {
      const response = isRecord(params.response) ? params.response : {};
      const requestId = stringValue(params.requestId);
      const baseId = scopedId(requestId, sessionId);
      if (ignoredRequestIds.has(baseId)) return;
      const id = activeHopId(baseId);
      const headers = headersValue(response.headers);
      expectExtraInfo(baseId, id, params.hasExtraInfo !== false);
      input.recorder.recordHttpResponse({
        id,
        status: numberValue(response.status),
        responseHeaders: headers,
      });
      const metadata = responseMetadata.get(id);
      if (metadata) {
        metadata.contentType =
          stringValue(response.mimeType) ||
          Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ||
          '';
      }
      return;
    }

    if (method === 'Network.responseReceivedExtraInfo') {
      const baseId = scopedId(stringValue(params.requestId), sessionId);
      if (ignoredRequestIds.has(baseId)) return;
      chainFor(baseId).pendingResponseHeaders.push({
        status: numberValue(params.statusCode),
        headers: headersValue(params.headers),
      });
      drainExtraInfo(baseId);
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = stringValue(params.requestId);
      const baseId = scopedId(requestId, sessionId);
      if (ignoredRequestIds.has(baseId)) return;
      const id = activeHopId(baseId);
      expectFinalExtraInfoIfUnknown(baseId, id);
      input.recorder.markHttpRequestFinished(id);
      const reason = bodySkipReason(responseMetadata.get(id), numberValue(params.encodedDataLength));
      if (reason) {
        input.recorder.markHttpResponseBodySkipped(id, reason);
      } else {
        input.recorder.trackPending(recordResponseBody(requestId, id, sessionId));
      }
      return;
    }

    if (method === 'Network.loadingFailed') {
      const baseId = scopedId(stringValue(params.requestId), sessionId);
      if (ignoredRequestIds.has(baseId)) return;
      const id = activeHopId(baseId);
      expectFinalExtraInfoIfUnknown(baseId, id);
      input.recorder.markHttpRequestFinished(id);
      input.recorder.markHttpResponseBodySkipped(id, 'loading-failed');
      return;
    }

    if (method === 'Network.webSocketCreated') {
      const requestId = stringValue(params.requestId);
      input.recorder.recordWebSocketCreated({
        id: scopedId(requestId, sessionId),
        timestamp: now(),
        url: stringValue(params.url),
        subProtocols: [],
        requestHeaders: {},
        windowRole: input.windowRole,
      });
      return;
    }

    if (method === 'Network.webSocketWillSendHandshakeRequest') {
      const request = isRecord(params.request) ? params.request : {};
      const headers = headersValue(request.headers);
      const requestId = stringValue(params.requestId);
      input.recorder.recordWebSocketHandshake({
        id: scopedId(requestId, sessionId),
        subProtocols: protocolList(headers),
        requestHeaders: headers,
      });
      return;
    }

    if (method === 'Network.webSocketHandshakeResponseReceived') {
      const response = isRecord(params.response) ? params.response : {};
      const requestId = stringValue(params.requestId);
      input.recorder.recordWebSocketHandshakeResponse({
        id: scopedId(requestId, sessionId),
        status: numberValue(response.status),
        responseHeaders: headersValue(response.headers),
      });
      return;
    }

    if (method === 'Network.webSocketClosed') {
      const requestId = stringValue(params.requestId);
      input.recorder.recordWebSocketClosed({
        id: scopedId(requestId, sessionId),
        timestamp: now(),
      });
      return;
    }

    if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
      const response = isRecord(params.response) ? params.response : {};
      const opcode = opcodeName(numberValue(response.opcode));
      const requestId = stringValue(params.requestId);
      input.recorder.recordWebSocketFrame({
        socketId: scopedId(requestId, sessionId),
        timestamp: now(),
        direction: method === 'Network.webSocketFrameSent' ? 'up' : 'down',
        opcode,
        payload: decodeFramePayload(stringValue(response.payloadData), opcode),
      });
    }
  });
}
