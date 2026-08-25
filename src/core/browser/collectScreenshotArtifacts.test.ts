import { describe, expect, it } from 'vitest';

import { collectScreenshotArtifacts } from './collectScreenshotArtifacts';

describe('collectScreenshotArtifacts', () => {
  it('copies screenshot bytes into pack-relative paths and strips local disk paths', async () => {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const artifacts = await collectScreenshotArtifacts({
      page: {
        jobId: 'job-001',
        events: [
          {
            type: 'screenshot',
            path: '/Users/ops/captures/job-001/screenshots/viewer-1.png',
            role: 'viewer',
            timestamp: '2026-08-24T12:00:04.000+08:00',
          },
        ],
      },
      async readFile(path) {
        expect(path).toBe('/Users/ops/captures/job-001/screenshots/viewer-1.png');
        return png;
      },
    });

    expect(artifacts).toEqual([
      {
        path: 'page/screenshots/viewer-1.png',
        content: png,
      },
    ]);
  });

  it('keeps existing pack-relative screenshot paths when the local file can be read', async () => {
    const png = Uint8Array.from([1, 2, 3]);
    const artifacts = await collectScreenshotArtifacts({
      page: {
        jobId: 'job-001',
        events: [
          {
            type: 'screenshot',
            path: 'page/screenshots/live.png',
            role: 'unknown',
            sourcePath: '/tmp/kvm-recon/live.png',
            timestamp: '2026-08-24T12:00:04.000+08:00',
          },
        ],
      },
      async readFile(path) {
        expect(path).toBe('/tmp/kvm-recon/live.png');
        return png;
      },
    });

    expect(artifacts).toEqual([
      {
        path: 'page/screenshots/live.png',
        content: png,
      },
    ]);
  });
});
