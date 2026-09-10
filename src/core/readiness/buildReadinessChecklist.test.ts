import { describe, expect, it } from 'vitest';

import { buildReadinessChecklist } from './buildReadinessChecklist';

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
      responseBodySummary: { bytes: 64, redactedFields: ['CSRFToken'] },
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

  it('does not treat static login assets as login evidence but accepts Huawei legacy token PHP', () => {
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

    expect(checklist.items.find(item => item.id === 'login.chain')?.evidence).toEqual([
      'legacy-token',
    ]);
    expect(checklist.items.find(item => item.id === 'page.kvm.entry')?.evidence).toContain(
      'legacy-token',
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
        'inFlight=session-1::request-9',
      ],
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
        paths: { randomtag: true },
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
});
