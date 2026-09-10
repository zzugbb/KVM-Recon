import { describe, expect, it } from 'vitest';

import { applyAuthenticatedProbe, probeBmcTarget } from './probeBmcTarget';
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
    if (path === '/randomtag') {
      return { status: 200, data: { random: 1234, OemString: 'Public' } };
    }
    if (path === '/kvm/video') {
      return { status: 200, data: { ok: true } };
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

  it('merges anonymous and authenticated path evidence without storing cookie values', async () => {
    const anonymous = await probeBmcTarget({
      target: { host: '10.0.0.10', port: 443, scheme: 'https' },
      httpClient: {
        async get() {
          return { status: 404 };
        },
      },
      tlsConnector: async () => ({
        authorized: false,
        protocol: 'TLSv1.2',
        cipher: null,
        certificate: null,
      }),
    });
    const authenticated = await probeBmcTarget({
      target: { host: '10.0.0.10', port: 443, scheme: 'https' },
      httpClient: {
        async get(path) {
          if (path === '/api/randomtag' || path === '/api/session' || path === '/api/kvm/token') {
            if (path === '/api/randomtag') return { status: 200, data: { encrypt_ctrl: 1, random: 1234 } };
            if (path === '/api/session') return { status: 200, data: { cc: 0, racsession_id: 'sid' } };
            return { status: 200, data: { token: 'kvm-token', cc: 0 } };
          }
          return { status: 404 };
        },
      },
      tlsConnector: async () => ({
        authorized: false,
        protocol: 'TLSv1.2',
        cipher: null,
        certificate: null,
      }),
    });

    const merged = applyAuthenticatedProbe(anonymous, authenticated, ['QSESSIONID', 'QSESSIONID']);
    expect(merged.familySignatures.primary).toBe('ami-megarac');
    expect(merged.authenticated).toMatchObject({
      attempted: true,
      cookieNames: ['QSESSIONID'],
      paths: authenticated.paths,
    });
    expect(JSON.stringify(merged)).not.toContain('abc123');
  });

  it('lets authenticated false overlay anonymous true so AMI SPA hits do not stick', async () => {
    const html = '<!doctype html><html><body>app</body></html>';
    const anonymous = await probeBmcTarget({
      target: { host: '10.0.0.10', port: 443, scheme: 'https' },
      httpClient: {
        async get(path) {
          if (path.startsWith('/api/')) {
            return { status: 200, data: html };
          }
          if (path === '/redfish/v1/SessionService' || path === '/redfish/v1/Managers/1/KvmService') {
            return { status: 401 };
          }
          return { status: 404 };
        },
      },
      tlsConnector: async () => ({
        authorized: false,
        protocol: 'TLSv1.3',
        cipher: null,
        certificate: {
          subject: { O: 'OpenBMC', CN: 'bmc' },
          issuer: { O: 'OpenBMC', CN: 'bmc' },
        },
      }),
    });
    const authenticated = await probeBmcTarget({
      target: { host: '10.0.0.10', port: 443, scheme: 'https' },
      httpClient: {
        async get(path) {
          if (path.startsWith('/api/')) {
            return { status: 404 };
          }
          if (path === '/randomtag') {
            return { status: 200, data: { random: 1234, OemString: 'Public' } };
          }
          if (path === '/redfish/v1/SessionService') {
            return { status: 200, data: { '@odata.id': '/redfish/v1/SessionService' } };
          }
          if (path === '/redfish/v1/Managers/1/KvmService') {
            return { status: 200, data: { Id: 'KvmService' } };
          }
          return { status: 404 };
        },
      },
      tlsConnector: async () => ({
        authorized: false,
        protocol: 'TLSv1.3',
        cipher: null,
        certificate: {
          subject: { O: 'OpenBMC', CN: 'bmc' },
          issuer: { O: 'OpenBMC', CN: 'bmc' },
        },
      }),
    });

    const merged = applyAuthenticatedProbe(anonymous, authenticated, ['SESSION']);
    expect(merged.paths.apiSession).toBe(false);
    expect(merged.paths.apiRandomtag).toBe(false);
    expect(merged.paths.apiKvmToken).toBe(false);
    expect(merged.paths.randomtag).toBe(true);
    expect(merged.paths.kvmService).toBe(true);
    expect(merged.familySignatures.primary).not.toBe('ami-megarac');
  });
});
