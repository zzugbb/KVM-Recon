import { APP_VERSION } from '../../version';
import type { HttpRequestRecord, WebSocketFrameRecord, WebSocketRecord } from './createNetworkRecorder';
import {
  correlatedKvmLaunchHttpIds,
  correlatedLoginHttpIds,
  isExplicitKvmLaunchRequest,
} from '../readiness/kvmLaunchCorrelation';
import { sourceFilePath, type SourceFileRecord } from './sourceCapture';

interface NetworkArtifact {
  path: string;
  content: string;
}

interface BuildNetworkArtifactsInput {
  httpRequests: HttpRequestRecord[];
  webSockets: WebSocketRecord[];
  webSocketFrames: WebSocketFrameRecord[];
  sourceFiles?: SourceFileRecord[];
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
          networkRequestId: request.networkRequestId,
          redirectHop: request.redirectHop,
          redirectedFromId: request.redirectedFromId,
          redirectedToId: request.redirectedToId,
          streaming: request.streaming,
          tags: request.tags,
          responseBodyCaptured: request.responseBodyCaptured,
          responseBodySkippedReason: request.responseBodySkippedReason,
          requestBodySample: request.requestBodySummary.sample,
          requestBodySkippedReason: request.requestBodySkippedReason,
          requestBodyCaptured: request.requestBodyCaptured,
          responseBodySample: request.responseBodySummary.sample,
          responseStructure: request.responseStructure,
          windowRole: request.windowRole,
          captureWindowId: request.captureWindowId,
          openerCaptureWindowId: request.openerCaptureWindowId,
          ancestorCaptureWindowIds: request.ancestorCaptureWindowIds,
          sourceKind: request.sourceKind,
          sourceSha256: request.sourceSha256,
          sourceBytes: request.sourceBytes,
          sourceTruncated: request.sourceTruncated,
        }),
      })),
    },
  };
}

function buildAdapterEvidence(input: BuildNetworkArtifactsInput) {
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
        redirectHop: request.redirectHop ?? 0,
        redirectedFromId: request.redirectedFromId || '',
        redirectedToId: request.redirectedToId || '',
        tags: request.tags,
        ...(request.windowRole ? { windowRole: request.windowRole } : {}),
        ...(request.captureWindowId ? { captureWindowId: request.captureWindowId } : {}),
        ...(request.openerCaptureWindowId ? { openerCaptureWindowId: request.openerCaptureWindowId } : {}),
        ...(request.ancestorCaptureWindowIds?.length
          ? { ancestorCaptureWindowIds: request.ancestorCaptureWindowIds }
          : {}),
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
      .filter(request => isExplicitKvmLaunchRequest(request, false))
      .map(request => ({
        id: request.id,
        method: request.method,
        url: request.url,
        status: request.status,
        contentType: request.responseContentType,
        redirectLocation: request.redirectLocation,
        redirectHop: request.redirectHop ?? 0,
        redirectedFromId: request.redirectedFromId || '',
        redirectedToId: request.redirectedToId || '',
        tags: request.tags,
        ...(request.windowRole ? { windowRole: request.windowRole } : {}),
        ...(request.captureWindowId ? { captureWindowId: request.captureWindowId } : {}),
        ...(request.openerCaptureWindowId ? { openerCaptureWindowId: request.openerCaptureWindowId } : {}),
        ...(request.ancestorCaptureWindowIds?.length
          ? { ancestorCaptureWindowIds: request.ancestorCaptureWindowIds }
          : {}),
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
        sampledFrameCount: socket.sampledFrameCount ?? 0,
        droppedFrameCount: socket.droppedFrameCount ?? 0,
        tags: socket.tags,
        ...(socket.windowRole ? { windowRole: socket.windowRole } : {}),
        ...(socket.captureWindowId ? { captureWindowId: socket.captureWindowId } : {}),
        ...(socket.openerCaptureWindowId ? { openerCaptureWindowId: socket.openerCaptureWindowId } : {}),
        ...(socket.ancestorCaptureWindowIds?.length
          ? { ancestorCaptureWindowIds: socket.ancestorCaptureWindowIds }
          : {}),
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
    correlations: input.webSockets.map(socket => ({
        socketId: socket.id,
        ...(socket.captureWindowId ? { captureWindowId: socket.captureWindowId } : {}),
        ...(socket.openerCaptureWindowId ? { openerCaptureWindowId: socket.openerCaptureWindowId } : {}),
        ...(socket.ancestorCaptureWindowIds?.length
          ? { ancestorCaptureWindowIds: socket.ancestorCaptureWindowIds }
          : {}),
        ...(socket.windowRole ? { windowRole: socket.windowRole } : {}),
        likelyLoginHttpIds: correlatedLoginHttpIds(input.httpRequests, socket),
        likelyKvmLaunchHttpIds: correlatedKvmLaunchHttpIds(input.httpRequests, socket),
      })),
  };
}

export function buildNetworkArtifacts(input: BuildNetworkArtifactsInput): NetworkArtifact[] {
  const sourceFiles = input.sourceFiles || [];
  const sourceArtifacts = sourceFiles.flatMap(file => {
    const path = sourceFilePath(file.id, file.kind);
    return [
      {
        path,
        content: file.text,
      },
    ];
  });
  const inventory = sourceFiles.map(file => ({
    id: file.id,
    url: file.url,
    kind: file.kind,
    sha256: file.sha256,
    bytes: file.bytes,
    truncated: file.truncated,
    path: sourceFilePath(file.id, file.kind),
  }));
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
    ...(inventory.length
      ? [
          {
            path: 'http/sources.json',
            content: JSON.stringify({ files: inventory }, null, 2),
          },
          ...sourceArtifacts,
        ]
      : []),
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
