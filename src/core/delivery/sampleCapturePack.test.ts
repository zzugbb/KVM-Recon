import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createSampleCapturePack,
  diskContentFromArtifact,
} from './createSampleCapturePack';

function walkFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap(name => {
    if (name.startsWith('.')) return [];
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const fullPath = join(dir, name);
    return statSync(fullPath).isDirectory() ? walkFiles(fullPath, relativePath) : [relativePath];
  });
}

function sameSampleContent(disk: Buffer, expected: string | Buffer) {
  const want = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
  if (disk.equals(want)) return true;
  return disk.toString('utf8').replace(/\n+$/, '') === want.toString('utf8').replace(/\n+$/, '');
}

describe('sample capture pack', () => {
  it('includes probe, http, ws, page, and tls artifacts for offline review', () => {
    const root = join(process.cwd(), 'examples/sample-capture-pack');
    const assembled = createSampleCapturePack();
    const expectedFiles = [
      { path: 'manifest.json', content: JSON.stringify(assembled.pack.manifest, null, 2) },
      { path: 'checklist.json', content: JSON.stringify(assembled.pack.checklist, null, 2) },
      { path: 'report.md', content: assembled.pack.reportMarkdown },
      { path: 'report.html', content: assembled.pack.reportHtml || '' },
      ...(assembled.pack.artifacts ?? []).map(artifact => ({
        path: artifact.path,
        content: diskContentFromArtifact(artifact.content),
      })),
    ];

    expect(walkFiles(root).sort()).toEqual(expectedFiles.map(file => file.path).sort());
    for (const file of expectedFiles) {
      expect(
        sameSampleContent(readFileSync(join(root, file.path)), file.content),
        `${file.path} must match createSampleCapturePack()`,
      ).toBe(true);
    }
    const diskReadme = readFileSync(join(root, 'README.md'), 'utf8');
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
