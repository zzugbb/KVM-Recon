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
        version: '0.2.2',
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
            mimeType: '',
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: request.responseBodySummary.bytes,
        },
        cache: {},
        timings: {
          send: -1,
          wait: -1,
          receive: -1,
        },
        comment: JSON.stringify({ resourceType: request.resourceType, tags: request.tags }),
      })),
    },
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
      path: 'ws/sockets.json',
      content: JSON.stringify(input.webSockets, null, 2),
    },
    {
      path: 'ws/frames.jsonl',
      content: toJsonl(input.webSocketFrames),
    },
  ];
}
