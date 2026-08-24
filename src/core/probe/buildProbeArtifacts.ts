import type { ProbeBmcTargetResult } from './probeBmcTarget';

export interface ProbeArtifact {
  path: string;
  content: string;
}

function stringify(data: unknown) {
  return JSON.stringify(data, null, 2);
}

export function buildProbeArtifacts(result: ProbeBmcTargetResult): ProbeArtifact[] {
  return [
    {
      path: 'probe/bmc-basic.json',
      content: stringify(result.basic),
    },
    {
      path: 'probe/path-evidence.json',
      content: stringify(result.paths),
    },
    {
      path: 'probe/family-signatures.json',
      content: stringify(result.familySignatures),
    },
    {
      path: 'probe/redfish.json',
      content: stringify(
        result.redfish || {
          path: '/redfish/v1',
          status: 0,
          reachable: false,
          vendor: '',
          product: '',
          firmwareVersion: '',
          rootFields: {},
        },
      ),
    },
    {
      path: 'tls/certificate.json',
      content: stringify(result.tls),
    },
  ];
}
