import { describe, expect, it } from 'vitest';

import { createNetworkRecorder } from '../../core/network/createNetworkRecorder';
import { attachCdpNetworkCapture, type CdpDebuggerLike } from './attachCdpNetworkCapture';

describe('attachCdpNetworkCapture', () => {
  it('maps CDP HTTP and WebSocket events into the network recorder', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const sentCommands: string[] = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command) {
        sentCommands.push(command);
        if (command === 'Network.getResponseBody') {
          return {
            body: '{"token":"kvm-token"}',
            base64Encoded: false,
          };
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });

    await attachCdpNetworkCapture({
      cdp,
      recorder,
      now: () => '2026-08-24T12:00:00.000+08:00',
    });

    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({}, method, params);
      }
    };

    emit('Network.requestWillBeSent', {
      requestId: 'req-1',
      type: 'XHR',
      request: {
        method: 'GET',
        url: 'https://bmc.example/api/kvm/token',
        headers: { Accept: 'application/json' },
      },
    });
    emit('Network.responseReceived', {
      requestId: 'req-1',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    });
    emit('Network.loadingFinished', {
      requestId: 'req-1',
    });
    emit('Network.webSocketCreated', {
      requestId: 'ws-1',
      url: 'wss://bmc.example/kvm',
    });
    emit('Network.webSocketWillSendHandshakeRequest', {
      requestId: 'ws-1',
      request: {
        headers: {
          Cookie: 'QSESSIONID=abc123',
          'Sec-WebSocket-Protocol': 'binary',
        },
      },
    });
    emit('Network.webSocketFrameReceived', {
      requestId: 'ws-1',
      response: {
        opcode: 2,
        payloadData: 'FwAAAe/+',
      },
    });
    emit('Network.webSocketClosed', {
      requestId: 'ws-1',
    });

    await Promise.resolve();
    await Promise.resolve();

    const snapshot = recorder.toJSON();

    expect(sentCommands).toEqual(['Network.enable', 'Network.getResponseBody']);
    expect(snapshot.httpRequests[0]).toMatchObject({
      id: 'req-1',
      method: 'GET',
      url: 'https://bmc.example/api/kvm/token',
      status: 200,
      responseBodySummary: {
        bytes: 21,
        redactedFields: ['token'],
      },
      tags: ['kvm-token'],
    });
    expect(snapshot.webSockets[0]).toMatchObject({
      id: 'ws-1',
      url: 'wss://bmc.example/kvm',
      subProtocols: ['binary'],
      tags: ['kvm-video'],
      closedAt: '2026-08-24T12:00:00.000+08:00',
    });
    expect(JSON.stringify(snapshot.webSockets[0])).not.toContain('abc123');
    expect(snapshot.webSocketFrames[0]).toMatchObject({
      socketId: 'ws-1',
      direction: 'down',
      opcode: 'binary',
      bytes: 6,
      headHex: '17000001',
    });
  });
});
