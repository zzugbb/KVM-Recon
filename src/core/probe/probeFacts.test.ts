import { describe, expect, it } from 'vitest';

import { buildProbeFactsFile } from './probeFacts';
import type { ProbeBmcTargetResult } from './probeBmcTarget';

function fakeResult(): ProbeBmcTargetResult {
  return {
    basic: { host: '10.10.8.111', port: 8443, scheme: 'https', vendor: 'Supermicro', product: 'X12', firmwareVersion: '1.2.3' },
    paths: { apiSession: true, kvmVideo: true },
    pathDetails: {},
    familySignatures: { primary: 'unknown-h5', confidence: 2, candidates: [] },
    redfish: {
      path: '/redfish/v1',
      status: 200,
      reachable: true,
      vendor: 'Supermicro',
      product: 'X12',
      firmwareVersion: '1.2.3',
      rootFields: {},
    },
    tls: {
      reachable: true,
      authorized: true,
      authorizationError: '',
      protocol: 'TLS 1.3',
      cipher: { name: 'AES_256_GCM', version: 'TLSv1.3' },
      certificate: null,
    },
  };
}

describe('buildProbeFactsFile', () => {
  it('把匿名 probe 结果映射为事实（tls/redfish/paths/family）', () => {
    const file = buildProbeFactsFile(fakeResult());
    expect(file.schemaVersion).toBe('2.0.0');
    expect(file.probeRan).toBe(true);
    const kinds = file.facts.map(fact => fact.kind);
    expect(kinds).toEqual(['tls', 'redfish', 'paths', 'family']);
    expect(file.facts[2]).toEqual({ kind: 'paths', paths: { apiSession: true, kvmVideo: true } });
    expect(file.facts[3]).toEqual({
      kind: 'family',
      primary: 'unknown-h5',
      confidence: 2,
      candidates: [],
    });
    expect(JSON.stringify(file)).not.toContain('cookie');
  });

  it('认证 probe 只记 Cookie 名，不记值', () => {
    const file = buildProbeFactsFile({
      ...fakeResult(),
      authenticated: {
        attempted: true,
        cookieNames: ['SESSION', 'SMC_TOKEN'],
        paths: { apiKvmToken: true },
      },
    });
    const authenticated = file.facts.find(fact => fact.kind === 'authenticated');
    expect(authenticated).toEqual({
      kind: 'authenticated',
      attempted: true,
      cookieNames: ['SESSION', 'SMC_TOKEN'],
    });
    expect(JSON.stringify(file)).not.toContain('value');
  });

  it('probe 失败：probeRan=false、事实为空（失败不阻止浏览器采集）', () => {
    const file = buildProbeFactsFile(null);
    expect(file).toEqual({ schemaVersion: '2.0.0', probeRan: false, facts: [] });
  });
});
