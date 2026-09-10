import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { buildCapturePackZip } from '../core/capture-pack/buildCapturePackZip';
import { validateManifestShape } from '../core/capture-pack/validateCapturePackShape';
import { assembleCapturePackForExport } from '../core/delivery/assembleCapturePackForExport';
import { createNodeProbeHttpClient } from '../core/probe/createNodeProbeHttpClient';
import { probeBmcTarget } from '../core/probe/probeBmcTarget';

function startMockBmc() {
  const server = http.createServer((request, response) => {
    const path = request.url || '/';
    if (path === '/redfish/v1') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          Vendor: 'AMI',
          Product: 'MegaRAC SP-X',
          FirmwareVersion: '1.0.0-e2e',
        }),
      );
      return;
    }
    if (path === '/api/randomtag') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ random: 'abc123', encrypt_ctrl: 0 }));
      return;
    }
    if (path === '/api/session') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ racsession_id: 'mock-session', CSRFToken: 'mock-token', privilege: 4 }));
      return;
    }
    if (path === '/api/kvm/token') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token: 'mock-kvm-token', client_ip: '127.0.0.1', cc: 0 }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  return new Promise<{ server: http.Server; port: number }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

describe('offline HTTP capture pack e2e', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const mock = await startMockBmc();
    server = mock.server;
    port = mock.port;
  });

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          // 捕获测试结束后关闭本地 mock BMC 失败：端口可能仍被占用
          // 策略：失败则让测试套件失败，避免泄漏监听端口
          if (error) reject(error);
          else resolve();
        });
      }),
  );

  it('probes a local BMC stand-in and exports a redacted zip without passwords', async () => {
    const target = {
      host: '127.0.0.1',
      port,
      scheme: 'http' as const,
    };

    const probe = await probeBmcTarget({
      target,
      httpClient: createNodeProbeHttpClient(target),
    });

    expect(probe.familySignatures.primary).toBe('ami-megarac');
    expect(probe.basic.vendor).toBe('AMI');
    expect(probe.paths.apiRandomtag).toBe(true);

    const assembled = assembleCapturePackForExport({
      jobId: 'e2e-offline-http',
      startedAt: '2026-08-24T16:00:00.000+08:00',
      endedAt: '2026-08-24T16:01:00.000+08:00',
      target,
      operatorNote: 'ci-e2e',
      probe,
      page: {
        jobId: 'e2e-offline-http',
        events: [{ type: 'navigation', url: `http://127.0.0.1:${port}/` }],
      },
      network: {
        httpRequests: [
          {
            id: 'e2e-login',
            timestamp: '2026-08-24T16:00:10.000+08:00',
            method: 'POST',
            url: `http://127.0.0.1:${port}/api/session`,
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: {},
            requestBodySummary: { bytes: 24, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 16, redactedFields: ['CSRFToken'] },
            tags: ['login'],
          },
        ],
        webSockets: [],
        webSocketFrames: [],
      },
      sensitiveValues: ['super-secret-pass'],
    });

    expect(assembled.canExportSafePack).toBe(true);
    expect(validateManifestShape(assembled.pack.manifest)).toEqual([]);

    const zipBytes = await buildCapturePackZip(assembled.pack);
    const zip = await JSZip.loadAsync(zipBytes);
    const manifestText = await zip.file('manifest.json')?.async('string');
    const reportText = await zip.file('report.md')?.async('string');

    expect(manifestText).toBeTruthy();
    expect(manifestText).not.toContain('super-secret-pass');
    expect(reportText).not.toContain('super-secret-pass');
    expect(assembled.fileName).toContain('ami-megarac');
  });
});
