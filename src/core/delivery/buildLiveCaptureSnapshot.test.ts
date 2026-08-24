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
            responseHeaders: {},
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
});
