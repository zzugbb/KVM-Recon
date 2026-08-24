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
        '/redfish/v1/Managers/1/KvmService': { status: 200 },
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
        '/api/randomtag': { status: 200 },
        '/api/session': { status: 200 },
        '/api/kvm/token': { status: 401 },
        '/kvm/video': { status: 200 },
      }),
    });

    expect(result.paths.apiRandomtag).toBe(true);
    expect(result.paths.apiSession).toBe(true);
    expect(result.paths.apiKvmToken).toBe(true);
    expect(result.paths.kvmVideo).toBe(true);
    expect(result.familySignatures.primary).toBe('ami-megarac');
  });
});
