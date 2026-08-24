import { describe, expect, it } from 'vitest';

import { probeTlsInfo } from './probeTlsInfo';

describe('probeTlsInfo', () => {
  it('summarizes certificate, cipher, protocol, and self-signed status', async () => {
    const result = await probeTlsInfo({
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      connector: async () => ({
        authorized: false,
        authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        protocol: 'TLSv1.2',
        cipher: {
          name: 'AES256-GCM-SHA384',
          version: 'TLSv1.2',
        },
        certificate: {
          subject: { CN: 'bmc.local' },
          issuer: { CN: 'bmc.local' },
          subjectaltname: 'IP Address:10.0.0.10',
          valid_from: 'Jan 1 00:00:00 2026 GMT',
          valid_to: 'Jan 1 00:00:00 2027 GMT',
        },
      }),
    });

    expect(result).toEqual({
      reachable: true,
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      protocol: 'TLSv1.2',
      cipher: {
        name: 'AES256-GCM-SHA384',
        version: 'TLSv1.2',
      },
      certificate: {
        subject: { CN: 'bmc.local' },
        issuer: { CN: 'bmc.local' },
        subjectaltname: 'IP Address:10.0.0.10',
        validFrom: 'Jan 1 00:00:00 2026 GMT',
        validTo: 'Jan 1 00:00:00 2027 GMT',
        selfSigned: true,
      },
    });
  });
});
