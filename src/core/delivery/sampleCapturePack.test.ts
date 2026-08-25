import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createSampleCapturePack,
  diskContentFromArtifact,
} from './createSampleCapturePack';

describe('sample capture pack', () => {
  it('includes probe, http, ws, page, and tls artifacts for offline review', () => {
    const root = join(process.cwd(), 'examples/sample-capture-pack');
    const assembled = createSampleCapturePack();
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
      'README.md',
    ];

    expect(required.filter(path => existsSync(join(root, path)))).toEqual(required);
    const diskReadme = readFileSync(join(root, 'README.md'), 'utf8');
    const packReadme = assembled.pack.artifacts?.find(item => item.path === 'README.md');
    expect(String(packReadme?.content)).toBe(diskReadme);
    expect(diskReadme).toContain('文件做什么');
    expect(diskReadme).toContain('必须问人或看网关仓库');
    expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).job.operatorNote).toContain(
      '样例包',
    );
    expect(readFileSync(join(root, 'report.md'), 'utf8')).toContain('阅读说明');
    expect(readFileSync(join(root, 'report.md'), 'utf8')).not.toContain('离场后怎么用');
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
        'README.md',
      ]),
    );
  });

  it('keeps screenshot bytes intact when writing artifacts to disk', () => {
    const png = Uint8Array.from([137, 80, 78, 71, 255, 0, 26, 10]);
    const written = diskContentFromArtifact(png);
    expect(Buffer.from(written).equals(Buffer.from(png))).toBe(true);
    expect(Buffer.from(Buffer.from(png).toString('utf8'), 'utf8').equals(Buffer.from(png))).toBe(false);
  });
});
