import { describe, expect, it } from 'vitest';

import { buildNetworkArtifacts } from './buildNetworkArtifacts';
import type { HttpRequestRecord, WebSocketFrameRecord, WebSocketRecord } from './createNetworkRecorder';

describe('buildNetworkArtifacts', () => {
  it('serializes HTTP and WebSocket facts for capture packs', () => {
    const httpRequests: HttpRequestRecord[] = [
      {
        id: 'req-1',
        timestamp: '2026-08-24T12:00:00.000+08:00',
        method: 'GET',
        url: 'https://bmc.example/api/kvm/token',
        resourceType: 'xhr',
        status: 200,
        requestHeaders: {},
        responseHeaders: {},
        requestBodySummary: { bytes: 0, redactedFields: [] },
        responseBodySummary: { bytes: 21, redactedFields: ['token'] },
        tags: ['login', 'kvm-token'],
      },
    ];
    const webSockets: WebSocketRecord[] = [
      {
        id: 'ws-1',
        createdAt: '2026-08-24T12:00:01.000+08:00',
        url: 'wss://bmc.example/kvm',
        subProtocols: ['binary'],
        requestHeaders: {},
        binaryFrameCount: 1,
        textFrameCount: 0,
        tags: ['kvm-video'],
      },
    ];
    const webSocketFrames: WebSocketFrameRecord[] = [
      {
        socketId: 'ws-1',
        timestamp: '2026-08-24T12:00:01.100+08:00',
        direction: 'down',
        opcode: 'binary',
        bytes: 8,
        headHex: '17000001',
        sampled: true,
      },
    ];

    const artifacts = buildNetworkArtifacts({ httpRequests, webSockets, webSocketFrames });

    expect(artifacts.map(item => item.path)).toEqual([
      'http/requests.jsonl',
      'http/har.json',
      'http/adapter-evidence.json',
      'ws/sockets.json',
      'ws/frames.jsonl',
    ]);
    expect(artifacts[0].content).toContain('"tags":["login","kvm-token"]');
    expect(JSON.parse(artifacts[1].content)).toMatchObject({
      log: {
        version: '1.2',
        entries: [
          {
            request: { method: 'GET', url: 'https://bmc.example/api/kvm/token' },
            response: { status: 200 },
          },
        ],
      },
    });
    const adapterEvidence = JSON.parse(artifacts[2].content);
    expect(adapterEvidence).toMatchObject({
      loginChain: [
        {
          id: 'req-1',
          tags: ['login', 'kvm-token'],
        },
      ],
      kvmLaunchChain: [
        {
          id: 'req-1',
          status: 200,
        },
      ],
      webSocketUpgrades: [
        {
          id: 'ws-1',
          firstFrame: {
            headHex: '17000001',
          },
        },
      ],
      correlations: [
        {
          socketId: 'ws-1',
          likelyKvmLaunchHttpIds: ['req-1'],
        },
      ],
    });
    expect(adapterEvidence.webSocketUpgrades[0]).not.toHaveProperty('windowRole');
    expect(JSON.parse(artifacts[3].content)).toEqual(webSockets);
    expect(artifacts[4].content).toContain('"headHex":"17000001"');
  });

  it('correlates adapter evidence with the same window, success, and two-minute window', () => {
    const artifacts = buildNetworkArtifacts({
      httpRequests: [
        {
          id: 'launch-other-window',
          timestamp: '2026-08-24T12:00:00.000+08:00',
          method: 'GET',
          url: 'https://bmc.example/api/kvm/token',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySummary: { bytes: 21, redactedFields: ['token'] },
          tags: ['kvm-token'],
          windowRole: 'popup',
          captureWindowId: 'popup-a',
        },
        {
          id: 'stale-launch',
          timestamp: '2026-08-24T11:50:00.000+08:00',
          method: 'GET',
          url: 'https://bmc.example/api/kvm/token',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySummary: { bytes: 21, redactedFields: ['token'] },
          tags: ['kvm-token'],
          windowRole: 'popup',
          captureWindowId: 'popup-b',
        },
        {
          id: 'failed-launch',
          timestamp: '2026-08-24T12:00:00.500+08:00',
          method: 'GET',
          url: 'https://bmc.example/api/kvm/token',
          resourceType: 'xhr',
          status: 500,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySummary: { bytes: 0, redactedFields: [] },
          tags: ['kvm-token'],
          windowRole: 'popup',
          captureWindowId: 'popup-b',
        },
        {
          id: 'console-status',
          timestamp: '2026-08-24T12:00:00.600+08:00',
          method: 'GET',
          url: 'https://bmc.example/api/console/status',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySummary: { bytes: 8, redactedFields: [] },
          tags: ['kvm-entry'],
          windowRole: 'popup',
          captureWindowId: 'popup-b',
        },
        {
          id: 'launch-same-window',
          timestamp: '2026-08-24T12:00:00.700+08:00',
          method: 'GET',
          url: 'https://bmc.example/api/kvm/token',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySummary: { bytes: 21, redactedFields: ['token'] },
          tags: ['kvm-token'],
          windowRole: 'popup',
          captureWindowId: 'popup-b',
        },
      ],
      webSockets: [
        {
          id: 'ws-1',
          createdAt: '2026-08-24T12:00:01.000+08:00',
          url: 'wss://bmc.example/kvm',
          subProtocols: ['binary'],
          requestHeaders: {},
          binaryFrameCount: 1,
          textFrameCount: 0,
          tags: ['kvm-video'],
          windowRole: 'popup',
          captureWindowId: 'popup-b',
        },
      ],
      webSocketFrames: [],
    });

    const adapterEvidence = JSON.parse(artifacts[2].content);
    expect(adapterEvidence.correlations[0].likelyKvmLaunchHttpIds).toEqual(['launch-same-window']);
    expect(adapterEvidence.kvmLaunchChain.map((item: { id: string }) => item.id)).toEqual([
      'launch-other-window',
      'stale-launch',
      'launch-same-window',
    ]);
  });

  it('correlates adapter evidence from a main-window launch to a child popup WebSocket', () => {
    const artifacts = buildNetworkArtifacts({
      httpRequests: [
        {
          id: 'login-main',
          timestamp: '2026-08-24T12:00:00.000+08:00',
          method: 'POST',
          url: 'https://bmc.example/api/session',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySummary: { bytes: 16, redactedFields: [] },
          responseBodySummary: { bytes: 16, redactedFields: [] },
          tags: ['login'],
          windowRole: 'main',
          captureWindowId: 'win-main',
        },
        {
          id: 'token-main',
          timestamp: '2026-08-24T12:00:00.500+08:00',
          method: 'GET',
          url: 'https://bmc.example/api/kvm/token',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          requestBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySummary: { bytes: 21, redactedFields: ['token'] },
          tags: ['kvm-token'],
          windowRole: 'main',
          captureWindowId: 'win-main',
        },
      ],
      webSockets: [
        {
          id: 'ws-child',
          createdAt: '2026-08-24T12:00:01.000+08:00',
          url: 'wss://bmc.example/websocket',
          subProtocols: [],
          requestHeaders: {},
          binaryFrameCount: 1,
          textFrameCount: 0,
          tags: ['unknown'],
          windowRole: 'popup',
          captureWindowId: 'popup-kvm',
          openerCaptureWindowId: 'win-main',
        },
      ],
      webSocketFrames: [],
    });

    const adapterEvidence = JSON.parse(artifacts[2].content);
    expect(adapterEvidence.correlations[0]).toMatchObject({
      socketId: 'ws-child',
      captureWindowId: 'popup-kvm',
      openerCaptureWindowId: 'win-main',
      likelyLoginHttpIds: ['login-main'],
      likelyKvmLaunchHttpIds: ['token-main'],
    });
  });
});
