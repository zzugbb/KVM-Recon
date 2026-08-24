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
      path: 'tls/certificate.json',
      content: stringify(result.tls),
    },
  ];
}
