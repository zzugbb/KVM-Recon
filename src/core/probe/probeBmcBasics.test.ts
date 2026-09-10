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
    expect(result.redfish).toMatchObject({
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
    expect(result.paths.setKvmKey).toBe(false);
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
        '/api/randomtag': { status: 200, data: { encrypt_ctrl: 1, random: 1234 } },
        '/api/session': { status: 200, data: { cc: 0, racsession_id: 'sid' } },
        '/api/kvm/token': { status: 200, data: { token: 'kvm-token', cc: 0 } },
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

  it('does not treat GET /kvm/video 401 as OpenBMC path evidence', async () => {
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.13',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient({
        '/kvm/video': { status: 401 },
        '/randomtag': { status: 200, data: { random: 'x' } },
      }),
    });

    expect(result.paths.kvmVideo).toBe(false);
    expect(result.paths.randomtag).toBe(true);
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

  it('does not treat UTF-8 BOM HTML 200 as AMI /api evidence', async () => {
    const html = `\uFEFF<!doctype html><html><head></head><body>app</body></html>`;
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.14',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient({
        '/api/session': { status: 200, data: html },
        '/api/randomtag': { status: 200, data: html },
        '/api/kvm/token': { status: 200, data: html },
      }),
    });

    expect(result.paths.apiSession).toBe(false);
    expect(result.paths.apiRandomtag).toBe(false);
    expect(result.paths.apiKvmToken).toBe(false);
    expect(result.familySignatures.primary).not.toBe('ami-megarac');
  });

  it('falls back to /redfish/v1/ when the slashless Redfish root is not usable', async () => {
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.15',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient({
        '/redfish/v1': { status: 404 },
        '/redfish/v1/': {
          status: 200,
          data: {
            Vendor: 'OpenBMC',
            Product: 'Test BMC',
          },
        },
      }),
    });

    expect(result.redfish).toMatchObject({
      path: '/redfish/v1/',
      reachable: true,
      vendor: 'OpenBMC',
      product: 'Test BMC',
    });
  });
});
