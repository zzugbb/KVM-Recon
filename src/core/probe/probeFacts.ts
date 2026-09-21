/**
 * Probe 结果 → Pack 2.0 raw/probe 事实（规范 §8.7：Probe 只是补充事实，
 * 命中不提升完整度，失败不阻止浏览器采集）。
 * 事实只记名称与结论，绝不携带 Cookie 值（authenticated 只记 cookieNames）。
 */

import type { PackV2ProbeFile } from '../capture-pack-v2/types';
import { PACK_V2_SCHEMA_VERSION } from '../capture-pack-v2/types';
import type { ProbeBmcTargetResult } from './probeBmcTarget';

export function buildProbeFactsFile(result: ProbeBmcTargetResult | null): PackV2ProbeFile {
  if (!result) {
    return { schemaVersion: PACK_V2_SCHEMA_VERSION, probeRan: false, facts: [] };
  }
  const facts: Array<Record<string, unknown>> = [
    {
      kind: 'tls',
      reachable: result.tls.reachable,
      authorized: result.tls.authorized,
      protocol: result.tls.protocol,
      cipher: result.tls.cipher,
      certificate: result.tls.certificate,
    },
    {
      kind: 'redfish',
      reachable: result.redfish?.reachable ?? false,
      vendor: result.redfish?.vendor ?? '',
      product: result.redfish?.product ?? '',
      firmwareVersion: result.redfish?.firmwareVersion ?? '',
      oemKeys: result.redfish?.oemKeys ?? [],
    },
    { kind: 'paths', paths: result.paths },
    {
      kind: 'family',
      primary: result.familySignatures.primary,
      confidence: result.familySignatures.confidence,
      candidates: result.familySignatures.candidates,
    },
  ];
  if (result.authenticated) {
    facts.push({
      kind: 'authenticated',
      attempted: result.authenticated.attempted,
      cookieNames: result.authenticated.cookieNames,
    });
  }
  return { schemaVersion: PACK_V2_SCHEMA_VERSION, probeRan: true, facts };
}
