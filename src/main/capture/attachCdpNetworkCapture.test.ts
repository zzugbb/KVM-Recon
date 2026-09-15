import { describe, expect, it } from 'vitest';

import { createNetworkRecorder } from '../../core/network/createNetworkRecorder';
import { attachCdpNetworkCapture, type CdpDebuggerLike } from './attachCdpNetworkCapture';

function electronLikeSendCommand(
  impl: (
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => unknown,
): CdpDebuggerLike['sendCommand'] {
  return function sendCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) {
    if (arguments.length >= 3 && !(typeof sessionId === 'string' && sessionId)) {
      throw new Error('Empty session id is not allowed');
    }
    if (typeof sessionId === 'string' && sessionId) {
      return impl(command, params, sessionId);
    }
    return impl(command, params);
  };
}

describe('attachCdpNetworkCapture', () => {
  it('maps CDP HTTP and WebSocket events into the network recorder', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const sentCommands: string[] = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async command => {
        sentCommands.push(command);
        if (command === 'Network.getResponseBody') {
          return {
            body: '{"token":"kvm-token"}',
            base64Encoded: false,
          };
        }
        return {};
      }),
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

  it('registers Network listeners before Network.enable so the first popup document is kept', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command) {
        if (command === 'Network.enable') {
          expect(listeners).toHaveLength(1);
          for (const listener of listeners) {
            listener(
              {},
              'Network.requestWillBeSent',
              {
                requestId: 'popup-doc',
                type: 'Document',
                request: {
                  method: 'GET',
                  url: 'https://10.10.8.101/vmc/vconsole',
                  headers: {},
                },
              },
            );
          }
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({ cdp, recorder });
    expect(recorder.toJSON().httpRequests[0]).toMatchObject({
      id: 'popup-doc',
      url: 'https://10.10.8.101/vmc/vconsole',
      resourceType: 'Document',
    });
  });

  it('times out a hung Network.enable so capture start cannot block forever', async () => {
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand(command) {
        if (command === 'Network.enable') {
          return new Promise(() => {});
        }
        return {};
      },
      on() {},
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({
      cdp,
      recorder,
      networkEnableTimeoutMs: 20,
    });
    expect(recorder.captureStatus().attachFailures).toEqual([
      { sessionId: 'root', reason: 'cdp-attach-failed' },
    ]);
  });

  it('reads root HTML/JS bodies without passing an empty CDP session id', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const bodyCalls: Array<{ command: string; argc: number; sessionId?: string }> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand(command, params, sessionId) {
        if (arguments.length >= 3 && !(typeof sessionId === 'string' && sessionId)) {
          throw new Error('Empty session id is not allowed');
        }
        bodyCalls.push({ command, argc: arguments.length, sessionId });
        if (command === 'Network.getResponseBody') {
          return {
            body: '<!doctype html><html><body>kvm-recon-e2e-popup-html</body></html>',
            base64Encoded: false,
          };
        }
        if (command === 'Network.getRequestPostData') {
          return { postData: 'viewer=html5&token=e2e-secret-token' };
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({ cdp, recorder, now: () => '2026-08-24T12:00:00.000+08:00' });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'popup-html',
      type: 'Document',
      request: {
        method: 'GET',
        url: 'https://bmc.example/popup.html',
        headers: {},
      },
    });
    emit('Network.responseReceived', {
      requestId: 'popup-html',
      response: {
        status: 200,
        mimeType: 'text/html',
        headers: { 'content-type': 'text/html' },
      },
    });
    emit('Network.loadingFinished', { requestId: 'popup-html' });
    emit('Network.requestWillBeSent', {
      requestId: 'login-post',
      type: 'Document',
      request: {
        method: 'POST',
        url: 'https://bmc.example/form-target',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        hasPostData: true,
      },
    });
    emit('Network.responseReceived', {
      requestId: 'login-post',
      response: {
        status: 200,
        mimeType: 'text/html',
        headers: { 'content-type': 'text/html' },
      },
    });
    emit('Network.loadingFinished', { requestId: 'login-post' });
    await recorder.waitForIdle();

    expect(
      bodyCalls.filter(item =>
        item.command === 'Network.getResponseBody' || item.command === 'Network.getRequestPostData',
      ),
    ).toEqual(
      expect.arrayContaining([
        { command: 'Network.getResponseBody', argc: 2, sessionId: undefined },
        { command: 'Network.getRequestPostData', argc: 2, sessionId: undefined },
      ]),
    );
    const popup = recorder.toJSON().httpRequests.find(item => item.id === 'popup-html');
    const post = recorder.toJSON().httpRequests.find(item => item.id === 'login-post');
    expect(popup).toMatchObject({
      responseBodyCaptured: true,
    });
    expect(popup?.responseBodySkippedReason).toBeFalsy();
    expect(popup?.responseBodySummary.sample).toContain('kvm-recon-e2e-popup-html');
    expect(post).toMatchObject({
      requestBodyCaptured: true,
    });
    expect(recorder.sourceFiles().some(file => file.text.includes('kvm-recon-e2e-popup-html'))).toBe(
      true,
    );
  });

  it('scopes OOPIF request ids and reads response bodies through the attached session', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const bodyCalls: Array<{ requestId: string; sessionId?: string }> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async (command, params, sessionId) => {
        if (command === 'Network.getResponseBody') {
          bodyCalls.push({ requestId: String(params?.requestId || ''), sessionId });
          return {
            body: '{"StartH5Kvm":{"url":"wss://10.10.8.129/kvm?token=secret","port":443}}',
            base64Encoded: false,
          };
        }
        return {};
      }),
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
    await Promise.resolve();
    await Promise.resolve();

    expect(sentCommands).toContainEqual({
      command: 'Network.enable',
      sessionId: 'oopif-session',
    });
    expect(sentCommands).toContainEqual({
      command: 'Runtime.runIfWaitingForDebugger',
      sessionId: 'oopif-session',
    });
    expect(
      sentCommands.findIndex(item => item.command === 'Network.enable' && item.sessionId === 'oopif-session'),
    ).toBeLessThan(
      sentCommands.findIndex(
        item => item.command === 'Runtime.runIfWaitingForDebugger' && item.sessionId === 'oopif-session',
      ),
    );
  });

  it('pauses auto-attached targets until Network.enable finishes', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const sentCommands: Array<{ command: string; sessionId?: string }> = [];
    let releaseEnable: (() => void) | undefined;
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command, params, sessionId) {
        sentCommands.push({ command, sessionId });
        if (command === 'Network.enable' && sessionId === 'oopif-session') {
          await new Promise<void>(resolve => {
            releaseEnable = resolve;
          });
        }
        if (command === 'Target.setAutoAttach') {
          expect(params).toMatchObject({ waitForDebuggerOnStart: true, flatten: true });
        }
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
    expect(sentCommands.map(item => item.command)).not.toContain('Runtime.runIfWaitingForDebugger');
    releaseEnable?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sentCommands).toContainEqual({
      command: 'Runtime.runIfWaitingForDebugger',
      sessionId: 'oopif-session',
    });
  });

  it('resumes an OOPIF even when Network.enable fails and records the attach failure', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const sentCommands: Array<{ command: string; sessionId?: string }> = [];
    const recorder = createNetworkRecorder({ frameHeadBytes: 4, idleQuietMs: 10, idleTimeoutMs: 200 });
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command, _params, sessionId) {
        sentCommands.push({ command, sessionId });
        if (command === 'Network.enable' && sessionId === 'oopif-session') {
          throw new Error('Network.enable failed');
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };

    await attachCdpNetworkCapture({
      cdp,
      recorder,
      now: () => '2026-08-24T12:00:00.000+08:00',
    });

    for (const listener of listeners) {
      listener({}, 'Target.attachedToTarget', { sessionId: 'oopif-session' }, undefined);
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sentCommands).toContainEqual({
      command: 'Runtime.runIfWaitingForDebugger',
      sessionId: 'oopif-session',
    });
    await expect(recorder.waitForIdle()).resolves.toMatchObject({
      timedOut: false,
      attachFailures: [{ sessionId: 'oopif-session', reason: 'network-enable-failed' }],
    });
  });

  it('loads POST bodies via Network.getRequestPostData when CDP omits postData', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async (command, params) => {
        if (command === 'Network.getRequestPostData') {
          expect(params).toEqual({ requestId: 'login-1' });
          return { postData: '{"UserName":"root","Password":"secret"}' };
        }
        return {};
      }),
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };

    await attachCdpNetworkCapture({
      cdp,
      recorder,
      now: () => '2026-08-24T12:00:00.000+08:00',
      captureWindowId: 'win-main',
      windowRole: 'main',
    });

    for (const listener of listeners) {
      listener({}, 'Network.requestWillBeSent', {
        requestId: 'login-1',
        type: 'XHR',
        request: {
          method: 'POST',
          url: 'https://bmc.example/api/session',
          headers: { 'content-type': 'application/json' },
          hasPostData: true,
        },
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const request = recorder.toJSON().httpRequests[0];
    expect(request).toMatchObject({
      captureWindowId: 'win-main',
      requestBodyCaptured: true,
      requestBodySummary: {
        jsonKeys: ['UserName', 'Password'],
        redactedFields: ['Password'],
      },
    });
    expect(JSON.stringify(request)).not.toContain('secret');
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

  it('preserves every redirect hop and merges ExtraInfo headers', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const bodyCalls: string[] = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command, params) {
        if (command === 'Network.getResponseBody') {
          bodyCalls.push(String(params?.requestId || ''));
          return { body: '{"page":"home"}', base64Encoded: false };
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
      now: () => '2026-09-13T10:00:00.000+08:00',
    });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'login-chain',
      type: 'XHR',
      request: {
        method: 'POST',
        url: 'https://bmc.example/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'username=admin&password=secret',
      },
    });
    emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'login-chain',
      headers: { Cookie: 'prelogin=one' },
    });
    emit('Network.responseReceivedExtraInfo', {
      requestId: 'login-chain',
      statusCode: 302,
      headers: { 'Set-Cookie': 'QSESSIONID=secret', Location: '/home' },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'login-chain',
      type: 'Document',
      redirectHasExtraInfo: true,
      redirectResponse: {
        status: 302,
        headers: { Location: '/home' },
      },
      request: {
        method: 'GET',
        url: 'https://bmc.example/home',
        headers: {},
      },
    });
    emit('Network.responseReceived', {
      requestId: 'login-chain',
      hasExtraInfo: false,
      response: {
        status: 200,
        mimeType: 'application/json',
        headers: { 'content-type': 'application/json' },
      },
    });
    emit('Network.loadingFinished', { requestId: 'login-chain', encodedDataLength: 15 });
    await recorder.waitForIdle();

    const requests = recorder.toJSON().httpRequests;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      id: 'login-chain',
      method: 'POST',
      status: 302,
      redirectHop: 0,
      redirectedToId: 'login-chain::redirect-1',
      redirectLocation: '/home',
      responseBodySkippedReason: 'redirect-response',
    });
    expect(requests[0]?.requestHeaders).toHaveProperty('Cookie');
    expect(requests[0]?.responseHeaders).toHaveProperty('Set-Cookie');
    expect(requests[1]).toMatchObject({
      id: 'login-chain::redirect-1',
      method: 'GET',
      status: 200,
      redirectHop: 1,
      redirectedFromId: 'login-chain',
      responseBodyCaptured: true,
    });
    expect(bodyCalls).toEqual(['login-chain']);
  });

  it('uses CDP ExtraInfo flags to skip redirect hops without raw response headers', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
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
    await attachCdpNetworkCapture({ cdp, recorder });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'login-chain',
      type: 'XHR',
      request: {
        method: 'POST',
        url: 'https://bmc.example/login',
        headers: {},
      },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'login-chain',
      type: 'Document',
      redirectHasExtraInfo: false,
      redirectResponse: {
        status: 302,
        headers: { Location: '/home' },
      },
      request: {
        method: 'GET',
        url: 'https://bmc.example/home',
        headers: {},
      },
    });
    emit('Network.responseReceivedExtraInfo', {
      requestId: 'login-chain',
      statusCode: 200,
      headers: { 'Set-Cookie': 'QSESSIONID=final-session' },
    });
    emit('Network.responseReceived', {
      requestId: 'login-chain',
      hasExtraInfo: true,
      response: {
        status: 200,
        mimeType: 'text/html',
        headers: { 'content-type': 'text/html' },
      },
    });

    const requests = recorder.toJSON().httpRequests;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      id: 'login-chain',
      status: 302,
      redirectLocation: '/home',
    });
    expect(requests[0]?.responseHeaders).not.toHaveProperty('Set-Cookie');
    expect(requests[1]).toMatchObject({
      id: 'login-chain::redirect-1',
      status: 200,
    });
    expect(requests[1]?.responseHeaders).toHaveProperty(
      'Set-Cookie',
      expect.stringMatching(/^QSESSIONID=<redacted:/),
    );
  });

  it.each(['before', 'after'] as const)(
    'keeps response ExtraInfo authoritative when it arrives %s the ordinary response',
    async order => {
      const listeners: Array<
        (event: unknown, method: string, params: Record<string, unknown>) => void
      > = [];
      const bodyCalls: string[] = [];
      const cdp: CdpDebuggerLike = {
        async attach() {},
        async sendCommand(command, params) {
          if (command === 'Network.getResponseBody') {
            bodyCalls.push(String(params?.requestId || ''));
            return { body: '{"cached":true}', base64Encoded: false };
          }
          return {};
        },
        on(event, listener) {
          if (event === 'message') listeners.push(listener);
        },
      };
      const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
      await attachCdpNetworkCapture({ cdp, recorder });
      const emit = (method: string, params: Record<string, unknown>) => {
        for (const listener of listeners) listener({}, method, params);
      };
      const ordinaryResponse = () =>
        emit('Network.responseReceived', {
          requestId: 'cached-request',
          hasExtraInfo: true,
          response: {
            status: 200,
            mimeType: 'image/png',
            headers: {
              'content-type': 'image/png',
              etag: 'ordinary-etag',
              'X-Ordinary': 'kept',
            },
          },
        });
      const extraInfoResponse = () =>
        emit('Network.responseReceivedExtraInfo', {
          requestId: 'cached-request',
          statusCode: 304,
          headers: {
            'Content-Type': 'application/json; source=extra-info',
            ETag: 'extra-etag',
          },
        });

      emit('Network.requestWillBeSent', {
        requestId: 'cached-request',
        type: 'XHR',
        request: {
          method: 'GET',
          url: 'https://bmc.example/api/status',
          headers: {},
        },
      });
      if (order === 'before') {
        extraInfoResponse();
        ordinaryResponse();
      } else {
        ordinaryResponse();
        extraInfoResponse();
      }
      emit('Network.loadingFinished', {
        requestId: 'cached-request',
        encodedDataLength: 15,
      });
      await recorder.waitForIdle();

      const response = recorder.toJSON().httpRequests[0];
      expect(response?.status).toBe(304);
      expect(response?.responseContentType).toBe('application/json; source=extra-info');
      expect(response?.responseHeaders['Content-Type']).toBe(
        'application/json; source=extra-info',
      );
      expect(response?.responseHeaders.ETag).toBe('extra-etag');
      expect(response?.responseHeaders['X-Ordinary']).toBe('kept');
      expect(response?.responseBodyCaptured).toBe(true);
      expect(bodyCalls).toEqual(['cached-request']);
      expect(
        Object.keys(response?.responseHeaders || {}).filter(
          name => name.toLowerCase() === 'content-type',
        ),
      ).toHaveLength(1);
      expect(
        Object.keys(response?.responseHeaders || {}).filter(name => name.toLowerCase() === 'etag'),
      ).toHaveLength(1);
    },
  );

  it('uses CDP ExtraInfo flags to skip redirect hops without raw request headers', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
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
    await attachCdpNetworkCapture({ cdp, recorder });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'login-chain',
      type: 'XHR',
      request: {
        method: 'POST',
        url: 'https://bmc.example/login',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'login-chain',
      type: 'Document',
      redirectHasExtraInfo: false,
      redirectResponse: {
        status: 302,
        headers: { Location: '/home' },
      },
      request: {
        method: 'GET',
        url: 'https://bmc.example/home',
        headers: {},
      },
    });
    emit('Network.responseReceived', {
      requestId: 'login-chain',
      hasExtraInfo: true,
      response: {
        status: 200,
        mimeType: 'text/html',
        headers: { 'content-type': 'text/html' },
      },
    });
    emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'login-chain',
      headers: {
        Cookie: 'QSESSIONID=final-session',
        Referer: 'https://bmc.example/login',
      },
    });

    const requests = recorder.toJSON().httpRequests;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      id: 'login-chain',
      method: 'POST',
      status: 302,
    });
    expect(requests[0]?.requestHeaders).not.toHaveProperty('Cookie');
    expect(requests[0]?.requestHeaders).not.toHaveProperty('Referer');
    expect(requests[1]).toMatchObject({
      id: 'login-chain::redirect-1',
      method: 'GET',
      status: 200,
    });
    expect(requests[1]?.requestHeaders).toHaveProperty('Cookie');
    expect(requests[1]?.requestHeaders).toHaveProperty('Referer', 'https://bmc.example/login');
    expect(JSON.stringify(requests)).not.toContain('final-session');
  });

  it('keeps final request ExtraInfo when a failed request has no response event', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
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
    await attachCdpNetworkCapture({ cdp, recorder });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'failed-request',
      headers: { Cookie: 'QSESSIONID=failed-session' },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'failed-request',
      type: 'XHR',
      request: {
        method: 'GET',
        url: 'https://bmc.example/api/status',
        headers: {},
      },
    });
    emit('Network.loadingFailed', { requestId: 'failed-request' });

    const request = recorder.toJSON().httpRequests[0];
    expect(request?.requestHeaders).toHaveProperty('Cookie');
    expect(request?.responseBodySkippedReason).toBe('loading-failed');
    expect(JSON.stringify(request)).not.toContain('failed-session');
  });

  it('skips inline, binary, and oversized response bodies', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const bodyCalls: string[] = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command, params) {
        if (command === 'Network.getResponseBody') bodyCalls.push(String(params?.requestId || ''));
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({ cdp, recorder });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'inline',
      type: 'Image',
      request: { method: 'GET', url: `data:image/png;base64,${'A'.repeat(1000)}`, headers: {} },
    });
    for (const [requestId, type, contentType, encodedDataLength] of [
      ['image', 'Image', 'image/png', 2000],
      ['large-json', 'XHR', 'application/json', 2 * 1024 * 1024],
    ] as const) {
      emit('Network.requestWillBeSent', {
        requestId,
        type,
        request: { method: 'GET', url: `https://bmc.example/${requestId}`, headers: {} },
      });
      emit('Network.responseReceived', {
        requestId,
        response: { status: 200, mimeType: contentType, headers: { 'content-type': contentType } },
      });
      emit('Network.loadingFinished', { requestId, encodedDataLength });
    }

    expect(bodyCalls).toEqual([]);
    const requests = recorder.toJSON().httpRequests;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.responseBodySkippedReason).toBe('binary-resource:image');
    expect(requests[1]?.responseBodySkippedReason).toBe(`response-too-large:${2 * 1024 * 1024}`);
  });

  it('records attachFailures when the root debugger.attach rejects', async () => {
    const recorder = createNetworkRecorder({ frameHeadBytes: 4, idleQuietMs: 10, idleTimeoutMs: 200 });
    const cdp: CdpDebuggerLike = {
      async attach() {
        throw new Error('attach denied');
      },
      async sendCommand() {
        return {};
      },
      on() {},
    };

    await attachCdpNetworkCapture({
      cdp,
      recorder,
      captureWindowId: 'popup-kvm',
    });

    await expect(recorder.waitForIdle()).resolves.toMatchObject({
      timedOut: false,
      attachFailures: [{ sessionId: 'popup-kvm', reason: 'cdp-attach-failed' }],
    });
  });

  it('keeps a complete Viewer script under 2 MiB instead of truncating to the JSONL sample limit', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const body = `function startKvm() {}\n${'A'.repeat(1.5 * 1024 * 1024)}`;
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command) {
        if (command === 'Network.getResponseBody') {
          return { body, base64Encoded: false };
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({ cdp, recorder });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'viewer-js',
      type: 'Script',
      request: { method: 'GET', url: 'https://bmc.example/html5viewer.js', headers: {} },
    });
    emit('Network.responseReceived', {
      requestId: 'viewer-js',
      type: 'Script',
      response: {
        status: 200,
        mimeType: 'application/javascript',
        headers: { 'content-type': 'application/javascript' },
      },
    });
    emit('Network.loadingFinished', {
      requestId: 'viewer-js',
      encodedDataLength: 1.5 * 1024 * 1024,
    });
    await Promise.resolve();
    await Promise.resolve();

    const request = recorder.toJSON().httpRequests[0];
    expect(request?.responseBodyCaptured).toBe(true);
    expect(request?.responseBodySkippedReason).toBeUndefined();
    expect(request?.sourceTruncated).toBe(false);
    expect(request?.sourceBytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(String(request?.responseBodySummary.sample)).toContain('function startKvm');
    expect(String(request?.responseBodySummary.sample).length).toBeLessThan(body.length);
    expect(recorder.sourceFiles()[0]?.text).toBe(body);
  });

  it('does not read a Viewer script whose encoded length already exceeds 2 MiB', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    let getBodyCalls = 0;
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command) {
        if (command === 'Network.getResponseBody') {
          getBodyCalls += 1;
          return { body: 'function startKvm() {}', base64Encoded: false };
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({ cdp, recorder });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'viewer-js',
      type: 'Script',
      request: { method: 'GET', url: 'https://bmc.example/html5viewer.js', headers: {} },
    });
    emit('Network.responseReceived', {
      requestId: 'viewer-js',
      type: 'Script',
      response: {
        status: 200,
        mimeType: 'application/javascript',
        headers: { 'content-type': 'application/javascript' },
      },
    });
    emit('Network.loadingFinished', {
      requestId: 'viewer-js',
      encodedDataLength: 2.5 * 1024 * 1024,
    });
    await Promise.resolve();
    await Promise.resolve();

    const request = recorder.toJSON().httpRequests[0];
    expect(getBodyCalls).toBe(0);
    expect(request?.responseBodyCaptured).toBe(false);
    expect(request?.sourceTruncated).toBe(true);
    expect(request?.responseBodySkippedReason).toMatch(/^source-too-large-to-read:/);
    expect(recorder.sourceFiles()).toEqual([]);
  });

  it('does not read a gzip-compressed Viewer script whose decoded length exceeds 2 MiB', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    let getBodyCalls = 0;
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command) {
        if (command === 'Network.getResponseBody') {
          getBodyCalls += 1;
          return { body: 'function startKvm() {}', base64Encoded: false };
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({ cdp, recorder });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'viewer-js',
      type: 'Script',
      request: { method: 'GET', url: 'https://bmc.example/html5viewer.js', headers: {} },
    });
    emit('Network.responseReceived', {
      requestId: 'viewer-js',
      type: 'Script',
      response: {
        status: 200,
        mimeType: 'application/javascript',
        headers: { 'content-type': 'application/javascript', 'content-encoding': 'gzip' },
      },
    });
    emit('Network.dataReceived', {
      requestId: 'viewer-js',
      dataLength: 2.5 * 1024 * 1024,
      encodedDataLength: 400 * 1024,
    });
    emit('Network.loadingFinished', {
      requestId: 'viewer-js',
      encodedDataLength: 400 * 1024,
    });
    await Promise.resolve();
    await Promise.resolve();

    const request = recorder.toJSON().httpRequests[0];
    expect(getBodyCalls).toBe(0);
    expect(request?.responseBodyCaptured).toBe(false);
    expect(request?.responseBodySkippedReason).toMatch(/^source-too-large-to-read:/);
    expect(recorder.sourceFiles()).toEqual([]);
  });

  it('captures IIFE Viewer bundles even when the MIME type is wrong', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const body = `(()=>{window.startKvm=function(){${'B'.repeat(800)}}})();`;
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand(command) {
        if (command === 'Network.getResponseBody') {
          return { body, base64Encoded: false };
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({ cdp, recorder });
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'chunk-js',
      type: 'Script',
      request: { method: 'GET', url: 'https://bmc.example/static/js/8f3a21.chunk.js', headers: {} },
    });
    emit('Network.responseReceived', {
      requestId: 'chunk-js',
      type: 'Script',
      response: {
        status: 200,
        mimeType: 'application/octet-stream',
        headers: { 'content-type': 'application/octet-stream' },
      },
    });
    emit('Network.loadingFinished', {
      requestId: 'chunk-js',
      encodedDataLength: body.length,
    });
    await Promise.resolve();
    await Promise.resolve();

    const request = recorder.toJSON().httpRequests[0];
    expect(request?.sourceKind).toBe('javascript');
    expect(String(request?.responseBodySummary.sample).length).toBeGreaterThan(512);
    expect(recorder.sourceFiles()[0]?.text).toBe(body);
  });

  it('joins Worker target response events to the parent script request and stores source', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const workerBody = 'self.onmessage = function () { /* decode_worker */ };';
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async (command, params, sessionId) => {
        if (command === 'Network.getResponseBody' && sessionId === 'worker-session') {
          expect(params?.requestId).toBe('C1D48F7B0123456789ABCDEF01234567');
          return { body: workerBody, base64Encoded: false };
        }
        return {};
      }),
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({
      cdp,
      recorder,
      now: () => '2026-09-15T07:06:00.000+08:00',
    });

    const emit = (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => {
      for (const listener of listeners) listener({}, method, params, sessionId);
    };

    emit('Network.requestWillBeSent', {
      requestId: 'C1D48F7B0123456789ABCDEF01234567',
      type: 'Script',
      request: {
        method: 'GET',
        url: 'https://10.128.4.88/libs/kvm/ast/decode_worker.js',
        headers: {},
      },
    });
    emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: {
        type: 'worker',
        url: 'https://10.128.4.88/libs/kvm/ast/decode_worker.js',
      },
    });
    await recorder.waitForIdle();
    emit(
      'Network.responseReceived',
      {
        requestId: 'C1D48F7B0123456789ABCDEF01234567',
        type: 'Script',
        response: {
          status: 200,
          mimeType: 'application/javascript',
          headers: { 'content-type': 'application/javascript' },
        },
      },
      'worker-session',
    );
    emit(
      'Network.loadingFinished',
      { requestId: 'C1D48F7B0123456789ABCDEF01234567', encodedDataLength: workerBody.length },
      'worker-session',
    );
    await recorder.waitForIdle();

    const request = recorder.toJSON().httpRequests[0];
    expect(request).toMatchObject({
      id: 'C1D48F7B0123456789ABCDEF01234567',
      status: 200,
      responseBodyCaptured: true,
    });
    expect(recorder.captureStatus().inFlightRequestIds).toEqual([]);
    expect(recorder.sourceFiles().some(file => file.text.includes('decode_worker'))).toBe(true);
  });

  it('salvages Worker main-script source after the child session Network.enable', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    let enableWorker: (() => void) | undefined;
    const workerBody = 'importScripts("Decoder.js");';
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async (command, _params, sessionId) => {
        if (command === 'Network.enable' && sessionId === 'worker-session') {
          await new Promise<void>(resolve => {
            enableWorker = resolve;
          });
          return {};
        }
        if (command === 'Network.getResponseBody' && sessionId === 'worker-session') {
          return { body: workerBody, base64Encoded: false };
        }
        return {};
      }),
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4 });
    await attachCdpNetworkCapture({ cdp, recorder, now: () => '2026-09-15T07:14:00.000+08:00' });

    for (const listener of listeners) {
      listener(
        {},
        'Network.requestWillBeSent',
        {
          requestId: '3917F6530123456789ABCDEF01234567',
          type: 'Script',
          request: {
            method: 'GET',
            url: 'https://10.128.6.235/DecodeWorker.js',
            headers: {},
          },
        },
      );
      listener(
        {},
        'Target.attachedToTarget',
        {
          sessionId: 'worker-session',
          targetInfo: { type: 'worker', url: 'https://10.128.6.235/DecodeWorker.js' },
        },
      );
    }
    expect(recorder.captureStatus().inFlightRequestIds).toEqual(['3917F6530123456789ABCDEF01234567']);
    enableWorker?.();
    await recorder.waitForIdle();

    expect(recorder.toJSON().httpRequests[0]).toMatchObject({
      id: '3917F6530123456789ABCDEF01234567',
      status: 200,
      responseBodyCaptured: true,
    });
    expect(recorder.captureStatus().inFlightRequestIds).toEqual([]);
    expect(recorder.sourceFiles()[0]?.text).toContain('Decoder.js');
  });

  it('finishes a Worker request as loading-failed when the child target detaches without a body', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async (command, _params, sessionId) => {
        if (command === 'Network.getResponseBody' && sessionId === 'worker-session') {
          throw new Error('No resource with given identifier found');
        }
        return {};
      }),
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({ frameHeadBytes: 4, idleTimeoutMs: 250 });
    await attachCdpNetworkCapture({ cdp, recorder, now: () => '2026-09-15T07:06:00.000+08:00' });
    for (const listener of listeners) {
      listener(
        {},
        'Network.requestWillBeSent',
        {
          requestId: 'DEADWORKER0123456789ABCDEF012345',
          type: 'Script',
          request: {
            method: 'GET',
            url: 'https://bmc.example/decode_worker.js',
            headers: {},
          },
        },
      );
      listener(
        {},
        'Target.attachedToTarget',
        {
          sessionId: 'worker-session',
          targetInfo: { type: 'worker', url: 'https://bmc.example/decode_worker.js' },
        },
      );
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    for (const listener of listeners) {
      listener({}, 'Target.detachedFromTarget', { sessionId: 'worker-session' });
    }
    await recorder.waitForIdle();

    expect(recorder.toJSON().httpRequests[0]).toMatchObject({
      id: 'DEADWORKER0123456789ABCDEF012345',
      responseBodySkippedReason: 'loading-failed',
    });
    expect(recorder.captureStatus().inFlightRequestIds).toEqual([]);
    expect(recorder.sourceFiles()).toEqual([]);
  });

  it('does not alias a Worker requestId onto an unrelated parent request', async () => {
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const workerBody = 'importScripts("DataStream.js");';
    const cdp: CdpDebuggerLike = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async (command, params, sessionId) => {
        if (command === 'Network.getResponseBody' && sessionId === 'worker-session') {
          if (params?.requestId === 'C1D48F7B0123456789ABCDEF01234567') {
            return { body: workerBody, base64Encoded: false };
          }
          return { body: 'export default 1;', base64Encoded: false };
        }
        return {};
      }),
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const recorder = createNetworkRecorder({
      frameHeadBytes: 4,
      idleQuietMs: 10,
      idleTimeoutMs: 400,
    });
    await attachCdpNetworkCapture({
      cdp,
      recorder,
      now: () => '2026-09-15T07:06:00.000+08:00',
    });
    const emit = (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => {
      for (const listener of listeners) listener({}, method, params, sessionId);
    };

    emit('Network.requestWillBeSent', {
      requestId: '1',
      type: 'XHR',
      request: {
        method: 'POST',
        url: 'https://10.128.4.88/api/session',
        headers: {},
      },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'C1D48F7B0123456789ABCDEF01234567',
      type: 'Script',
      request: {
        method: 'GET',
        url: 'https://10.128.4.88/libs/kvm/ast/decode_worker.js?v=2',
        headers: {},
      },
    });
    emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: {
        type: 'worker',
        url: 'https://10.128.4.88/libs/kvm/ast/decode_worker.js?v=2',
      },
    });
    emit(
      'Network.requestWillBeSent',
      {
        requestId: '1',
        type: 'Script',
        request: {
          method: 'GET',
          url: 'https://10.128.4.88/libs/kvm/ast/DataStream.js',
          headers: {},
        },
      },
      'worker-session',
    );
    emit(
      'Network.responseReceived',
      {
        requestId: 'C1D48F7B0123456789ABCDEF01234567',
        type: 'Script',
        response: {
          status: 200,
          mimeType: 'application/javascript',
          headers: { 'content-type': 'application/javascript' },
        },
      },
      'worker-session',
    );
    emit(
      'Network.loadingFinished',
      { requestId: 'C1D48F7B0123456789ABCDEF01234567', encodedDataLength: workerBody.length },
      'worker-session',
    );
    emit(
      'Network.responseReceived',
      {
        requestId: '1',
        type: 'Script',
        response: {
          status: 200,
          mimeType: 'application/javascript',
          headers: { 'content-type': 'application/javascript' },
        },
      },
      'worker-session',
    );
    emit(
      'Network.loadingFinished',
      { requestId: '1', encodedDataLength: 16 },
      'worker-session',
    );
    await recorder.waitForIdle();

    const snapshot = recorder.toJSON();
    const session = snapshot.httpRequests.find(item => item.id === '1');
    const worker = snapshot.httpRequests.find(
      item => item.id === 'C1D48F7B0123456789ABCDEF01234567',
    );
    const imported = snapshot.httpRequests.find(item => item.id === 'worker-session::1');
    expect(session).toMatchObject({
      url: expect.stringContaining('/api/session'),
      status: null,
    });
    expect(worker).toMatchObject({
      url: expect.stringContaining('decode_worker.js?v=2'),
      status: 200,
      responseBodyCaptured: true,
    });
    expect(imported).toMatchObject({
      url: expect.stringContaining('DataStream.js'),
      status: 200,
    });
    expect(recorder.captureStatus().inFlightRequestIds).toEqual(['1']);
  });
});
