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
      'page-timeline-event.schema.json',
      'page-storage.schema.json',
      'page-selectors.schema.json',
      'page-screenshots.schema.json',
      'tls-certificate.schema.json',
      'probe-bmc-basic.schema.json',
      'probe-path-evidence.schema.json',
      'probe-family-signatures.schema.json',
      'probe-redfish.schema.json',
      'probe-authenticated.schema.json',
    ];
    for (const name of names) {
      const schema = JSON.parse(readFileSync(join(root, name), 'utf8')) as { $id?: string };
      expect(schema.$id).toContain(name);
    }
  });

  it('sample pack JSON files expose the required fields declared by schema', () => {
    const sampleRoot = join(process.cwd(), 'examples/sample-capture-pack');
    const objects: Array<[string, string[]]> = [
      ['tls/certificate.json', ['reachable', 'authorized', 'authorizationError', 'protocol', 'cipher', 'certificate']],
      ['page/storage.json', ['localStorageKeys', 'sessionStorageKeys']],
      ['probe/bmc-basic.json', ['host', 'port', 'scheme', 'vendor', 'product', 'firmwareVersion']],
      ['probe/redfish.json', ['path', 'status', 'reachable', 'vendor', 'product', 'firmwareVersion', 'rootFields']],
      ['probe/family-signatures.json', ['primary', 'confidence', 'candidates']],
    ];
    for (const [relativePath, required] of objects) {
      const data = JSON.parse(readFileSync(join(sampleRoot, relativePath), 'utf8')) as Record<string, unknown>;
      for (const key of required) {
        expect(data).toHaveProperty(key);
      }
    }
    expect(JSON.parse(readFileSync(join(sampleRoot, 'page/selectors.json'), 'utf8'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'kvm-entry', selector: '#kvm' })]),
    );
    expect(JSON.parse(readFileSync(join(sampleRoot, 'page/screenshots.json'), 'utf8'))).toEqual([]);
    const timelineEvent = JSON.parse(
      readFileSync(join(sampleRoot, 'page/timeline.jsonl'), 'utf8').trim().split('\n')[0],
    ) as { type: string; timestamp: string };
    expect(timelineEvent.type).toBe('selector-candidates');
    expect(timelineEvent.timestamp).toBeTruthy();
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
