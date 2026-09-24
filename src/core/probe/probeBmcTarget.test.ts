import { describe, expect, it } from 'vitest';

import { applyAuthenticatedProbe, probeBmcTarget } from './probeBmcTarget';

const target = { host: 'bmc.example', port: 443, scheme: 'https' } as const;
const tlsConnector = async () => ({
  authorized: true,
  protocol: 'TLSv1.3',
  cipher: null,
  certificate: null,
});

describe('probeBmcTarget', () => {
  it('并发读取标准 Redfish 与 TLS，不发厂商定向请求', async () => {
    const calls: string[] = [];
    const result = await probeBmcTarget({
      target,
      httpClient: {
        async get(path) {
          calls.push(path);
          return { status: 200, data: { Vendor: 'Vendor X' } };
        },
      },
      tlsConnector: async () => {
        calls.push('tls');
        return tlsConnector();
      },
    });
    expect(calls).toContain('tls');
    expect(calls).toContain('/redfish/v1/');
    expect(calls).not.toContain('/randomtag');
    expect(calls).not.toContain('/api/randomtag');
    expect(result.basic.vendor).toBe('Vendor X');
    expect(result.tls.reachable).toBe(true);
  });

  it('合并匿名与带会话的 Redfish 事实，只记录 Cookie 名称', async () => {
    const anonymous = await probeBmcTarget({
      target,
      httpClient: { async get() { return { status: 401 }; } },
      tlsConnector,
    });
    const authenticated = await probeBmcTarget({
      target,
      httpClient: {
        async get() {
          return { status: 200, data: { Vendor: 'Vendor X', Product: 'Model 42' } };
        },
      },
      tlsConnector,
    });
    const merged = applyAuthenticatedProbe(anonymous, authenticated, ['SESSION', 'SESSION']);
    expect(merged.basic.product).toBe('Model 42');
    expect(merged.redfish.reachable).toBe(true);
    expect(merged.authenticated).toEqual({ attempted: true, cookieNames: ['SESSION'] });
    expect(JSON.stringify(merged)).not.toContain('secret-cookie-value');
  });
});
