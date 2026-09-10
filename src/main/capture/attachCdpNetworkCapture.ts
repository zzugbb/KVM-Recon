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

export async function attachCdpNetworkCapture(input: AttachCdpNetworkCaptureInput): Promise<void> {
  const now = input.now ?? (() => new Date().toISOString());

  async function recordResponseBody(requestId: string, sessionId?: string) {
    const id = scopedId(requestId, sessionId);
    try {
      const result = await input.cdp.sendCommand('Network.getResponseBody', { requestId }, sessionId);
      input.recorder.recordHttpResponseBody({
        id,
        responseBody: decodeResponseBody(result),
      });
    } catch {
      // 捕获响应体不可读取：可能由缓存、重定向、二进制流或 CDP 生命周期限制导致
      // 策略：保留请求/响应头和状态码，跳过 body 摘要，避免中断现场采集
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
      input.recorder.recordHttpRequest({
        id: scopedId(requestId, sessionId),
        timestamp: now(),
        method: stringValue(request.method),
        url: stringValue(request.url),
        resourceType: stringValue(params.type),
        requestHeaders: headersValue(request.headers),
        requestBody: stringValue(request.postData),
        windowRole: input.windowRole,
      });
      return;
    }

    if (method === 'Network.responseReceived') {
      const response = isRecord(params.response) ? params.response : {};
      const requestId = stringValue(params.requestId);
      input.recorder.recordHttpResponse({
        id: scopedId(requestId, sessionId),
        status: numberValue(response.status),
        responseHeaders: headersValue(response.headers),
      });
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = stringValue(params.requestId);
      input.recorder.markHttpRequestFinished(scopedId(requestId, sessionId));
      input.recorder.trackPending(recordResponseBody(requestId, sessionId));
      return;
    }

    if (method === 'Network.loadingFailed') {
      input.recorder.markHttpRequestFinished(scopedId(stringValue(params.requestId), sessionId));
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
