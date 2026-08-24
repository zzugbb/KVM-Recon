import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { buildCapturePackZip } from './buildCapturePackZip';
import { createEmptyCapturePack } from './createEmptyCapturePack';

describe('buildCapturePackZip', () => {
  it('serializes the minimum capture pack files into a zip archive', async () => {
    const pack = createEmptyCapturePack({
      jobId: 'job-zip-001',
      startedAt: '2026-08-24T10:00:00.000+08:00',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
    });

    const zipBuffer = await buildCapturePackZip(pack);
    const zip = await JSZip.loadAsync(zipBuffer);

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const checklist = JSON.parse(await zip.file('checklist.json')!.async('string'));
    const report = await zip.file('report.md')!.async('string');

    expect(manifest.job.id).toBe('job-zip-001');
    expect(checklist.readiness).toBe('NO');
    expect(report).toContain('离场适配就绪：NO');
    expect(Object.keys(zip.files).sort()).toEqual([
      'checklist.json',
      'manifest.json',
      'report.md',
    ]);
  });

  it('serializes extra capture artifacts into their pack paths', async () => {
    const pack = createEmptyCapturePack({
      jobId: 'job-zip-002',
      startedAt: '2026-08-24T10:00:00.000+08:00',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
    });

    const zipBuffer = await buildCapturePackZip({
      ...pack,
      artifacts: [
        {
          path: 'http/requests.jsonl',
          content: '{"id":"req-1"}',
        },
        {
          path: 'ws/frames.jsonl',
          content: '{"socketId":"ws-1","headHex":"17000001"}',
        },
        {
          path: 'artifacts/oem-profile.yaml',
          content: 'kvmFamily: ami-megarac\nreviewRequired: true\n',
        },
      ],
    });
    const zip = await JSZip.loadAsync(zipBuffer);

    expect(await zip.file('http/requests.jsonl')!.async('string')).toBe('{"id":"req-1"}');
    expect(await zip.file('ws/frames.jsonl')!.async('string')).toContain('"headHex":"17000001"');
    expect(await zip.file('artifacts/oem-profile.yaml')!.async('string')).toContain(
      'kvmFamily: ami-megarac',
    );
  });
});
