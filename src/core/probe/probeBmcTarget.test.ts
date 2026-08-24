import { describe, expect, it } from 'vitest';

import { probeBmcTarget } from './probeBmcTarget';
import type { ProbeHttpClient } from './probeBmcBasics';

const httpClient: ProbeHttpClient = {
  async get(path) {
    if (path === '/redfish/v1') {
      return {
        status: 200,
        data: {
          Vendor: 'OpenBMC',
          Product: 'BMC',
        },
      };
    }
    if (path === '/randomtag' || path === '/kvm/video') {
      return { status: 200 };
    }
    return { status: 404 };
  },
};

describe('probeBmcTarget', () => {
  it('combines basic info, TLS info, path evidence, and family signatures', async () => {
    const result = await probeBmcTarget({
      target: {
        host: '10.0.0.20',
        port: 443,
        scheme: 'https',
      },
      httpClient,
      tlsConnector: async () => ({
        authorized: true,
        authorizationError: '',
        protocol: 'TLSv1.3',
        cipher: { name: 'TLS_AES_256_GCM_SHA384', version: 'TLSv1.3' },
        certificate: {
          subject: { CN: 'openbmc.local' },
          issuer: { CN: 'Local CA' },
          valid_from: 'Jan 1 00:00:00 2026 GMT',
          valid_to: 'Jan 1 00:00:00 2027 GMT',
        },
      }),
    });

    expect(result.basic.vendor).toBe('OpenBMC');
    expect(result.tls.reachable).toBe(true);
    expect(result.tls.protocol).toBe('TLSv1.3');
    expect(result.paths.randomtag).toBe(true);
    expect(result.paths.kvmVideo).toBe(true);
    expect(result.familySignatures.primary).toBe('openbmc-h5');
  });
});
