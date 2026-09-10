import { APP_VERSION } from '../../version';
import type { HttpRequestRecord, WebSocketFrameRecord, WebSocketRecord } from './createNetworkRecorder';

interface NetworkArtifact {
  path: string;
  content: string;
}

interface BuildNetworkArtifactsInput {
  httpRequests: HttpRequestRecord[];
  webSockets: WebSocketRecord[];
  webSocketFrames: WebSocketFrameRecord[];
}

function toJsonl(records: unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n');
}

function buildHar(httpRequests: HttpRequestRecord[]) {
  return {
    log: {
      version: '1.2',
      creator: {
        name: 'KVM-Recon',
        version: APP_VERSION,
      },
      entries: httpRequests.map(request => ({
        startedDateTime: request.timestamp,
        time: -1,
        request: {
          method: request.method,
          url: request.url,
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(request.requestHeaders).map(([name, value]) => ({ name, value })),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: request.requestBodySummary.bytes,
        },
        response: {
          status: request.status ?? 0,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(request.responseHeaders).map(([name, value]) => ({ name, value })),
          cookies: [],
          content: {
            size: request.responseBodySummary.bytes,
            mimeType: request.responseContentType || '',
          },
          redirectURL: request.redirectLocation || '',
          headersSize: -1,
          bodySize: request.responseBodySummary.bytes,
        },
        cache: {},
        timings: {
          send: -1,
          wait: -1,
          receive: -1,
        },
        comment: JSON.stringify({
          resourceType: request.resourceType,
          tags: request.tags,
          requestBodySample: request.requestBodySummary.sample,
          responseBodySample: request.responseBodySummary.sample,
          responseStructure: request.responseStructure,
        }),
      })),
    },
  };
}

function buildAdapterEvidence(input: BuildNetworkArtifactsInput) {
  const keyRequestIds = new Set(
    input.httpRequests
      .filter(request => request.tags.length > 0)
      .map(request => request.id),
  );
  const firstFrameBySocket = new Map<string, WebSocketFrameRecord>();
  for (const frame of input.webSocketFrames) {
    if (!firstFrameBySocket.has(frame.socketId)) {
      firstFrameBySocket.set(frame.socketId, frame);
    }
  }

  return {
    loginChain: input.httpRequests
      .filter(request => request.tags.includes('login'))
      .map(request => ({
        id: request.id,
        method: request.method,
        url: request.url,
        status: request.status,
        contentType: request.responseContentType,
        redirectLocation: request.redirectLocation,
        requestJsonKeys: request.requestBodySummary.jsonKeys || [],
        responseJsonKeys: request.responseBodySummary.jsonKeys || [],
        redactedFields: [
          ...request.requestBodySummary.redactedFields,
          ...request.responseBodySummary.redactedFields,
        ],
        requestBodySample: request.requestBodySummary.sample || null,
        responseBodySample: request.responseBodySummary.sample || null,
        responseStructure: request.responseStructure,
      })),
    kvmLaunchChain: input.httpRequests
      .filter(request => request.tags.includes('kvm-token') || request.tags.includes('kvm-entry'))
      .map(request => ({
        id: request.id,
        method: request.method,
        url: request.url,
        status: request.status,
        contentType: request.responseContentType,
        redirectLocation: request.redirectLocation,
        tags: request.tags,
        requestBodySample: request.requestBodySummary.sample || null,
        responseBodySample: request.responseBodySummary.sample || null,
        responseStructure: request.responseStructure,
      })),
    webSocketUpgrades: input.webSockets.map(socket => {
      const firstFrame = firstFrameBySocket.get(socket.id);
      return {
        id: socket.id,
        url: socket.url,
        subProtocols: socket.subProtocols,
        requestHeaderNames: Object.keys(socket.requestHeaders),
        handshakeStatus: socket.handshakeStatus || null,
        responseHeaderNames: Object.keys(socket.responseHeaders || {}),
        responseSubProtocol: socket.responseSubProtocol || '',
        binaryFrameCount: socket.binaryFrameCount,
        textFrameCount: socket.textFrameCount,
        tags: socket.tags,
        windowRole: socket.windowRole || '',
        firstFrame: firstFrame
          ? {
              direction: firstFrame.direction,
              opcode: firstFrame.opcode,
              bytes: firstFrame.bytes,
              headHex: firstFrame.headHex,
              magic: firstFrame.magic || '',
            }
          : null,
      };
    }),
    correlations: input.webSockets.map(socket => {
      const preceding = input.httpRequests.filter(
        request => keyRequestIds.has(request.id) && request.timestamp <= socket.createdAt,
      );
      return {
        socketId: socket.id,
        likelyLoginHttpIds: preceding
          .filter(request => request.tags.includes('login'))
          .slice(-4)
          .map(request => request.id),
        likelyKvmLaunchHttpIds: preceding
          .filter(request => request.tags.includes('kvm-token') || request.tags.includes('kvm-entry'))
          .slice(-6)
          .map(request => request.id),
      };
    }),
  };
}

export function buildNetworkArtifacts(input: BuildNetworkArtifactsInput): NetworkArtifact[] {
  return [
    {
      path: 'http/requests.jsonl',
      content: toJsonl(input.httpRequests),
    },
    {
      path: 'http/har.json',
      content: JSON.stringify(buildHar(input.httpRequests), null, 2),
    },
    {
      path: 'http/adapter-evidence.json',
      content: JSON.stringify(buildAdapterEvidence(input), null, 2),
    },
    {
      path: 'ws/sockets.json',
      content: JSON.stringify(input.webSockets, null, 2),
    },
    {
      path: 'ws/frames.jsonl',
      content: toJsonl(input.webSocketFrames),
    },
  ];
}
