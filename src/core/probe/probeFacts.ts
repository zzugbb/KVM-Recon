/**
 * Probe 结果 → Pack 2.0 raw/probe 事实（规范 §8.7：Probe 只是补充事实，
 * 命中不提升完整度，失败不阻止浏览器采集）。
 * 只记通用补充事实，绝不写协议族结论或 Cookie 值。
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
      kind: 'basic',
      vendor: result.basic.vendor,
      product: result.basic.product,
      firmwareVersion: result.basic.firmwareVersion,
    },
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
      path: result.redfish?.path ?? '',
      status: result.redfish?.status ?? 0,
      reachable: result.redfish?.reachable ?? false,
      contentType: result.redfish?.contentType ?? '',
      redirected: result.redfish?.redirected ?? false,
      redirectLocation: result.redfish?.redirectLocation ?? '',
      vendor: result.redfish?.vendor ?? '',
      product: result.redfish?.product ?? '',
      firmwareVersion: result.redfish?.firmwareVersion ?? '',
      rootFields: result.redfish?.rootFields ?? {},
      oemKeys: result.redfish?.oemKeys ?? [],
      body: result.redfish?.body ?? null,
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
