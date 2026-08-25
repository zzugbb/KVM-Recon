import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createSampleCapturePack, writeSampleCapturePack } from './createSampleCapturePack';

describe('sample capture pack', () => {
  it('includes probe, http, ws, page, and tls artifacts for offline review', async () => {
    const root = join(process.cwd(), 'examples/sample-capture-pack');
    await writeSampleCapturePack(root);
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
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('文件做什么');
    expect(readme).toContain('必须问人或看网关仓库');
    expect(readme).toContain('样例包，仅用于说明导出目录与 README 格式。');
    expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).tool.version).toBeTruthy();
    expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).job.operatorNote).toContain('样例包');
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
});
