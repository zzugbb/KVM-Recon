import { describe, expect, it } from 'vitest';

import { probeBmcBasics, type ProbeHttpClient } from './probeBmcBasics';

function createHttpClient(
  responses: Record<string, { status: number; data?: unknown }>,
  calls: string[] = [],
): ProbeHttpClient {
  return {
    async get(path) {
      calls.push(path);
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
        '/redfish/v1/': {
          status: 200,
          data: {
            Vendor: 'Huawei',
            Product: 'iBMC',
            FirmwareVersion: '1.0.0',
            Oem: { Huawei: { SoftwareName: 'iBMC V5' } },
          },
        },
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
      path: '/redfish/v1/',
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
      oemKeys: ['Huawei'],
      oemSoftwareName: 'iBMC V5',
    });
    expect(result.paths.kvmService).toBeUndefined();
    expect(result.paths.setKvmKey).toBeUndefined();
    expect(result.familySignatures.primary).toBe('huawei-ibmc');
  });

  it('uses only side-effect-free production probes and recognizes AMI randomtag', async () => {
    const calls: string[] = [];
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.11',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient(
        {
          '/api/randomtag': { status: 200, data: { encrypt_ctrl: 1, random: 1234 } },
          '/api/session': { status: 200, data: { cc: 0, racsession_id: 'sid' } },
          '/api/kvm/token': { status: 200, data: { token: 'kvm-token', cc: 0 } },
        },
        calls,
      ),
    });

    expect(result.paths.apiRandomtag).toBe(true);
    expect(result.paths.apiSession).toBeUndefined();
    expect(result.paths.apiKvmToken).toBeUndefined();
    expect(result.familySignatures.primary).toBe('ami-megarac');
    expect(result.familySignatures.confidence).toBe(0.9);
    expect(calls).not.toContain('/api/session');
    expect(calls).not.toContain('/api/kvm/token');
    expect(calls).not.toContain('/api/settings/media/h5viewercfg');
    expect(calls).not.toContain(
      '/redfish/v1/Managers/1/KvmService/Actions/KvmService.SetKvmKey',
    );
  });

  it('treats a validated OpenBMC randomtag as a strong standalone fingerprint', async () => {
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.13',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient({
        '/randomtag': { status: 200, data: { random: 'x' } },
      }),
    });

    expect(result.paths.randomtag).toBe(true);
    expect(result.familySignatures.primary).toBe('openbmc-h5');
  });

  it.each([201, 204, 206])('requires HTTP 200 for randomtag evidence, not %s', async status => {
    const result = await probeBmcBasics({
      target: { host: '10.0.0.13', port: 443, scheme: 'https' },
      httpClient: createHttpClient({
        '/api/randomtag': { status, data: { encrypt_ctrl: 1, random: 'ami' } },
        '/randomtag': { status, data: { random: 'openbmc' } },
      }),
    });

    expect(result.paths.apiRandomtag).toBe(false);
    expect(result.paths.randomtag).toBe(false);
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
      }),
    });

    expect(result.paths.apiRandomtag).toBe(false);
    expect(result.paths.apiSession).toBeUndefined();
    expect(result.paths.apiKvmToken).toBeUndefined();
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
        '/api/randomtag': { status: 200, data: html },
      }),
    });

    expect(result.paths.apiSession).toBeUndefined();
    expect(result.paths.apiRandomtag).toBe(false);
    expect(result.paths.apiKvmToken).toBeUndefined();
    expect(result.familySignatures.primary).not.toBe('ami-megarac');
  });

  it('falls back to /redfish/v1 when the production Redfish root is not usable', async () => {
    const result = await probeBmcBasics({
      target: {
        host: '10.0.0.15',
        port: 443,
        scheme: 'https',
      },
      httpClient: createHttpClient({
        '/redfish/v1/': { status: 404 },
        '/redfish/v1': {
          status: 200,
          data: {
            Vendor: 'OpenBMC',
            Product: 'Test BMC',
          },
        },
      }),
    });

    expect(result.redfish).toMatchObject({
      path: '/redfish/v1',
      reachable: true,
      vendor: 'OpenBMC',
      product: 'Test BMC',
    });
  });

  it('starts Redfish and both randomtag probes before waiting for any response', async () => {
    const calls: string[] = [];
    let resolveRedfish: ((value: { status: number; data: unknown }) => void) | undefined;
    const resultPromise = probeBmcBasics({
      target: {
        host: '10.0.0.16',
        port: 443,
        scheme: 'https',
      },
      httpClient: {
        get(path) {
          calls.push(path);
          if (path === '/redfish/v1/') {
            return new Promise(resolve => {
              resolveRedfish = resolve;
            });
          }
          return Promise.resolve({ status: 404 });
        },
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(
      expect.arrayContaining(['/redfish/v1/', '/api/randomtag', '/randomtag']),
    );
    expect(calls).not.toContain('/redfish/v1');

    resolveRedfish?.({ status: 200, data: { Vendor: 'OpenBMC' } });
    await expect(resultPromise).resolves.toMatchObject({
      redfish: { path: '/redfish/v1/', reachable: true },
    });
  });
});
