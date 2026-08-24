import { describe, expect, it } from 'vitest';

import { createEmptyCapturePack } from './createEmptyCapturePack';

describe('createEmptyCapturePack', () => {
  it('creates an empty capture pack that is not ready to leave the site', () => {
    const startedAt = '2026-08-24T10:00:00.000+08:00';

    const pack = createEmptyCapturePack({
      jobId: 'job-001',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      startedAt,
    });

    expect(pack.manifest.schemaVersion).toBe('1.0.0');
    expect(pack.manifest.job.id).toBe('job-001');
    expect(pack.manifest.target.host).toBe('10.0.0.10');
    expect(pack.manifest.family.primary).toBe('unknown-h5');
    expect(pack.manifest.readiness.status).toBe('NO');
    expect(pack.manifest.redaction.status).toBe('pass');
    expect(pack.checklist.items).toEqual([
      expect.objectContaining({
        id: 'capture.empty',
        status: 'missing',
        severity: 'blocking',
      }),
    ]);
    expect(pack.files).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'checklist.json',
        'report.md',
      ]),
    );
  });
});
