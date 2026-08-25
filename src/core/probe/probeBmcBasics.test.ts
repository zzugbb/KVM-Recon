import { describe, expect, it } from 'vitest';

import { probeBmcBasics, type ProbeHttpClient } from './probeBmcBasics';

function createHttpClient(responses: Record<string, { status: number; data?: unknown }>): ProbeHttpClient {
  return {
    async get(path) {
      return responses[path] ?? { status: 404 };
    },
  };
}

describe('probeBmcBasics', () => {
  it('collects Redfish basics, path evidence, and family signatures', async () => {
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient({
        '/redfish/v1': {
          status: 200,
          data: {
            Vendor: 'Huawei',
            Product: 'iBMC',
            FirmwareVersion: '1.0.0',
          },
        },
        '/redfish/v1/Managers/1/KvmService': { status: 200, data: { Id: 'KvmService' } },
        '/redfish/v1/Managers/1/KvmService/Actions/KvmService.SetKvmKey': { status: 405 },
      }),
    });

    expect(result.basic).toEqual({
      host: '10.0.0.10',
      port: 443,
      scheme: 'https',
      vendor: 'Huawei',
      product: 'iBMC',
      firmwareVersion: '1.0.0',
    });
    expect(result.redfish).toEqual({
      path: '/redfish/v1',
      status: 200,
      reachable: true,
      vendor: 'Huawei',
      product: 'iBMC',
      firmwareVersion: '1.0.0',
      rootFields: {
        Vendor: 'Huawei',
        Product: 'iBMC',
        FirmwareVersion: '1.0.0',
      },
    });
    expect(result.paths.kvmService).toBe(true);
    expect(result.paths.setKvmKey).toBe(true);
    expect(result.familySignatures.primary).toBe('huawei-ibmc');
  });

  it('treats AMI /api evidence as stronger than generic /kvm/video', async () => {
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.11',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient({
        '/api/randomtag': { status: 200, data: { token: 'x' } },
        '/api/session': { status: 200, data: { ok: true } },
        '/api/kvm/token': { status: 401 },
        '/kvm/video': { status: 200, data: { stream: true } },
      }),
    });

    expect(result.paths.apiRandomtag).toBe(true);
    expect(result.paths.apiSession).toBe(true);
    expect(result.paths.apiKvmToken).toBe(true);
    expect(result.paths.kvmVideo).toBe(true);
    expect(result.familySignatures.primary).toBe('ami-megarac');
    expect(result.familySignatures.confidence).toBeLessThan(0.8);
  });

  it('does not treat SPA HTML 200 as AMI /api evidence', async () => {
    const html = '<!doctype html><html><head></head><body>app</body></html>';
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.12',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient({
        '/api/randomtag': { status: 200, data: html },
        '/api/session': { status: 200, data: html },
        '/api/kvm/token': { status: 200, data: html },
        '/redfish/v1/Managers/1/KvmService': { status: 200, data: { Id: 'KvmService' } },
      }),
    });

    expect(result.paths.apiRandomtag).toBe(false);
    expect(result.paths.apiSession).toBe(false);
    expect(result.paths.apiKvmToken).toBe(false);
    expect(result.paths.kvmService).toBe(true);
    expect(result.familySignatures.primary).not.toBe('ami-megarac');
  });
});
