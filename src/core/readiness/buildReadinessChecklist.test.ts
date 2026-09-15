import { describe, expect, it } from 'vitest';

import { buildReadinessChecklist, kvmWebSocketEvidence, reliableKvmWindows } from './buildReadinessChecklist';

const completeProbe = {
  basic: {
    host: '10.0.0.10',
    port: 443,
    scheme: 'https' as const,
    vendor: 'AMI',
    product: 'MegaRAC',
    firmwareVersion: '1.0.0',
  },
  paths: {
    apiRandomtag: true,
    apiSession: true,
    apiKvmToken: true,
  },
  familySignatures: {
    primary: 'ami-megarac' as const,
    confidence: 0.9,
    candidates: [
      {
        kvmFamily: 'ami-megarac' as const,
        confidence: 0.9,
        evidence: ['/api/randomtag', '/api/session', '/api/kvm/token'],
      },
    ],
  },
  tls: {
    reachable: true,
    authorized: false,
    authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
    protocol: 'TLSv1.2',
    cipher: { name: 'AES128-GCM-SHA256', version: 'TLSv1.2' },
    certificate: {
      subject: { CN: 'bmc.local' },
      issuer: { CN: 'bmc.local' },
      subjectaltname: '',
      validFrom: 'Aug 24 00:00:00 2026 GMT',
      validTo: 'Aug 24 00:00:00 2027 GMT',
      selfSigned: true,
    },
  },
};

const completeNetwork = {
  httpRequests: [
    {
      id: 'login-1',
      timestamp: '2026-08-24T12:00:00.000+08:00',
      method: 'POST',
      url: 'https://10.0.0.10/api/session',
      resourceType: 'xhr',
      status: 200,
      requestHeaders: {},
      responseHeaders: {},
      requestBodySummary: { bytes: 32, redactedFields: ['Password'] },
      responseBodySummary: {
        bytes: 64,
        redactedFields: ['CSRFToken'],
        jsonKeys: ['CSRFToken'],
      },
      tags: ['login' as const],
    },
    {
      id: 'token-1',
      timestamp: '2026-08-24T12:00:02.000+08:00',
      method: 'GET',
      url: 'https://10.0.0.10/api/kvm/token',
      resourceType: 'xhr',
      status: 200,
      requestHeaders: {},
      responseHeaders: {},
      requestBodySummary: { bytes: 0, redactedFields: [] },
      responseBodySummary: { bytes: 32, redactedFields: ['token'] },
      tags: ['kvm-token' as const],
    },
  ],
  webSockets: [
    {
      id: 'ws-1',
      createdAt: '2026-08-24T12:00:03.000+08:00',
      url: 'wss://10.0.0.10/kvm',
      subProtocols: ['binary'],
      requestHeaders: {},
      binaryFrameCount: 12,
      textFrameCount: 0,
      tags: ['kvm-video' as const],
    },
  ],
  webSocketFrames: [
    {
      socketId: 'ws-1',
      timestamp: '2026-08-24T12:00:03.100+08:00',
      direction: 'down' as const,
      opcode: 'binary' as const,
      bytes: 64,
      headHex: '17000001',
      sampled: true,
    },
  ],
};

const pageWithScreenshot = {
  jobId: 'job-001',
  events: [
    {
      type: 'selector-candidates',
      candidates: [{ role: 'kvm-entry', selector: '#kvm', confidence: 0.8 }],
      timestamp: '2026-08-24T12:00:01.000+08:00',
    },
    {
      type: 'screenshot',
      path: 'page/screenshots/viewer.png',
      role: 'viewer',
      timestamp: '2026-08-24T12:00:04.000+08:00',
    },
  ],
};

describe('buildReadinessChecklist', () => {
  it('does not treat an H3C home /websocket text frame as reliable KVM evidence', () => {
    const network = {
      httpRequests: completeNetwork.httpRequests,
      webSockets: [
        {
          id: 'ws-home',
          createdAt: '2026-09-07T02:43:13.000+08:00',
          url: 'wss://10.10.8.129/websocket',
          subProtocols: [],
          requestHeaders: {},
          binaryFrameCount: 0,
          textFrameCount: 1,
          tags: ['unknown' as const],
        },
      ],
      webSocketFrames: [
        {
          socketId: 'ws-home',
          timestamp: '2026-09-07T02:43:13.100+08:00',
          direction: 'down' as const,
          opcode: 'text' as const,
          bytes: 42,
          headHex: Buffer.from('{"event":"alarm","msg":"home"}', 'utf8').toString('hex').slice(0, 32),
          sampled: true,
        },
      ],
    };

    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: { jobId: 'job-h3c-home', events: [] },
      network,
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'ws.kvm.established')?.status).toBe(
      'needs_user_action',
    );
    expect(checklist.readiness).toBe('NO');
  });

  it('does not treat an unknown /websocket binary event as an AMI KVM frame', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: {
        jobId: 'job-generic-websocket',
        events: [
          {
            type: 'screenshot',
            path: 'page/screenshots/viewer-operator-confirmed.png',
            role: 'viewer',
            windowRole: 'main',
            operatorConfirmed: true,
          },
        ],
      },
      network: {
        httpRequests: [completeNetwork.httpRequests[0]],
        webSockets: [
          {
            id: 'ws-generic',
            createdAt: '2026-09-14T10:00:00.000+08:00',
            url: 'wss://10.0.0.10/websocket',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['unknown' as const],
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-generic',
            timestamp: '2026-09-14T10:00:00.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
            magic: 'AMI_IVTP_BINARY',
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'needs_user_action',
      evidence: [],
    });
  });

  it('does not correlate a static kvm.js asset with a generic binary WebSocket', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: { jobId: 'job-static-kvm-script', events: [] },
      network: {
        httpRequests: [
          {
            ...completeNetwork.httpRequests[1],
            id: 'static-kvm-script',
            timestamp: '2026-09-14T10:00:00.000+08:00',
            url: 'https://10.0.0.10/js/kvm.js',
            resourceType: 'script',
            status: 200,
            tags: ['kvm-entry' as const],
            windowRole: 'main' as const,
          },
        ],
        webSockets: [
          {
            id: 'ws-generic',
            createdAt: '2026-09-14T10:00:01.000+08:00',
            url: 'wss://10.0.0.10/websocket',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['unknown' as const],
            windowRole: 'main' as const,
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-generic',
            timestamp: '2026-09-14T10:00:01.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
            magic: 'AMI_IVTP_BINARY',
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'needs_user_action',
      evidence: [],
    });
  });

  it('does not treat a generic console status poll as a KVM launch for weak AMI frames', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: { jobId: 'job-console-status', events: [] },
      network: {
        httpRequests: [
          completeNetwork.httpRequests[0],
          {
            id: 'console-status',
            timestamp: '2026-09-14T10:00:00.000+08:00',
            method: 'GET',
            url: 'https://10.0.0.10/api/console/status',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: {},
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: { bytes: 12, redactedFields: [] },
            tags: ['kvm-entry' as const],
            windowRole: 'main' as const,
            captureWindowId: 'win-main',
          },
        ],
        webSockets: [
          {
            id: 'ws-generic',
            createdAt: '2026-09-14T10:00:01.000+08:00',
            url: 'wss://10.0.0.10/websocket',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['unknown' as const],
            windowRole: 'main' as const,
            captureWindowId: 'win-main',
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-generic',
            timestamp: '2026-09-14T10:00:01.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
            magic: 'AMI_IVTP_BINARY',
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'needs_user_action',
      evidence: [],
    });
    expect(checklist.items.find(item => item.id === 'http.key_api')?.evidence).not.toContain(
      'console-status',
    );
  });

  it('does not correlate weak AMI frames across two popups that share windowRole', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: { jobId: 'job-two-popups', events: [] },
      network: {
        httpRequests: [
          {
            ...completeNetwork.httpRequests[1],
            timestamp: '2026-09-14T10:00:00.000+08:00',
            windowRole: 'popup' as const,
            captureWindowId: 'popup-kvm',
          },
        ],
        webSockets: [
          {
            id: 'ws-vmedia',
            createdAt: '2026-09-14T10:00:02.000+08:00',
            url: 'wss://10.0.0.10/websocket',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['unknown' as const],
            windowRole: 'popup' as const,
            captureWindowId: 'popup-help',
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-vmedia',
            timestamp: '2026-09-14T10:00:02.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
            magic: 'AMI_IVTP_BINARY',
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'needs_user_action',
      evidence: [],
    });
  });

  it('correlates a main-window KVM token with a child popup WebSocket', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: { jobId: 'job-parent-child', events: [] },
      network: {
        httpRequests: [
          {
            ...completeNetwork.httpRequests[1],
            timestamp: '2026-09-14T10:00:00.000+08:00',
            windowRole: 'main' as const,
            captureWindowId: 'win-main',
          },
        ],
        webSockets: [
          {
            id: 'ws-child',
            createdAt: '2026-09-14T10:00:02.000+08:00',
            url: 'wss://10.0.0.10/websocket',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['unknown' as const],
            windowRole: 'popup' as const,
            captureWindowId: 'popup-kvm',
            openerCaptureWindowId: 'win-main',
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-child',
            timestamp: '2026-09-14T10:00:02.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
            magic: 'AMI_IVTP_BINARY',
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'pass',
      evidence: ['ws-child'],
    });
  });

  it('downgrades to PARTIAL when login Set-Cookie exists but POST body was not captured', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        httpRequests: [
          {
            ...completeNetwork.httpRequests[0],
            requestBodySummary: { bytes: 0, redactedFields: [] },
            requestBodySkippedReason: 'get-request-post-data-failed',
            responseHeaders: { 'set-cookie': 'QSESSIONID=abc' },
          },
          completeNetwork.httpRequests[1],
        ],
        webSockets: completeNetwork.webSockets,
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'login.chain')?.status).toBe('pass');
    expect(checklist.items.find(item => item.id === 'http.key_payload')).toMatchObject({
      status: 'missing',
      severity: 'warning',
    });
  });

  it('downgrades to PARTIAL when KVM token response body capture failed', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        httpRequests: [
          completeNetwork.httpRequests[0],
          {
            ...completeNetwork.httpRequests[1],
            responseBodySummary: { bytes: 0, redactedFields: [] },
            responseBodyCaptured: false,
            responseBodySkippedReason: 'get-response-body-failed',
          },
        ],
        webSockets: completeNetwork.webSockets,
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'http.key_api')?.status).toBe('pass');
    expect(checklist.items.find(item => item.id === 'http.key_payload')?.status).toBe('missing');
  });

  it('downgrades to PARTIAL when an explicit KVM launch POST body is missing', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        httpRequests: [
          completeNetwork.httpRequests[0],
          {
            ...completeNetwork.httpRequests[1],
            method: 'POST',
            url: 'https://10.0.0.10/api/kvm/token',
            requestBodySummary: { bytes: 0, redactedFields: [] },
            requestBodySkippedReason: 'get-request-post-data-failed',
          },
        ],
        webSockets: completeNetwork.webSockets,
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'http.key_payload')?.evidence).toContain(
      'token-1:kvm-request-body-missing',
    );
  });

  it('downgrades to PARTIAL when a KVM token response was loading-failed or too large', () => {
    for (const reason of ['loading-failed', 'response-too-large:2000000']) {
      const checklist = buildReadinessChecklist({
        probe: completeProbe,
        page: pageWithScreenshot,
        network: {
          httpRequests: [
            completeNetwork.httpRequests[0],
            {
              ...completeNetwork.httpRequests[1],
              responseBodySummary: { bytes: 0, redactedFields: [] },
              responseBodyCaptured: false,
              responseBodySkippedReason: reason,
            },
          ],
          webSockets: completeNetwork.webSockets,
          webSocketFrames: completeNetwork.webSocketFrames,
        },
        redaction: { status: 'pass', redactedFields: 2 },
      });

      expect(checklist.readiness).toBe('PARTIAL');
      expect(checklist.items.find(item => item.id === 'http.key_payload')?.status).toBe('missing');
    }
  });

  it('accepts a weak AMI frame only when a successful launch request is recent and in the same window', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: { jobId: 'job-correlated-launch', events: [] },
      network: {
        httpRequests: [
          {
            ...completeNetwork.httpRequests[1],
            timestamp: '2026-09-14T10:00:00.000+08:00',
            windowRole: 'popup' as const,
            captureWindowId: 'popup-kvm',
          },
        ],
        webSockets: [
          {
            id: 'ws-generic',
            createdAt: '2026-09-14T10:00:02.000+08:00',
            url: 'wss://10.0.0.10/websocket',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['unknown' as const],
            windowRole: 'popup' as const,
            captureWindowId: 'popup-kvm',
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-generic',
            timestamp: '2026-09-14T10:00:02.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
            magic: 'AMI_IVTP_BINARY',
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'pass',
      evidence: ['ws-generic'],
    });
  });

  it('does not correlate a weak AMI frame with a launch request from another window', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: { jobId: 'job-wrong-window-launch', events: [] },
      network: {
        httpRequests: [
          {
            ...completeNetwork.httpRequests[1],
            timestamp: '2026-09-14T10:00:00.000+08:00',
            windowRole: 'main' as const,
          },
        ],
        webSockets: [
          {
            id: 'ws-generic',
            createdAt: '2026-09-14T10:00:02.000+08:00',
            url: 'wss://10.0.0.10/websocket',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['unknown' as const],
            windowRole: 'popup' as const,
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-generic',
            timestamp: '2026-09-14T10:00:02.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
            magic: 'AMI_IVTP_BINARY',
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'needs_user_action',
      evidence: [],
    });
  });

  it('does not report a connection when every active probe failed before receiving a response', () => {
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        redfish: {
          path: '/redfish/v1/' as const,
          status: 0,
          reachable: false,
          vendor: '',
          product: '',
          firmwareVersion: '',
          rootFields: {},
        },
        pathDetails: {
          apiRandomtag: {
            path: '/api/randomtag',
            status: 0,
            hit: false,
            contentType: '',
            redirected: false,
            redirectLocation: '',
            bodyKind: 'empty' as const,
            jsonKeys: [],
            jsonShape: {},
            jsonPaths: {},
          },
          randomtag: {
            path: '/randomtag',
            status: 0,
            hit: false,
            contentType: '',
            redirected: false,
            redirectLocation: '',
            bodyKind: 'empty' as const,
            jsonKeys: [],
            jsonShape: {},
            jsonPaths: {},
          },
        },
        tls: { ...completeProbe.tls, reachable: false },
      },
      page: pageWithScreenshot,
      network: completeNetwork,
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'bmc.connection')).toMatchObject({
      status: 'missing',
      evidence: [],
    });
  });

  it('does not treat static login assets or Huawei legacy gettoken as login evidence', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          {
            ...completeNetwork.httpRequests[0],
            id: 'login-image',
            url: 'https://10.10.8.107/images/login.png',
            resourceType: 'image',
            tags: ['login' as const],
          },
          {
            ...completeNetwork.httpRequests[1],
            id: 'legacy-token',
            url: 'https://10.10.8.107/bmc/php/gettoken.php',
            tags: ['kvm-token' as const],
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'login.chain')?.evidence).toEqual([]);
    expect(checklist.items.find(item => item.id === 'page.kvm.entry')?.evidence).toContain(
      'legacy-token',
    );
  });

  it.each([
    ['GET session query', 'GET', 200],
    ['DELETE session', 'DELETE', 204],
    ['failed POST', 'POST', 401],
    ['unfinished POST', 'POST', null],
  ])('rejects %s as completed login evidence', (_label, method, status) => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          {
            ...completeNetwork.httpRequests[0],
            method,
            status,
          },
          completeNetwork.httpRequests[1],
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'login.chain')?.status).toBe(
      'needs_user_action',
    );
  });

  it('does not accept a GET login page as a completed login chain', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          {
            ...completeNetwork.httpRequests[0],
            id: 'login-page',
            method: 'GET',
            url: 'https://10.0.0.10/login.html',
            resourceType: 'document',
            tags: ['login' as const],
          },
          completeNetwork.httpRequests[1],
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'login.chain')).toMatchObject({
      status: 'needs_user_action',
      evidence: [],
    });
    expect(checklist.readiness).toBe('NO');
  });

  it('does not accept a successful POST without session evidence', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          {
            ...completeNetwork.httpRequests[0],
            responseHeaders: {},
            responseBodySummary: { bytes: 2, redactedFields: [], sample: '{}' },
          },
          completeNetwork.httpRequests[1],
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'login.chain')?.status).toBe(
      'needs_user_action',
    );
  });

  it('marks an otherwise complete capture PARTIAL when network idle waiting times out', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      networkIdle: {
        timedOut: true,
        pendingTaskCount: 1,
        inFlightRequestIds: ['session-1::request-9'],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'network.capture.complete')).toMatchObject({
      status: 'needs_user_action',
      severity: 'warning',
      evidence: [
        'timedOut=true',
        'pendingTaskCount=1',
        'materialPendingCount=0',
        'inFlightRequestCount=1',
        'materialInFlightCount=1',
        'inFlight=session-1::request-9',
        'materialInFlight=session-1::request-9',
      ],
    });
  });

  it('marks an otherwise complete capture PARTIAL when OOPIF Network.enable failed', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      networkIdle: {
        timedOut: false,
        pendingTaskCount: 0,
        inFlightRequestIds: [],
        attachFailures: [{ sessionId: 'oopif-session', reason: 'network-enable-failed' }],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'network.capture.complete')).toMatchObject({
      status: 'needs_user_action',
      evidence: expect.arrayContaining(['attachFailed=oopif-session:network-enable-failed']),
    });
  });

  it('returns NO with a blocking action when KVM WebSocket is missing', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        webSockets: [],
        webSocketFrames: [],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.readiness).toBe('NO');
    expect(checklist.items).toContainEqual(
      expect.objectContaining({
        id: 'ws.kvm.established',
        status: 'needs_user_action',
        severity: 'blocking',
        userAction: expect.stringContaining('等待至少 10 秒'),
      }),
    );
  });

  it('returns PARTIAL when critical HTTP and WebSocket facts exist but screenshots are missing', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: { jobId: 'job-001', events: [] },
      network: completeNetwork,
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items).toContainEqual(
      expect.objectContaining({
        id: 'page.viewer.screenshot',
        title: 'KVM 画面截图',
        status: 'missing',
        severity: 'warning',
      }),
    );
    expect(checklist.items.find(item => item.id === 'page.viewer.screenshot')?.title).not.toContain('已采集');
  });

  it('does not treat login or unlabeled screenshots as KVM viewer evidence', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: {
        jobId: 'job-001',
        events: [
          {
            type: 'selector-candidates',
            candidates: [{ role: 'kvm-entry', selector: '#kvm', confidence: 0.8 }],
            timestamp: '2026-08-24T12:00:01.000+08:00',
          },
          {
            type: 'screenshot',
            path: 'page/screenshots/login.png',
            role: 'login',
            timestamp: '2026-08-24T12:00:04.000+08:00',
          },
          {
            type: 'screenshot',
            path: 'page/screenshots/unlabeled.png',
            timestamp: '2026-08-24T12:00:05.000+08:00',
          },
        ],
      },
      network: completeNetwork,
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items).toContainEqual(
      expect.objectContaining({
        id: 'page.viewer.screenshot',
        status: 'missing',
      }),
    );
  });

  it('returns YES when key facts are complete and redaction passed', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.readiness).toBe('YES');
    expect(checklist.items.every(item => item.status === 'pass' || item.status === 'not_applicable')).toBe(
      true,
    );
  });

  it('returns NO when redaction check fails even if capture facts are complete', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      redaction: { status: 'fail', redactedFields: 0 },
    });

    expect(checklist.readiness).toBe('NO');
    expect(checklist.items).toContainEqual(
      expect.objectContaining({
        id: 'redaction.safe',
        status: 'fail',
        severity: 'blocking',
      }),
    );
  });

  it('scores fingerprint from TLS and KVM traffic instead of a stale AMI probe label', () => {
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        basic: {
          ...completeProbe.basic,
          vendor: '',
          product: '',
        },
        paths: {
          apiRandomtag: true,
          apiSession: true,
          apiKvmToken: true,
          randomtag: true,
          sessionService: true,
          kvmService: true,
          setKvmKey: false,
          kvmVideo: false,
        },
        familySignatures: {
          primary: 'ami-megarac',
          confidence: 0.9,
          candidates: [
            {
              kvmFamily: 'ami-megarac',
              confidence: 0.9,
              evidence: ['/api/randomtag', '/api/session', '/api/kvm/token'],
            },
          ],
        },
        tls: {
          ...completeProbe.tls,
          certificate: {
            ...completeProbe.tls.certificate,
            subject: { O: 'OpenBMC', CN: 'bmc' },
            issuer: { O: 'OpenBMC', CN: 'bmc' },
          },
        },
        authenticated: {
          attempted: true,
          cookieNames: ['SESSION'],
          paths: {
            apiRandomtag: false,
            apiSession: false,
            apiKvmToken: false,
            randomtag: true,
            sessionService: true,
            kvmService: true,
            setKvmKey: false,
            kvmVideo: false,
          },
        },
      },
      page: pageWithScreenshot,
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-08-25T14:00:10.000+08:00',
            method: 'POST',
            url: 'https://bmc.example/redfish/v1/SessionService/Sessions',
            resourceType: 'xhr',
            status: 201,
            requestHeaders: {},
            responseHeaders: {},
            requestBodySummary: { bytes: 32, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 64, redactedFields: ['Token'] },
            tags: ['login' as const],
          },
        ],
        webSockets: [
          {
            id: 'ws-kvm',
            createdAt: '2026-08-25T14:00:14.000+08:00',
            url: 'wss://bmc.example/kvm/video',
            subProtocols: ['token'],
            requestHeaders: {},
            binaryFrameCount: 8,
            textFrameCount: 0,
            tags: ['kvm-video' as const],
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-kvm',
            timestamp: '2026-08-25T14:00:14.100+08:00',
            direction: 'up' as const,
            opcode: 'text' as const,
            bytes: 48,
            headHex: Buffer.from('{"paths":["/xyz/openbmc_project/', 'utf8').toString('hex'),
            sampled: true,
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    const fingerprint = checklist.items.find(item => item.id === 'bmc.fingerprint');
    expect(fingerprint?.evidence[0]).toMatch(/^openbmc-h5:/);
    expect(fingerprint?.evidence.join(' ')).not.toContain('/api/session');
  });

  it('does not treat not-h5 as a passed family fingerprint', () => {
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        basic: { ...completeProbe.basic, vendor: '', product: '' },
        paths: {},
        familySignatures: {
          primary: 'not-h5',
          confidence: 0,
          candidates: [],
        },
      },
      page: null,
      network: { httpRequests: [], webSockets: [], webSocketFrames: [] },
      redaction: { status: 'pass', redactedFields: 0 },
    });
    const fingerprint = checklist.items.find(item => item.id === 'bmc.fingerprint');
    expect(fingerprint?.status).toBe('not_applicable');
    expect(fingerprint?.evidence[0]).toMatch(/^not-h5:/);
    expect(fingerprint?.userAction).toContain('新建 Adapter');
  });

  it('does not treat unknown-h5 as a missing family fingerprint', () => {
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        basic: { ...completeProbe.basic, vendor: '', product: '' },
        paths: { kvmService: true },
        familySignatures: {
          primary: 'unknown-h5',
          confidence: 0,
          candidates: [],
        },
      },
      page: null,
      network: { httpRequests: [], webSockets: [], webSocketFrames: [] },
      redaction: { status: 'pass', redactedFields: 0 },
    });
    const fingerprint = checklist.items.find(item => item.id === 'bmc.fingerprint');
    expect(fingerprint?.status).toBe('not_applicable');
    expect(fingerprint?.evidence[0]).toMatch(/^unknown-h5:/);
  });

  it('does not treat uplink-only KVM WebSocket frames as established', () => {
    const network = {
      httpRequests: completeNetwork.httpRequests,
      webSockets: [
        {
          id: 'ws-up',
          createdAt: '2026-09-14T12:00:03.000+08:00',
          url: 'wss://10.0.0.10/kvm',
          subProtocols: ['binary'],
          requestHeaders: {},
          binaryFrameCount: 1,
          textFrameCount: 0,
          tags: ['kvm-video' as const],
        },
      ],
      webSocketFrames: [
        {
          socketId: 'ws-up',
          timestamp: '2026-09-14T12:00:03.100+08:00',
          direction: 'up' as const,
          opcode: 'binary' as const,
          bytes: 16,
          headHex: '41504350',
          sampled: true,
          magic: 'DELL_APCP',
        },
      ],
    };
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network,
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(kvmWebSocketEvidence(network)).toEqual([]);
    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'needs_user_action',
      evidence: [],
    });
    expect(checklist.readiness).toBe('NO');
  });

  it('does not treat Huawei virtual media port 8208 as a KVM WebSocket', () => {
    const network = {
      httpRequests: completeNetwork.httpRequests,
      webSockets: [
        {
          id: 'ws-vmedia',
          createdAt: '2026-09-14T12:00:03.000+08:00',
          url: 'wss://10.10.8.107:8208/websocket',
          subProtocols: [],
          requestHeaders: {},
          binaryFrameCount: 2,
          textFrameCount: 0,
          tags: ['vmedia' as const],
        },
      ],
      webSocketFrames: [
        {
          socketId: 'ws-vmedia',
          timestamp: '2026-09-14T12:00:03.100+08:00',
          direction: 'down' as const,
          opcode: 'binary' as const,
          bytes: 8,
          headHex: 'fef60004',
          sampled: true,
          magic: 'HUAWEI_KVM_FEF6',
        },
      ],
    };
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network,
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(kvmWebSocketEvidence(network)).toEqual([]);
    expect(checklist.items.find(item => item.id === 'ws.kvm.established')).toMatchObject({
      status: 'needs_user_action',
      evidence: [],
    });
  });

  it('prefers the newest reliable KVM window after the viewer is reopened', () => {
    expect(
      reliableKvmWindows({
        httpRequests: completeNetwork.httpRequests,
        webSockets: [
          {
            id: 'ws-old',
            createdAt: '2026-09-14T12:00:03.000+08:00',
            url: 'wss://10.0.0.10/kvm',
            subProtocols: ['binary'],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['kvm-video' as const],
            windowRole: 'popup' as const,
            captureWindowId: 'popup-old',
          },
          {
            id: 'ws-new',
            createdAt: '2026-09-14T12:01:03.000+08:00',
            url: 'wss://10.0.0.10/kvm',
            subProtocols: ['binary'],
            requestHeaders: {},
            binaryFrameCount: 1,
            textFrameCount: 0,
            tags: ['kvm-video' as const],
            windowRole: 'popup' as const,
            captureWindowId: 'popup-new',
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-old',
            timestamp: '2026-09-14T12:00:03.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
          },
          {
            socketId: 'ws-new',
            timestamp: '2026-09-14T12:01:03.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 4,
            headHex: '17000001',
            sampled: true,
          },
        ],
      }).map(window => window.captureWindowId),
    ).toEqual(['popup-new', 'popup-old']);
  });

  it('downgrades to PARTIAL when Viewer HTML/JS was seen but no source sample was kept', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        httpRequests: [
          ...completeNetwork.httpRequests,
          {
            id: 'viewer-js',
            timestamp: '2026-09-14T12:00:02.500+08:00',
            method: 'GET',
            url: 'https://10.0.0.10/html5viewer.js',
            resourceType: 'script',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'content-type': 'application/javascript' },
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: { bytes: 800000, redactedFields: [] },
            responseBodyCaptured: false,
            responseBodySkippedReason: 'response-too-large:800000',
            tags: [],
          },
        ],
        webSockets: completeNetwork.webSockets,
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'http.viewer_source')).toMatchObject({
      status: 'missing',
      evidence: ['viewer-js:sha256=missing:bytes=800000:truncated'],
    });
  });

  it('keeps YES when Viewer HTML/JS samples were captured', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        httpRequests: [
          ...completeNetwork.httpRequests,
          {
            id: 'viewer-js',
            timestamp: '2026-09-14T12:00:02.500+08:00',
            method: 'GET',
            url: 'https://10.0.0.10/html5viewer.js',
            resourceType: 'script',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'content-type': 'application/javascript' },
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: {
              bytes: 1200,
              redactedFields: [],
              sample: `function startKvmViewer() {${'A'.repeat(64)}}`,
            },
            responseBodyCaptured: true,
            tags: [],
          },
        ],
        webSockets: completeNetwork.webSockets,
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });

    expect(checklist.items.find(item => item.id === 'http.viewer_source')?.status).toBe('pass');
    expect(checklist.readiness).toBe('YES');
  });

  it('does not require Viewer source samples for a known AMI family', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.items.find(item => item.id === 'http.viewer_source')?.status).toBe(
      'not_applicable',
    );
    expect(checklist.readiness).toBe('YES');
  });

  it('treats viewer primary bundles as required sources for unknown families', () => {
    const unknownNetwork = {
      httpRequests: [
        {
          id: 'login-1',
          timestamp: '2026-09-14T12:00:00.000+08:00',
          method: 'POST',
          url: 'https://bmc.example/login',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {},
          responseHeaders: { 'set-cookie': 'SID=<redacted:sha256:sample>' } as Record<string, string>,
          requestBodySummary: { bytes: 16, redactedFields: ['Password'] },
          responseBodySummary: { bytes: 8, redactedFields: [] },
          tags: ['login' as const],
        },
        {
          id: 'home-chunk',
          timestamp: '2026-09-14T12:00:00.500+08:00',
          method: 'GET',
          url: 'https://bmc.example/static/js/8f3a21.chunk.js',
          resourceType: 'script',
          status: 200,
          requestHeaders: {},
          responseHeaders: { 'content-type': 'application/javascript' },
          requestBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySummary: { bytes: 1200, redactedFields: [] },
          responseBodyCaptured: false,
          sourceTruncated: true,
          tags: [],
          windowRole: 'main' as const,
        },
        {
          id: 'chunk-1',
          timestamp: '2026-09-14T12:00:01.000+08:00',
          method: 'GET',
          url: 'https://bmc.example/static/js/main.8f3a21.js',
          resourceType: 'script',
          status: 200,
          requestHeaders: {},
          responseHeaders: { 'content-type': 'application/javascript' },
          requestBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySummary: {
            bytes: 1200,
            redactedFields: [],
            sample: `(()=>{window.kvm=true;${'A'.repeat(64)}})()`,
          },
          responseBodyCaptured: true,
          sourceKind: 'javascript' as const,
          sourceSha256: 'a'.repeat(64),
          sourceBytes: 1200,
          sourceTruncated: false,
          tags: [],
          windowRole: 'popup' as const,
          captureWindowId: 'popup-kvm',
        },
      ],
      webSockets: [
        {
          id: 'ws-1',
          createdAt: '2026-09-14T12:00:02.000+08:00',
          url: 'wss://bmc.example/kvm',
          subProtocols: ['binary'],
          requestHeaders: {},
          binaryFrameCount: 4,
          textFrameCount: 0,
          tags: ['kvm-video' as const],
        },
      ],
      webSocketFrames: completeNetwork.webSocketFrames,
    };
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        basic: { ...completeProbe.basic, host: 'bmc.example', vendor: '', product: '' },
        paths: {},
        familySignatures: { primary: 'not-h5', confidence: 0, candidates: [] },
      },
      page: pageWithScreenshot,
      network: unknownNetwork,
      redaction: { status: 'pass', redactedFields: 1 },
    });

    expect(checklist.items.find(item => item.id === 'http.viewer_source')).toMatchObject({
      status: 'pass',
      evidence: [expect.stringContaining('chunk-1:')],
    });
  });

  it('downgrades unknown families when the page referenced main/polyfill but only a worker was captured', () => {
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        basic: { ...completeProbe.basic, host: '10.10.8.101', vendor: '', product: '' },
        paths: {},
        familySignatures: { primary: 'unknown-h5', confidence: 0, candidates: [] },
      },
      page: {
        ...pageWithScreenshot,
        events: [
          ...pageWithScreenshot.events,
          {
            type: 'page-scripts',
            windowRole: 'popup',
            captureWindowId: 'popup-kvm',
            timestamp: '2026-09-14T12:00:03.000+08:00',
            scripts: [
              {
                url: 'https://10.10.8.101/vmc/vconsole/main.36508cda.js',
                kind: 'javascript',
                initiator: 'script-tag',
              },
              {
                url: 'https://10.10.8.101/vmc/vconsole/polyfills.41fe.js',
                kind: 'javascript',
                initiator: 'script-tag',
              },
              {
                url: 'https://10.10.8.101/vmc/vconsole/file.worker.js',
                kind: 'javascript',
                initiator: 'worker',
              },
            ],
          },
        ],
      },
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-09-14T12:00:00.000+08:00',
            method: 'POST',
            url: 'https://10.10.8.101/login',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'set-cookie': 'SID=<redacted:sha256:sample>' } as Record<string, string>,
            requestBodySummary: { bytes: 16, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 8, redactedFields: [] },
            tags: ['login' as const],
          },
          {
            id: 'worker-1',
            timestamp: '2026-09-14T12:00:01.000+08:00',
            method: 'GET',
            url: 'https://10.10.8.101/vmc/vconsole/file.worker.js',
            resourceType: 'script',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'content-type': 'application/javascript' },
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: {
              bytes: 1200,
              redactedFields: [],
              sample: `self.onmessage=function(){${'A'.repeat(64)}}`,
            },
            responseBodyCaptured: true,
            sourceKind: 'javascript' as const,
            sourceSha256: 'd'.repeat(64),
            sourceBytes: 1200,
            sourceTruncated: false,
            tags: [],
          },
        ],
        webSockets: completeNetwork.webSockets.map(socket => ({
          ...socket,
          url: 'wss://10.10.8.101/kvm',
        })),
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 1 },
    });

    expect(checklist.items.find(item => item.id === 'http.viewer_source')).toMatchObject({
      status: 'missing',
      userAction: expect.stringContaining('重新打开 HTML5 KVM'),
      evidence: expect.arrayContaining([
        'missing:https://10.10.8.101/vmc/vconsole/main.36508cda.js',
        'missing:https://10.10.8.101/vmc/vconsole/polyfills.41fe.js',
      ]),
    });
    expect(checklist.readiness).toBe('PARTIAL');
  });

  it('downgrades HPE iLO when Viewer window only captured worker_decoder.js', () => {
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        basic: { ...completeProbe.basic, host: '10.10.8.94', vendor: '', product: '' },
        paths: {},
        familySignatures: { primary: 'unknown-h5', confidence: 0, candidates: [] },
      },
      page: {
        ...pageWithScreenshot,
        events: [
          ...pageWithScreenshot.events,
          {
            type: 'page-scripts',
            windowRole: 'popup',
            captureWindowId: 'popup-ilo',
            timestamp: '2026-09-14T12:00:03.000+08:00',
            scripts: [
              'application.js',
              'socket.js',
              'state.js',
              'iLO.js',
              'constants.js',
              'worker_decoder.js',
            ].map(name => ({
              url: `https://10.10.8.94/js/${name}`,
              kind: 'javascript',
              initiator: name === 'worker_decoder.js' ? 'worker' : 'script-tag',
            })),
          },
        ],
      },
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-09-14T12:00:00.000+08:00',
            method: 'POST',
            url: 'https://10.10.8.94/login',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'set-cookie': 'SID=<redacted:sha256:sample>' } as Record<string, string>,
            requestBodySummary: { bytes: 16, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 8, redactedFields: [] },
            tags: ['login' as const],
          },
          {
            id: 'worker-1',
            timestamp: '2026-09-14T12:00:02.000+08:00',
            method: 'GET',
            url: 'https://10.10.8.94/js/worker_decoder.js',
            resourceType: 'script',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'content-type': 'application/javascript' },
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: {
              bytes: 800,
              redactedFields: [],
              sample: `self.onmessage=function(){${'A'.repeat(64)}}`,
            },
            responseBodyCaptured: true,
            sourceKind: 'javascript' as const,
            sourceSha256: 'd'.repeat(64),
            sourceBytes: 800,
            sourceTruncated: false,
            tags: [],
            windowRole: 'popup' as const,
            captureWindowId: 'popup-ilo',
          },
        ],
        webSockets: completeNetwork.webSockets.map(socket => ({
          ...socket,
          url: 'wss://10.10.8.94/kvm',
          captureWindowId: 'popup-ilo',
          windowRole: 'popup' as const,
        })),
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 1 },
    });

    expect(checklist.items.find(item => item.id === 'http.viewer_source')).toMatchObject({
      status: 'missing',
      evidence: expect.arrayContaining([
        'missing:https://10.10.8.94/js/application.js',
        'missing:https://10.10.8.94/js/iLO.js',
      ]),
    });
    expect(checklist.readiness).toBe('PARTIAL');
  });

  it('downgrades unknown families when one required source is truncated even if another is complete', () => {
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        basic: { ...completeProbe.basic, host: 'bmc.example', vendor: '', product: '' },
        paths: {},
        familySignatures: { primary: 'not-h5', confidence: 0, candidates: [] },
      },
      page: pageWithScreenshot,
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-09-14T12:00:00.000+08:00',
            method: 'POST',
            url: 'https://bmc.example/login',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'set-cookie': 'SID=<redacted:sha256:sample>' } as Record<string, string>,
            requestBodySummary: { bytes: 16, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 8, redactedFields: [] },
            tags: ['login' as const],
          },
          {
            id: 'viewer-html',
            timestamp: '2026-09-14T12:00:01.000+08:00',
            method: 'GET',
            url: 'https://bmc.example/console/html5viewer.html',
            resourceType: 'document',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'content-type': 'text/html' },
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: {
              bytes: 256,
              redactedFields: [],
              sample: '<!doctype html><html><body>kvm</body></html>',
            },
            responseBodyCaptured: true,
            sourceKind: 'html' as const,
            sourceSha256: 'b'.repeat(64),
            sourceBytes: 256,
            sourceTruncated: false,
            tags: ['kvm-entry' as const],
          },
          {
            id: 'chunk-1',
            timestamp: '2026-09-14T12:00:01.100+08:00',
            method: 'GET',
            url: 'https://bmc.example/console/main.8f3a21.js',
            resourceType: 'script',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'content-type': 'application/javascript' },
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: {
              bytes: 65536,
              redactedFields: [],
              sample: `${'A'.repeat(64)}<truncated>`,
            },
            responseBodyCaptured: true,
            sourceKind: 'javascript' as const,
            sourceSha256: 'c'.repeat(64),
            sourceBytes: 65536,
            sourceTruncated: true,
            tags: [],
          },
        ],
        webSockets: completeNetwork.webSockets.map(socket => ({
          ...socket,
          url: 'wss://bmc.example/kvm',
        })),
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 1 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'http.viewer_source')).toMatchObject({
      status: 'missing',
      evidence: [expect.stringContaining('chunk-1:')],
    });
  });

  it('tells operators that a source-budget cap cannot be fixed by recapture', () => {
    const checklist = buildReadinessChecklist({
      probe: {
        ...completeProbe,
        basic: { ...completeProbe.basic, host: 'bmc.example', vendor: '', product: '' },
        paths: {},
        familySignatures: { primary: 'not-h5', confidence: 0, candidates: [] },
      },
      page: {
        ...pageWithScreenshot,
        events: [
          ...pageWithScreenshot.events,
          {
            type: 'page-scripts',
            windowRole: 'popup',
            captureWindowId: 'popup-kvm',
            timestamp: '2026-09-14T12:00:03.000+08:00',
            scripts: [
              {
                url: 'https://bmc.example/console/main.8f3a21.js',
                kind: 'javascript',
                initiator: 'script-tag',
              },
            ],
          },
        ],
      },
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-09-14T12:00:00.000+08:00',
            method: 'POST',
            url: 'https://bmc.example/login',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'set-cookie': 'SID=<redacted:sha256:sample>' } as Record<string, string>,
            requestBodySummary: { bytes: 16, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 8, redactedFields: [] },
            tags: ['login' as const],
          },
          {
            id: 'chunk-1',
            timestamp: '2026-09-14T12:00:01.100+08:00',
            method: 'GET',
            url: 'https://bmc.example/console/main.8f3a21.js',
            resourceType: 'script',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'content-type': 'application/javascript' },
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: { bytes: 4096, redactedFields: [] },
            responseBodyCaptured: false,
            responseBodySkippedReason: 'source-budget-exceeded:4096',
            sourceKind: 'javascript' as const,
            sourceBytes: 4096,
            tags: [],
            windowRole: 'popup' as const,
            captureWindowId: 'popup-kvm',
          },
        ],
        webSockets: completeNetwork.webSockets.map(socket => ({
          ...socket,
          url: 'wss://bmc.example/kvm',
          captureWindowId: 'popup-kvm',
          windowRole: 'popup' as const,
        })),
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 1 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'http.viewer_source')).toMatchObject({
      status: 'missing',
      userAction: expect.stringContaining('重新打开 Viewer 或重新采集无法突破'),
    });
  });

  it('marks an otherwise complete capture PARTIAL while requests are still in flight', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      networkIdle: {
        timedOut: false,
        pendingTaskCount: 1,
        inFlightRequestIds: ['viewer-js'],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.readiness).toBe('PARTIAL');
    expect(checklist.items.find(item => item.id === 'network.capture.complete')).toMatchObject({
      status: 'needs_user_action',
      evidence: expect.arrayContaining(['pendingTaskCount=1', 'inFlight=viewer-js']),
    });
  });

  it('accepts AMI h5viewercfg as the key KVM launch API with payload evidence', () => {
    const h5viewercfg = {
      id: 'h5viewercfg-1',
      timestamp: '2026-09-15T07:36:00.000+08:00',
      method: 'GET',
      url: 'https://10.130.34.1/api/settings/media/h5viewercfg',
      resourceType: 'xhr',
      status: 200,
      requestHeaders: {},
      responseHeaders: { 'content-type': 'application/json' },
      requestBodySummary: { bytes: 0, redactedFields: [] },
      responseBodySummary: {
        bytes: 128,
        redactedFields: ['token'],
        jsonKeys: ['token', 'session', 'server_ip', 'kvm_service_status'],
      },
      responseBodyCaptured: true,
      tags: ['kvm-token' as const],
      captureWindowId: 'win-main',
      windowRole: 'main' as const,
    };
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        httpRequests: [completeNetwork.httpRequests[0], h5viewercfg],
        webSockets: [
          {
            ...completeNetwork.webSockets[0],
            url: 'wss://10.130.34.1/kvm',
            captureWindowId: 'popup-viewer',
            openerCaptureWindowId: 'win-main',
            ancestorCaptureWindowIds: ['win-main'],
            windowRole: 'popup' as const,
          },
        ],
        webSocketFrames: completeNetwork.webSocketFrames,
      },
      redaction: { status: 'pass', redactedFields: 4 },
    });

    expect(checklist.items.find(item => item.id === 'http.key_api')).toMatchObject({
      status: 'pass',
      evidence: ['h5viewercfg-1'],
    });
    expect(checklist.items.find(item => item.id === 'http.key_payload')?.status).toBe('pass');
    expect(checklist.items.find(item => item.id === 'ws.kvm.established')?.status).toBe('pass');
    expect(checklist.items.find(item => item.id === 'bmc.fingerprint')?.evidence).toEqual(
      expect.arrayContaining(['http:/api/session', 'http:/api/settings/media/h5viewercfg']),
    );
  });

  it('keeps PARTIAL when the only KVM launch request is still in flight', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          completeNetwork.httpRequests[0],
          {
            ...completeNetwork.httpRequests[1],
            id: 'token-inflight',
            status: null,
            responseBodySummary: { bytes: 0, redactedFields: [] },
            responseBodyCaptured: false,
          },
        ],
      },
      networkIdle: {
        timedOut: true,
        pendingTaskCount: 0,
        inFlightRequestIds: ['token-inflight'],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.items.find(item => item.id === 'http.key_api')?.status).toBe('missing');
    expect(checklist.items.find(item => item.id === 'network.capture.complete')).toMatchObject({
      status: 'needs_user_action',
      evidence: expect.arrayContaining(['materialInFlight=token-inflight']),
    });
    expect(checklist.readiness).toBe('PARTIAL');
  });

  it('does not degrade network completeness for a duplicate poll when a complete twin exists', () => {
    const kvmService = {
      id: 'kvm-service-1',
      timestamp: '2026-09-15T07:14:00.000+08:00',
      method: 'GET',
      url: 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService',
      resourceType: 'xhr',
      status: 200,
      requestHeaders: {},
      responseHeaders: { 'content-type': 'application/json' },
      requestBodySummary: { bytes: 2, redactedFields: [] },
      responseBodySummary: { bytes: 64, redactedFields: [] },
      responseBodyCaptured: true,
      tags: ['kvm-token' as const],
    };
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          ...completeNetwork.httpRequests,
          kvmService,
          {
            ...kvmService,
            id: 'kvm-service-poll',
            timestamp: '2026-09-15T07:14:31.000+08:00',
            status: null,
            responseBodySummary: { bytes: 0, redactedFields: [] },
            responseBodyCaptured: false,
          },
        ],
      },
      networkIdle: {
        timedOut: true,
        pendingTaskCount: 0,
        inFlightRequestIds: ['kvm-service-poll'],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });

    expect(checklist.items.find(item => item.id === 'network.capture.complete')).toMatchObject({
      status: 'pass',
      evidence: expect.arrayContaining([
        'timedOut=true',
        'inFlight=kvm-service-poll',
        'materialInFlightCount=0',
      ]),
    });
    expect(checklist.readiness).toBe('YES');
  });

  it('keeps PARTIAL when a later KvmService POST is still in flight after an earlier POST succeeded', () => {
    const kvmServicePost = {
      id: 'kvm-service-post-1',
      timestamp: '2026-09-15T07:14:00.000+08:00',
      method: 'POST',
      url: 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService',
      resourceType: 'xhr',
      status: 200,
      requestHeaders: {},
      responseHeaders: { 'content-type': 'application/json' },
      requestBodySummary: { bytes: 32, redactedFields: [] },
      responseBodySummary: { bytes: 64, redactedFields: [] },
      responseBodyCaptured: true,
      tags: ['kvm-token' as const],
    };
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          ...completeNetwork.httpRequests,
          kvmServicePost,
          {
            ...kvmServicePost,
            id: 'kvm-service-post-2',
            timestamp: '2026-09-15T07:14:31.000+08:00',
            status: null,
            responseBodySummary: { bytes: 0, redactedFields: [] },
            responseBodyCaptured: false,
          },
        ],
      },
      networkIdle: {
        timedOut: true,
        pendingTaskCount: 0,
        inFlightRequestIds: ['kvm-service-post-2'],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });
    expect(checklist.items.find(item => item.id === 'network.capture.complete')).toMatchObject({
      status: 'needs_user_action',
      evidence: expect.arrayContaining(['materialInFlight=kvm-service-post-2']),
    });
    expect(checklist.readiness).toBe('PARTIAL');
  });

  it('keeps PARTIAL when unique Viewer/Worker source is still in flight or missing its body', () => {
    const worker = {
      id: 'decode-worker',
      timestamp: '2026-09-15T07:06:00.000+08:00',
      method: 'GET',
      url: 'https://10.128.4.88/libs/kvm/ast/decode_worker.js',
      resourceType: 'script',
      status: null as number | null,
      requestHeaders: {},
      responseHeaders: {},
      requestBodySummary: { bytes: 0, redactedFields: [] },
      responseBodySummary: { bytes: 0, redactedFields: [] },
      responseBodyCaptured: false,
      tags: [] as Array<'login' | 'kvm-token' | 'kvm-entry'>,
    };
    const unknownProbe = {
      ...completeProbe,
      familySignatures: { primary: 'unknown-h5' as const, confidence: 0, candidates: [] },
    };
    const inflight = buildReadinessChecklist({
      probe: unknownProbe,
      page: {
        jobId: 'job-worker',
        events: [
          ...pageWithScreenshot.events,
          {
            type: 'page-scripts',
            captureWindowId: 'popup-viewer',
            scripts: [
              {
                url: 'https://10.128.4.88/libs/kvm/ast/decode_worker.js',
                kind: 'javascript',
                initiator: 'worker',
              },
            ],
          },
        ],
      },
      network: {
        ...completeNetwork,
        httpRequests: [...completeNetwork.httpRequests, worker],
        webSockets: [
          {
            ...completeNetwork.webSockets[0],
            captureWindowId: 'popup-viewer',
            windowRole: 'popup' as const,
          },
        ],
      },
      networkIdle: {
        timedOut: false,
        pendingTaskCount: 0,
        inFlightRequestIds: ['decode-worker'],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });
    expect(inflight.items.find(item => item.id === 'network.capture.complete')?.status).toBe(
      'needs_user_action',
    );

    const failed = buildReadinessChecklist({
      probe: unknownProbe,
      page: {
        jobId: 'job-worker-failed',
        events: [
          ...pageWithScreenshot.events,
          {
            type: 'page-scripts',
            captureWindowId: 'popup-viewer',
            scripts: [
              {
                url: 'https://10.128.4.88/libs/kvm/ast/decode_worker.js',
                kind: 'javascript',
                initiator: 'worker',
              },
            ],
          },
        ],
      },
      network: {
        ...completeNetwork,
        httpRequests: [
          ...completeNetwork.httpRequests,
          {
            ...worker,
            status: 200,
            responseBodySkippedReason: 'loading-failed',
          },
        ],
        webSockets: [
          {
            ...completeNetwork.webSockets[0],
            captureWindowId: 'popup-viewer',
            windowRole: 'popup' as const,
          },
        ],
      },
      redaction: { status: 'pass', redactedFields: 2 },
    });
    expect(failed.items.find(item => item.id === 'http.viewer_source')?.status).toBe('missing');
    expect(failed.readiness).toBe('PARTIAL');
  });

  it('does not ignore a second in-flight login or token just because an earlier one succeeded', () => {
    const loginRetry = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          completeNetwork.httpRequests[0],
          {
            ...completeNetwork.httpRequests[0],
            id: 'login-retry',
            status: null,
            responseBodySummary: { bytes: 0, redactedFields: [] },
            responseBodyCaptured: false,
          },
          completeNetwork.httpRequests[1],
        ],
      },
      networkIdle: {
        timedOut: false,
        pendingTaskCount: 0,
        inFlightRequestIds: ['login-retry'],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });
    expect(loginRetry.items.find(item => item.id === 'network.capture.complete')?.status).toBe(
      'needs_user_action',
    );

    const tokenRetry = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          completeNetwork.httpRequests[0],
          completeNetwork.httpRequests[1],
          {
            ...completeNetwork.httpRequests[1],
            id: 'token-retry',
            status: null,
            responseBodySummary: { bytes: 0, redactedFields: [] },
            responseBodyCaptured: false,
          },
        ],
      },
      networkIdle: {
        timedOut: false,
        pendingTaskCount: 0,
        inFlightRequestIds: ['token-retry'],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });
    expect(tokenRetry.items.find(item => item.id === 'network.capture.complete')?.status).toBe(
      'needs_user_action',
    );
  });

  it('does not degrade completeness for a pending body read of a non-critical request', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: {
        ...completeNetwork,
        httpRequests: [
          ...completeNetwork.httpRequests,
          {
            id: 'heartbeat',
            timestamp: '2026-09-15T07:14:30.000+08:00',
            method: 'GET',
            url: 'https://10.0.0.10/api/heartbeat',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: {},
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: { bytes: 8, redactedFields: [] },
            responseBodyCaptured: true,
            tags: [],
          },
        ],
      },
      networkIdle: {
        timedOut: false,
        pendingTaskCount: 1,
        pendingTasks: [{ kind: 'response-body' as const, requestId: 'heartbeat' }],
        inFlightRequestIds: [],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });
    expect(checklist.items.find(item => item.id === 'network.capture.complete')?.status).toBe('pass');
    expect(checklist.readiness).toBe('YES');
  });

  it('keeps PARTIAL when a pending body read belongs to a KVM token request', () => {
    const checklist = buildReadinessChecklist({
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      networkIdle: {
        timedOut: false,
        pendingTaskCount: 1,
        pendingTasks: [{ kind: 'response-body' as const, requestId: 'token-1' }],
        inFlightRequestIds: [],
      },
      redaction: { status: 'pass', redactedFields: 6 },
    });
    expect(checklist.items.find(item => item.id === 'network.capture.complete')).toMatchObject({
      status: 'needs_user_action',
      evidence: expect.arrayContaining(['materialPending=token-1']),
    });
  });
});
