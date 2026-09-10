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
        jsonKeys: ['UserName', 'Password'],
      },
    });
    expect(JSON.stringify(records[0])).not.toContain('secret-password');
    expect(JSON.stringify(records[0])).not.toContain('abc123');
    expect(records[0].responseHeaders['set-cookie']).toContain('QSESSIONID=');
    expect(records[0].responseBodySummary.jsonKeys).toEqual(['CSRFToken']);
    expect(records[0].requestBodySummary.sample).toMatchObject({
      UserName: 'admin',
      Password: expect.stringContaining('<redacted:sha256:'),
    });
    expect(records[0].responseStructure?.jsonPaths).toMatchObject({
      '$.CSRFToken': 'string',
    });
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

  it('records WebSocket closedAt without dropping earlier frame metadata', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
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
      opcode: 'binary',
      payload: new Uint8Array([0x17, 0x00, 0x00, 0x01]),
    });
    recorder.recordWebSocketClosed({
      id: 'ws-1',
      timestamp: '2026-08-24T12:00:25.000+08:00',
    });

    expect(recorder.toJSON().webSockets[0]).toMatchObject({
      id: 'ws-1',
      createdAt: '2026-08-24T12:00:02.000+08:00',
      closedAt: '2026-08-24T12:00:25.000+08:00',
      binaryFrameCount: 1,
    });
  });

  it('keeps cookie names and JSON keys while redacting values and URL secrets', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    recorder.recordHttpRequest({
      id: 'req-1',
      timestamp: '2026-08-24T12:00:00.000+08:00',
      method: 'GET',
      url: 'https://10.0.0.10/api/kvm/token?token=secret-token',
      resourceType: 'xhr',
      requestHeaders: { Cookie: 'QSESSIONID=abc123; theme=dark' },
    });
    recorder.recordHttpResponse({
      id: 'req-1',
      status: 200,
      responseHeaders: { 'set-cookie': 'QSESSIONID=abc123; Path=/; HttpOnly' },
      responseBody: '{"token":"kvm-token","mode":"html5"}',
    });

    const request = recorder.toJSON().httpRequests[0];
    expect(request?.url).toContain('https://10.0.0.10/api/kvm/token');
    expect(request?.url).not.toContain('secret-token');
    expect(request?.requestHeaders.Cookie).toContain('QSESSIONID=');
    expect(request?.requestHeaders.Cookie).toContain('theme=');
    expect(JSON.stringify(request)).not.toContain('abc123');
    expect(request?.responseHeaders['set-cookie']).toContain('Path=/');
    expect(request?.responseBodySummary.jsonKeys).toEqual(['token', 'mode']);
    expect(request?.responseBodySummary.sample).toMatchObject({
      token: expect.stringContaining('<redacted:sha256:'),
      mode: 'html5',
    });
  });

  it('does not tag a generic /websocket URL as KVM video before protocol evidence exists', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 8 });
    recorder.recordWebSocketCreated({
      id: 'ws-home',
      timestamp: '2026-09-07T02:43:13.000+08:00',
      url: 'wss://10.10.8.129/websocket',
      subProtocols: [],
      requestHeaders: {},
    });
    recorder.recordWebSocketFrame({
      socketId: 'ws-home',
      timestamp: '2026-09-07T02:43:13.100+08:00',
      direction: 'down',
      opcode: 'text',
      payload: '{"event":"alarm","message":"home heartbeat"}',
    });

    expect(recorder.toJSON().webSockets[0]?.tags).toEqual(['unknown']);
    expect(recorder.toJSON().webSockets[0]?.textFrameCount).toBe(1);
  });

  it('records WebSocket handshake response status, headers, and selected protocol', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 8 });
    recorder.recordWebSocketCreated({
      id: 'ws-1',
      timestamp: '2026-08-24T12:00:02.000+08:00',
      url: 'wss://10.0.0.10/vnc/vconsole',
      subProtocols: ['binary'],
      requestHeaders: {},
    });
    recorder.recordWebSocketHandshakeResponse({
      id: 'ws-1',
      status: 101,
      responseHeaders: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': 'binary',
      },
    });

    expect(recorder.toJSON().webSockets[0]).toMatchObject({
      handshakeStatus: 101,
      responseSubProtocol: 'binary',
      responseHeaders: {
        Upgrade: 'websocket',
      },
    });
  });

  it('captures URL-encoded legacy form body samples and short text response samples', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 8 });
    recorder.recordHttpRequest({
      id: 'legacy-token',
      timestamp: '2026-09-07T03:00:00.000+08:00',
      method: 'POST',
      url: 'https://10.10.8.107/bmc/php/gettoken.php',
      resourceType: 'xhr',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      requestBody: 'user=admin&authParam=secret-auth&method=GetToken',
    });
    recorder.recordHttpResponse({
      id: 'legacy-token',
      status: 200,
      responseHeaders: { 'content-type': 'text/plain; charset=UTF-8' },
      responseBody: 'ret=0&token=legacy-secret&port=2198',
    });

    const request = recorder.toJSON().httpRequests[0];
    expect(request).toMatchObject({
      tags: ['login', 'kvm-token'],
      requestBodySummary: {
        jsonKeys: ['user', 'authParam', 'method'],
        sample: {
          user: 'admin',
          authParam: expect.stringContaining('<redacted:sha256:'),
          method: 'GetToken',
        },
      },
      responseBodySummary: {
        jsonKeys: ['ret', 'token', 'port'],
        sample: {
          ret: '0',
          token: expect.stringContaining('<redacted:sha256:'),
          port: '2198',
        },
      },
      responseStructure: {
        bodyKind: 'form',
        jsonPaths: {
          '$.token': 'string',
        },
      },
    });
    expect(JSON.stringify(request)).not.toContain('secret-auth');
    expect(JSON.stringify(request)).not.toContain('legacy-secret');
  });

  it('keeps bounded samples for short non-HTML text responses', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 8 });
    recorder.recordHttpRequest({
      id: 'legacy-text',
      timestamp: '2026-09-07T03:00:00.000+08:00',
      method: 'GET',
      url: 'https://10.10.8.107/bmc/php/processparameter.php',
      resourceType: 'xhr',
      requestHeaders: {},
    });
    recorder.recordHttpResponse({
      id: 'legacy-text',
      status: 200,
      responseHeaders: { 'content-type': 'text/plain' },
      responseBody: 'OK: viewer mode html5',
    });

    expect(recorder.toJSON().httpRequests[0]?.responseBodySummary.sample).toBe(
      'OK: viewer mode html5',
    );
  });

  it('does not tag static login assets as the login chain and keeps legacy token requests', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 8 });
    recorder.recordHttpRequest({
      id: 'login-image',
      timestamp: '2026-09-07T03:00:00.000+08:00',
      method: 'GET',
      url: 'https://10.10.8.107/images/login.png',
      resourceType: 'image',
      requestHeaders: {},
    });
    recorder.recordHttpRequest({
      id: 'legacy-token',
      timestamp: '2026-09-07T03:00:01.000+08:00',
      method: 'POST',
      url: 'https://10.10.8.107/bmc/php/gettoken.php',
      resourceType: 'xhr',
      requestHeaders: {},
    });

    const records = recorder.toJSON().httpRequests;
    expect(records[0]?.tags).toEqual([]);
    expect(records[1]?.tags).toEqual(['login', 'kvm-token']);
  });

  it('waits for in-flight HTTP requests before reporting network idle', async () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 8, idleQuietMs: 20, idleTimeoutMs: 500 });
    recorder.recordHttpRequest({
      id: 'req-1',
      timestamp: '2026-09-07T03:00:00.000+08:00',
      method: 'GET',
      url: 'https://10.10.8.107/bmc/php/getmultiproperty.php',
      resourceType: 'xhr',
      requestHeaders: {},
    });

    let settled = false;
    const idle = recorder.waitForIdle().then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(settled).toBe(false);

    recorder.markHttpRequestFinished('req-1');
    await idle;
    expect(settled).toBe(true);
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

  it.each([
    ['wss://10.0.0.10/vnc/vconsole', ['binary'], new Uint8Array(Buffer.from('RFB 003.008\n'))],
    ['wss://10.0.0.10:5900/', ['lws-dvc-protocol'], new Uint8Array(Buffer.from('APCP'))],
    ['wss://10.0.0.10:5900/vkvm/', ['lws-dvc-protocol'], new Uint8Array(Buffer.from('APCP'))],
    ['wss://10.0.0.10/wss/ircport', [], new Uint8Array([0x42, 0x45, 0x45, 0x46])],
    ['wss://10.0.0.10:2198/', [], new Uint8Array([0xfe, 0xf6, 0x00, 0x04])],
  ])('tags KVM WebSocket variant %s', (url, subProtocols, payload) => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 12 });
    recorder.recordWebSocketCreated({
      id: 'ws-variant',
      timestamp: '2026-08-24T12:00:02.000+08:00',
      url,
      subProtocols,
      requestHeaders: {},
    });
    recorder.recordWebSocketFrame({
      socketId: 'ws-variant',
      timestamp: '2026-08-24T12:00:02.100+08:00',
      direction: 'down',
      opcode: 'binary',
      payload,
    });

    expect(recorder.toJSON().webSockets[0]?.tags).toEqual(['kvm-video']);
    expect(recorder.toJSON().webSocketFrames[0]?.headHex).toBeTruthy();
  });

  it('records binary frame magic for Dell and Huawei legacy protocols', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 12 });
    recorder.recordWebSocketCreated({
      id: 'ws-rfb',
      timestamp: '2026-08-24T12:00:02.000+08:00',
      url: 'wss://10.0.0.10/vnc/vconsole',
      subProtocols: ['binary'],
      requestHeaders: {},
    });
    recorder.recordWebSocketFrame({
      socketId: 'ws-rfb',
      timestamp: '2026-08-24T12:00:02.100+08:00',
      direction: 'down',
      opcode: 'binary',
      payload: new Uint8Array(Buffer.from('RFB 003.008\n')),
    });
    recorder.recordWebSocketCreated({
      id: 'ws-hw',
      timestamp: '2026-08-24T12:00:03.000+08:00',
      url: 'wss://10.0.0.11:2198/',
      subProtocols: [],
      requestHeaders: {},
    });
    recorder.recordWebSocketFrame({
      socketId: 'ws-hw',
      timestamp: '2026-08-24T12:00:03.100+08:00',
      direction: 'down',
      opcode: 'binary',
      payload: new Uint8Array([0xfe, 0xf6, 0x00, 0x04]),
    });

    expect(recorder.toJSON().webSocketFrames.map(item => item.magic)).toEqual([
      'RFB 003.008',
      'HUAWEI_KVM_FEF6',
    ]);
  });

  it('ignores new HTTP and WebSocket records while paused but still closes in-flight items', () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    recorder.recordHttpRequest({
      id: 'req-1',
      timestamp: '2026-08-24T12:00:00.000+08:00',
      method: 'GET',
      url: 'https://10.0.0.10/api/session',
      resourceType: 'xhr',
      requestHeaders: {},
    });
    recorder.recordWebSocketCreated({
      id: 'ws-1',
      timestamp: '2026-08-24T12:00:02.000+08:00',
      url: 'wss://10.0.0.10/kvm',
      subProtocols: ['binary'],
      requestHeaders: {},
    });

    recorder.setPaused(true);
    recorder.recordHttpRequest({
      id: 'req-2',
      timestamp: '2026-08-24T12:00:03.000+08:00',
      method: 'GET',
      url: 'https://10.0.0.10/api/kvm/token',
      resourceType: 'xhr',
      requestHeaders: {},
    });
    recorder.recordHttpResponse({
      id: 'req-1',
      status: 200,
      responseHeaders: {},
    });
    recorder.recordWebSocketCreated({
      id: 'ws-2',
      timestamp: '2026-08-24T12:00:04.000+08:00',
      url: 'wss://10.0.0.10/kvm/video',
      subProtocols: [],
      requestHeaders: {},
    });
    recorder.recordWebSocketFrame({
      socketId: 'ws-1',
      timestamp: '2026-08-24T12:00:04.100+08:00',
      direction: 'down',
      opcode: 'binary',
      payload: new Uint8Array([0x17, 0x00]),
    });
    recorder.recordWebSocketClosed({
      id: 'ws-1',
      timestamp: '2026-08-24T12:00:05.000+08:00',
    });

    recorder.setPaused(false);
    recorder.recordHttpRequest({
      id: 'req-3',
      timestamp: '2026-08-24T12:00:06.000+08:00',
      method: 'GET',
      url: 'https://10.0.0.10/api/randomtag',
      resourceType: 'xhr',
      requestHeaders: {},
    });

    const snapshot = recorder.toJSON();
    expect(snapshot.httpRequests.map(item => item.id)).toEqual(['req-1', 'req-3']);
    expect(snapshot.httpRequests[0]?.status).toBe(200);
    expect(snapshot.webSockets.map(item => item.id)).toEqual(['ws-1']);
    expect(snapshot.webSockets[0]?.closedAt).toBe('2026-08-24T12:00:05.000+08:00');
    expect(snapshot.webSocketFrames).toHaveLength(0);
  });
});
