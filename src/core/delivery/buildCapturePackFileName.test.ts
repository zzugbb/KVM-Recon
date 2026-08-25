import { describe, expect, it } from 'vitest';

import { buildCapturePackFileName } from './buildCapturePackFileName';

describe('buildCapturePackFileName', () => {
  it('builds a deterministic offline export file name', () => {
    expect(
      buildCapturePackFileName({
        startedAt: '2026-08-24T13:55:00.000+08:00',
        targetHost: '10.0.0.10',
        kvmFamily: 'ami-megarac',
        readiness: 'PARTIAL',
      }),
    ).toBe('KVM-Recon_20260824-135500_10-0-0-10_ami-megarac_PARTIAL.zip');
  });

  it('sanitizes host and family values before writing a file name', () => {
    expect(
      buildCapturePackFileName({
        startedAt: '2026-08-24T13:55:00.000+08:00',
        targetHost: 'bmc.demo.local/../../secret',
        kvmFamily: 'unknown h5',
        readiness: 'NO',
      }),
    ).toBe('KVM-Recon_20260824-135500_bmc-demo-local-secret_unknown-h5_NO.zip');
  });
});
