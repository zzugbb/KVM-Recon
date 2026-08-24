import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createSampleCapturePack } from './createSampleCapturePack';

describe('sample capture pack', () => {
  it('includes probe, http, ws, page, and tls artifacts for offline review', () => {
    const root = join(process.cwd(), 'examples/sample-capture-pack');
    const required = [
      'manifest.json',
      'checklist.json',
      'report.md',
      'report.html',
      'probe/bmc-basic.json',
      'probe/path-evidence.json',
      'probe/family-signatures.json',
      'probe/redfish.json',
      'probe/operator-observed.json',
      'tls/certificate.json',
      'http/requests.jsonl',
      'http/har.json',
      'ws/sockets.json',
      'ws/frames.jsonl',
      'page/timeline.jsonl',
      'page/storage.json',
      'page/selectors.json',
      'page/screenshots.json',
      'artifacts/oem-profile.yaml',
      'artifacts/handover.md',
    ];

    expect(required.filter(path => existsSync(join(root, path)))).toEqual(required);
  });

  it('builds a PARTIAL sample pack with KVM WebSocket facts but no screenshot', () => {
    const sample = createSampleCapturePack();
    expect(sample.fileName).toContain('_PARTIAL.zip');
    expect(sample.pack.artifacts?.map(item => item.path)).toEqual(
      expect.arrayContaining([
        'probe/bmc-basic.json',
        'http/requests.jsonl',
        'ws/frames.jsonl',
        'page/timeline.jsonl',
        'tls/certificate.json',
        'probe/operator-observed.json',
      ]),
    );
  });
});
