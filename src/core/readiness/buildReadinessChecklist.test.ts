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
      timestamp: '2026-08-24T12:00:04.000+08:00',
    },
  ],
};

describe('buildReadinessChecklist', () => {
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
        status: 'missing',
        severity: 'warning',
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
});
