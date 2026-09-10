import { describe, expect, it } from 'vitest';

import { buildProbeArtifacts } from './buildProbeArtifacts';
import type { ProbeBmcTargetResult } from './probeBmcTarget';

describe('buildProbeArtifacts', () => {
  it('serializes basic, path, family, and TLS probe results for Capture Pack', () => {
    const result: ProbeBmcTargetResult = {
      basic: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
        vendor: 'OpenBMC',
        product: 'BMC',
        firmwareVersion: '1.0.0',
      },
      paths: {
        randomtag: true,
        kvmVideo: true,
      },
      familySignatures: {
        primary: 'openbmc-h5',
        confidence: 0.82,
        candidates: [
          {
            kvmFamily: 'openbmc-h5',
            confidence: 0.82,
            evidence: ['/randomtag', '/kvm/video'],
          },
        ],
      },
      redfish: {
        path: '/redfish/v1',
        status: 200,
        reachable: true,
        vendor: 'OpenBMC',
        product: 'BMC',
        firmwareVersion: '1.0.0',
        rootFields: {
          Vendor: 'OpenBMC',
          Product: 'BMC',
          FirmwareVersion: '1.0.0',
        },
      },
      tls: {
        reachable: true,
        authorized: false,
        authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        protocol: 'TLSv1.2',
        cipher: {
          name: 'AES256-GCM-SHA384',
          version: 'TLSv1.2',
        },
        certificate: null,
      },
    };

    const artifacts = buildProbeArtifacts(result);

    expect(artifacts.map(artifact => artifact.path).sort()).toEqual([
      'probe/bmc-basic.json',
      'probe/family-signatures.json',
      'probe/path-details.json',
      'probe/path-evidence.json',
      'probe/redfish.json',
      'tls/certificate.json',
    ]);
    expect(JSON.parse(artifacts.find(artifact => artifact.path === 'probe/redfish.json')!.content)).toEqual(
      result.redfish,
    );
    expect(JSON.parse(artifacts[0].content)).toEqual(result.basic);
    expect(
      JSON.parse(
        artifacts.find(artifact => artifact.path === 'probe/family-signatures.json')!.content,
      ).primary,
    ).toBe('openbmc-h5');
  });
});
