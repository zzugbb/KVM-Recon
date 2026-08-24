import { describe, expect, it } from 'vitest';

import { createNetworkRecorder } from './createNetworkRecorder';

describe('createNetworkRecorder', () => {
  it('records HTTP summaries and tags login, token, and KVM entry requests', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 8 });

    recorder.recordHttpRequest({
      id: 'req-1',
      timestamp: '2026-08-24T12:00:00.000+08:00',
      method: 'POST',
      url: 'https://10.0.0.10/api/session',
      resourceType: 'xhr',
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: '{"UserName":"admin","Password":"secret-password"}',
    });
    recorder.recordHttpResponse({
      id: 'req-1',
      status: 200,
      responseHeaders: { 'set-cookie': 'QSESSIONID=abc123' },
      responseBody: '{"CSRFToken":"csrf-123"}',
    });

    recorder.recordHttpRequest({
      id: 'req-2',
      timestamp: '2026-08-24T12:00:01.000+08:00',
      method: 'GET',
      url: 'https://10.0.0.10/api/kvm/token',
      resourceType: 'xhr',
      requestHeaders: {},
    });
    recorder.recordHttpResponse({
      id: 'req-2',
      status: 200,
      responseHeaders: {},
      responseBody: '{"token":"kvm-token"}',
    });

    const records = recorder.toJSON().httpRequests;

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: 'req-1',
      status: 200,
      tags: ['login'],
      requestBodySummary: {
        bytes: 49,
        redactedFields: ['Password'],
      },
    });
    expect(JSON.stringify(records[0])).not.toContain('secret-password');
    expect(records[1].tags).toEqual(['kvm-token']);
  });

  it('records WebSocket sockets and samples frame metadata without full payloads', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });

    recorder.recordWebSocketCreated({
      id: 'ws-1',
      timestamp: '2026-08-24T12:00:02.000+08:00',
      url: 'wss://10.0.0.10/kvm',
      subProtocols: ['binary'],
      requestHeaders: {
        Cookie: 'QSESSIONID=abc123',
      },
    });
    recorder.recordWebSocketFrame({
      socketId: 'ws-1',
      timestamp: '2026-08-24T12:00:02.100+08:00',
      direction: 'down',
      opcode: 'binary',
      payload: new Uint8Array([0x17, 0x00, 0x00, 0x01, 0xff, 0xee]),
    });
    recorder.recordWebSocketFrame({
      socketId: 'ws-1',
      timestamp: '2026-08-24T12:00:02.200+08:00',
      direction: 'down',
      opcode: 'binary',
      payload: new Uint8Array([0x19, 0xaa, 0xbb, 0xcc, 0xdd]),
    });

    const snapshot = recorder.toJSON();

    expect(snapshot.webSockets[0]).toMatchObject({
      id: 'ws-1',
      url: 'wss://10.0.0.10/kvm',
      subProtocols: ['binary'],
      binaryFrameCount: 2,
      textFrameCount: 0,
      tags: ['kvm-video'],
    });
    expect(JSON.stringify(snapshot.webSockets[0])).not.toContain('abc123');
    expect(snapshot.webSocketFrames[0]).toMatchObject({
      socketId: 'ws-1',
      direction: 'down',
      bytes: 6,
      headHex: '17000001',
      sampled: true,
    });
    expect(snapshot.webSocketFrames[1]).toMatchObject({
      bytes: 5,
      headHex: '19aabbcc',
      sampled: true,
    });
  });

  it('records printable WebSocket handshake magic without storing the full stream', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 8 });
    recorder.recordWebSocketCreated({
      id: 'ws-1',
      timestamp: '2026-08-24T12:00:02.000+08:00',
      url: 'wss://10.0.0.10/kvm',
      subProtocols: ['binary'],
      requestHeaders: {},
    });
    recorder.recordWebSocketFrame({
      socketId: 'ws-1',
      timestamp: '2026-08-24T12:00:02.100+08:00',
      direction: 'down',
      opcode: 'text',
      payload: 'AMI_IVTP_CONNECTION_ALLOWED',
    });

    expect(recorder.toJSON().webSocketFrames[0]).toMatchObject({
      magic: 'AMI_IVTP_CONNECTION_ALLOWED',
      opcode: 'text',
    });
  });
});
