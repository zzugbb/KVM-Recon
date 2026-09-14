import { describe, expect, it } from 'vitest';

import { buildLiveCaptureSnapshot } from './buildLiveCaptureSnapshot';

describe('buildLiveCaptureSnapshot', () => {
  it('summarizes live capture progress without treating redaction as blocking', () => {
    const snapshot = buildLiveCaptureSnapshot({
      probe: {
        basic: {
          host: '10.0.0.10',
          port: 443,
          scheme: 'https',
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
          primary: 'ami-megarac',
          confidence: 0.9,
          candidates: [
            {
              kvmFamily: 'ami-megarac',
              confidence: 0.9,
              evidence: ['/api/kvm/token'],
            },
          ],
        },
        tls: {
          reachable: true,
          authorized: false,
          authorizationError: '',
          protocol: 'TLSv1.2',
          cipher: null,
          certificate: null,
        },
      },
      page: { jobId: 'job-live', events: [] },
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-08-24T12:00:00.000+08:00',
            method: 'POST',
            url: 'https://10.0.0.10/api/session',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: { 'set-cookie': 'QSESSIONID=<redacted:sha256:sample>' },
            requestBodySummary: { bytes: 8, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 8, redactedFields: [] },
            tags: ['login'],
          },
        ],
        webSockets: [],
        webSocketFrames: [],
      },
    });

    expect(snapshot.readiness).toBe('NO');
    expect(snapshot.items.map(item => item.id)).not.toContain('redaction.safe');
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        id: 'login.chain',
        status: 'pass',
      }),
    );
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        id: 'ws.kvm.established',
        status: 'needs_user_action',
      }),
    );
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        id: 'page.viewer.screenshot',
        status: 'missing',
      }),
    );
  });

  it('keeps live YES consistent with export when attachFailures are already known', () => {
    const probe = {
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
            evidence: ['/api/kvm/token'],
          },
        ],
      },
      tls: {
        reachable: true,
        authorized: false,
        authorizationError: '',
        protocol: 'TLSv1.2',
        cipher: null,
        certificate: null,
      },
    };
    const page = {
      jobId: 'job-live',
      events: [
        {
          type: 'screenshot',
          path: 'page/screenshots/viewer.png',
          role: 'viewer',
        },
        {
          type: 'selector-candidates',
          candidates: [{ role: 'kvm-entry', selector: '#kvm' }],
        },
      ],
    };
    const network = {
      httpRequests: [
        {
          id: 'login-1',
          timestamp: '2026-08-24T12:00:00.000+08:00',
          method: 'POST',
          url: 'https://10.0.0.10/api/session',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {} as Record<string, string>,
          responseHeaders: { 'set-cookie': 'QSESSIONID=<redacted:sha256:sample>' },
          requestBodySummary: { bytes: 8, redactedFields: ['Password'] },
          responseBodySummary: { bytes: 8, redactedFields: [] },
          tags: ['login' as const],
        },
        {
          id: 'token-1',
          timestamp: '2026-08-24T12:00:02.000+08:00',
          method: 'GET',
          url: 'https://10.0.0.10/api/kvm/token',
          resourceType: 'xhr',
          status: 200,
          requestHeaders: {} as Record<string, string>,
          responseHeaders: {} as Record<string, string>,
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

    expect(buildLiveCaptureSnapshot({ probe, page, network }).readiness).toBe('YES');
    expect(
      buildLiveCaptureSnapshot({
        probe,
        page,
        network,
        networkIdle: {
          timedOut: false,
          pendingTaskCount: 0,
          inFlightRequestIds: [],
          attachFailures: [{ sessionId: 'popup-kvm', reason: 'cdp-attach-failed' }],
        },
      }).readiness,
    ).toBe('PARTIAL');
    expect(
      buildLiveCaptureSnapshot({
        probe,
        page,
        network,
        networkIdle: {
          timedOut: false,
          pendingTaskCount: 1,
          inFlightRequestIds: ['viewer-js'],
        },
      }).readiness,
    ).toBe('PARTIAL');
  });
});
