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

    expect(sentCommands).toEqual(['Network.enable', 'Target.setAutoAttach', 'Network.getResponseBody']);
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

  it('scopes OOPIF request ids and reads response bodies through the attached session', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const bodyCalls: Array<{ requestId: string; sessionId?: string }> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command, params, sessionId) {
        if (command === 'Network.getResponseBody') {
          bodyCalls.push({ requestId: String(params?.requestId || ''), sessionId });
          return {
            body: '{"StartH5Kvm":{"url":"wss://10.10.8.129/kvm?token=secret","port":443}}',
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

    for (const listener of listeners) {
      listener(
        {},
        'Network.requestWillBeSent',
        {
          requestId: 'req-1',
          type: 'XHR',
          request: {
            method: 'POST',
            url: 'https://bmc.example/redfish/v1/Managers/1/KvmService/Actions/Oem/Public/KvmService.StartH5Kvm',
            headers: {},
          },
        },
        'oopif-session',
      );
      listener(
        {},
        'Network.responseReceived',
        {
          requestId: 'req-1',
          response: {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          },
        },
        'oopif-session',
      );
      listener({}, 'Network.loadingFinished', { requestId: 'req-1' }, 'oopif-session');
    }

    await recorder.waitForIdle();

    expect(bodyCalls).toEqual([{ requestId: 'req-1', sessionId: 'oopif-session' }]);
    const request = recorder.toJSON().httpRequests[0];
    expect(request).toMatchObject({
      id: 'oopif-session::req-1',
      responseBodySummary: {
        sample: {
          StartH5Kvm: {
            url: expect.stringContaining('redacted'),
            port: 443,
          },
        },
      },
    });
    expect(JSON.stringify(request)).not.toContain('secret');
  });

  it('enables Network for auto-attached iframe/OOPIF targets', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const sentCommands: Array<{ command: string; sessionId?: string }> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command, _params, sessionId) {
        sentCommands.push({ command, sessionId });
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };

    await attachCdpNetworkCapture({
      cdp,
      recorder: createNetworkRecorder({ frameHeadBytes: 4 }),
      now: () => '2026-08-24T12:00:00.000+08:00',
    });

    for (const listener of listeners) {
      listener({}, 'Target.attachedToTarget', { sessionId: 'oopif-session' }, undefined);
    }
    await Promise.resolve();

    expect(sentCommands).toContainEqual({
      command: 'Network.enable',
      sessionId: 'oopif-session',
    });
  });

  it('records WebSocket handshake responses from CDP', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand() {
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

    for (const listener of listeners) {
      listener({}, 'Network.webSocketCreated', { requestId: 'ws-1', url: 'wss://bmc.example/vnc/vconsole' });
      listener(
        {},
        'Network.webSocketHandshakeResponseReceived',
        {
          requestId: 'ws-1',
          response: {
            status: 101,
            headers: { 'Sec-WebSocket-Protocol': 'binary' },
          },
        },
      );
    }

    expect(recorder.toJSON().webSockets[0]).toMatchObject({
      handshakeStatus: 101,
      responseSubProtocol: 'binary',
    });
  });
});
