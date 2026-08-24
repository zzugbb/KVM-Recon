import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildCapturePackZip } from './buildCapturePackZip';
import { compareCapturePacks, summarizeCapturePackZip } from './summarizeCapturePack';
import { validateManifestShape } from './validateCapturePackShape';
import { createSampleCapturePack } from '../delivery/createSampleCapturePack';

describe('capture pack schema and local review', () => {
  it('ships standalone JSON Schema files for offline validation', () => {
    const root = join(process.cwd(), 'schema');
    const names = [
      'manifest.schema.json',
      'checklist.schema.json',
      'http-request.schema.json',
      'ws-socket.schema.json',
      'ws-frame.schema.json',
      'operator-observed.schema.json',
    ];
    for (const name of names) {
      const schema = JSON.parse(readFileSync(join(root, name), 'utf8')) as { $id?: string };
      expect(schema.$id).toContain(name);
    }
  });

  it('summarizes a sample zip and compares family differences', async () => {
    const assembled = createSampleCapturePack();
    const zip = await buildCapturePackZip(assembled.pack);
    const left = await summarizeCapturePackZip(zip);

    expect(left.family).toBe('ami-megarac');
    expect(left.host).toBe('10.0.0.10');
    expect(left.httpRequestCount).toBe(2);
    expect(left.webSocketCount).toBe(1);
    expect(left.webSocketUrls).toEqual(['wss://10.0.0.10/kvm']);
    expect(left.observedVendor).toBe('AMI');
    expect(left.observedProduct).toBe('MegaRAC SPX');
    expect(left.schemaErrors).toEqual([]);

    const right = {
      ...left,
      family: 'openbmc-h5',
      readiness: 'YES',
      screenshotRoles: ['viewer'],
    };
    const comparison = compareCapturePacks(left, right);
    expect(comparison.diffs.find(item => item.field === 'family')).toMatchObject({
      left: 'ami-megarac',
      right: 'openbmc-h5',
      changed: true,
    });
    expect(comparison.diffs.find(item => item.field === 'webSocketCount')?.changed).toBe(false);
  });

  it('reports missing manifest fields without throwing', () => {
    expect(validateManifestShape({})).toEqual(
      expect.arrayContaining([
        'manifest.schemaVersion 必须是 1.0.0',
        '缺少字段 manifest.tool.name',
        '缺少字段 manifest.job.id',
      ]),
    );
  });
});
