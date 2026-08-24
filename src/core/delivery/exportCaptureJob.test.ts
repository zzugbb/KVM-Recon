import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

import { exportCaptureJob } from './exportCaptureJob';

describe('exportCaptureJob', () => {
  it('writes a Capture Pack zip using the delivery file name', async () => {
    const written: Array<{ path: string; bytes: Uint8Array }> = [];

    const result = await exportCaptureJob({
      job: {
        jobId: 'job-export-001',
        startedAt: '2026-08-24T13:55:00.000+08:00',
        target: {
          host: '10.0.0.10',
          port: 443,
          scheme: 'https',
        },
        probe: {
          basic: {
            host: '10.0.0.10',
            port: 443,
            scheme: 'https',
            vendor: '',
            product: '',
            firmwareVersion: '',
          },
          paths: {},
          familySignatures: {
            primary: 'unknown-h5',
            confidence: 0,
            candidates: [],
          },
          tls: {
            reachable: false,
            authorized: false,
            authorizationError: '',
            protocol: '',
            cipher: null,
            certificate: null,
          },
        },
      },
      collectPageFacts: vi.fn(async () => {}),
      getPage: () => ({ jobId: 'job-export-001', events: [] }),
      getNetwork: () => ({ httpRequests: [], webSockets: [], webSocketFrames: [] }),
      chooseSavePath: async fileName => `/tmp/${fileName}`,
      writeFile: async (path, bytes) => {
        written.push({ path, bytes });
      },
      now: () => '2026-08-24T14:05:00.000+08:00',
    });

    expect(result).toMatchObject({
      ok: true,
      fileName: 'KVM-Recon_20260824-135500_10-0-0-10_unknown-h5_NO.zip',
      filePath: '/tmp/KVM-Recon_20260824-135500_10-0-0-10_unknown-h5_NO.zip',
    });
    expect(written[0]?.path).toBe('/tmp/KVM-Recon_20260824-135500_10-0-0-10_unknown-h5_NO.zip');
    const zip = await JSZip.loadAsync(written[0]!.bytes);
    expect(await zip.file('report.html')!.async('string')).toContain('离场适配就绪：NO');
  });

  it('returns a permission-limited field error when the zip cannot be written', async () => {
    const result = await exportCaptureJob({
      job: {
        jobId: 'job-export-002',
        startedAt: '2026-08-24T13:55:00.000+08:00',
        target: {
          host: '10.0.0.10',
          port: 443,
          scheme: 'https',
        },
        probe: {
          basic: {
            host: '10.0.0.10',
            port: 443,
            scheme: 'https',
            vendor: '',
            product: '',
            firmwareVersion: '',
          },
          paths: {},
          familySignatures: {
            primary: 'unknown-h5',
            confidence: 0,
            candidates: [],
          },
          tls: {
            reachable: false,
            authorized: false,
            authorizationError: '',
            protocol: '',
            cipher: null,
            certificate: null,
          },
        },
      },
      collectPageFacts: vi.fn(async () => {}),
      getPage: () => ({ jobId: 'job-export-002', events: [] }),
      getNetwork: () => ({ httpRequests: [], webSockets: [], webSocketFrames: [] }),
      chooseSavePath: async fileName => `/restricted/${fileName}`,
      writeFile: async () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
      now: () => '2026-08-24T14:05:00.000+08:00',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        title: '当前权限不足',
      },
    });
  });

  it('blocks the default export when redaction check fails', async () => {
    const writeFile = vi.fn(async () => {});
    const chooseSavePath = vi.fn(async (fileName: string) => `/tmp/${fileName}`);

    const result = await exportCaptureJob({
      job: {
        jobId: 'job-export-003',
        startedAt: '2026-08-24T13:55:00.000+08:00',
        target: {
          host: '10.0.0.10',
          port: 443,
          scheme: 'https',
        },
        probe: {
          basic: {
            host: '10.0.0.10',
            port: 443,
            scheme: 'https',
            vendor: '',
            product: '',
            firmwareVersion: '',
          },
          paths: {},
          familySignatures: {
            primary: 'unknown-h5',
            confidence: 0,
            candidates: [],
          },
          tls: {
            reachable: false,
            authorized: false,
            authorizationError: '',
            protocol: '',
            cipher: null,
            certificate: null,
          },
        },
      },
      collectPageFacts: vi.fn(async () => {}),
      getPage: () => ({ jobId: 'job-export-003', events: [] }),
      getNetwork: () => ({
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-08-24T12:00:00.000+08:00',
            method: 'POST',
            url: 'https://10.0.0.10/api/session',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: { Password: 'secret-password' },
            responseHeaders: {},
            requestBodySummary: { bytes: 20, redactedFields: [] },
            responseBodySummary: { bytes: 0, redactedFields: [] },
            tags: ['login'],
          },
        ],
        webSockets: [],
        webSocketFrames: [],
      }),
      sensitiveValues: ['secret-password'],
      chooseSavePath,
      writeFile,
      now: () => '2026-08-24T14:05:00.000+08:00',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        title: '脱敏检查未通过',
      },
    });
    expect(chooseSavePath).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
