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
      getChromiumAccess: () => ({ reachable: true, authorizationError: '' }),
      chooseSavePath: async fileName => `/tmp/${fileName}`,
      writeFile: async (path, bytes) => {
        written.push({ path, bytes });
      },
      now: () => '2026-08-24T14:05:00.000+08:00',
    });

    expect(result).toMatchObject({
      ok: true,
      fileName: 'KVM-Recon_20260824-135500_10-0-0-10_not-h5_NO.zip',
      filePath: '/tmp/KVM-Recon_20260824-135500_10-0-0-10_not-h5_NO.zip',
    });
    expect(written[0]?.path).toBe('/tmp/KVM-Recon_20260824-135500_10-0-0-10_not-h5_NO.zip');
    const zip = await JSZip.loadAsync(written[0]!.bytes);
    expect(await zip.file('report.html')!.async('string')).toContain('离场适配就绪：NO');
    expect(zip.file('README.md')).not.toBeNull();
    expect(await zip.file('README.md')!.async('string')).toContain('文件做什么');
    expect(zip.file('probe/redfish.json')).not.toBeNull();
    expect(JSON.parse(await zip.file('tls/certificate.json')!.async('string')).chromium).toEqual({
      reachable: true,
      authorizationError: '',
    });
  });

  it('packs screenshot png bytes into page/screenshots/', async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const written: Array<{ path: string; bytes: Uint8Array }> = [];

    const result = await exportCaptureJob({
      job: {
        jobId: 'job-export-004',
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
      getPage: () => ({
        jobId: 'job-export-004',
        events: [
          {
            type: 'screenshot',
            path: 'page/screenshots/viewer.png',
            sourcePath: '/tmp/kvm-recon/viewer.png',
            role: 'viewer',
            timestamp: '2026-08-24T12:00:04.000+08:00',
          },
        ],
      }),
      getNetwork: () => ({ httpRequests: [], webSockets: [], webSocketFrames: [] }),
      readScreenshotFile: async path => {
        expect(path).toBe('/tmp/kvm-recon/viewer.png');
        return png;
      },
      chooseSavePath: async fileName => `/tmp/${fileName}`,
      writeFile: async (path, bytes) => {
        written.push({ path, bytes });
      },
      now: () => '2026-08-24T14:05:00.000+08:00',
    });

    expect(result.ok).toBe(true);
    const zip = await JSZip.loadAsync(written[0]!.bytes);
    expect(new Uint8Array(await zip.file('page/screenshots/viewer.png')!.async('uint8array'))).toEqual(png);
    expect(JSON.parse(await zip.file('page/screenshots.json')!.async('string'))).toEqual([
      { path: 'page/screenshots/viewer.png', role: 'viewer' },
    ]);
    expect(await zip.file('page/timeline.jsonl')!.async('string')).not.toContain('/tmp/kvm-recon/viewer.png');
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
    const confirmExport = vi.fn(async () => true);

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
      confirmExport,
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
    expect(confirmExport).not.toHaveBeenCalled();
    expect(chooseSavePath).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('asks for confirmation after redaction passes and before choosing a save path', async () => {
    const chooseSavePath = vi.fn(async (fileName: string) => `/tmp/${fileName}`);
    const writeFile = vi.fn(async () => {});
    const confirmExport = vi.fn(async () => false);

    const result = await exportCaptureJob({
      job: {
        jobId: 'job-export-005',
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
            primary: 'not-h5',
            confidence: 0,
            candidates: [],
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
      },
      collectPageFacts: vi.fn(async () => {}),
      getPage: () => ({ jobId: 'job-export-005', events: [] }),
      getNetwork: () => ({ httpRequests: [], webSockets: [], webSocketFrames: [] }),
      getChromiumAccess: () => ({ reachable: true, authorizationError: '' }),
      confirmExport,
      chooseSavePath,
      writeFile,
      now: () => '2026-08-24T14:05:00.000+08:00',
    });

    expect(result).toMatchObject({
      ok: false,
      canceled: true,
    });
    expect(confirmExport).toHaveBeenCalledWith(
      expect.objectContaining({
        readiness: 'NO',
        redactionStatus: 'pass',
      }),
    );
    expect(chooseSavePath).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
