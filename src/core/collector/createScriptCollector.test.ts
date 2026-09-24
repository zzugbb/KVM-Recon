import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PackV2ScriptsIndex } from '../capture-pack-v2/types';
import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import { createCollectorEvidence } from './collectorEvidence';
import { createScriptCollector } from './createScriptCollector';

describe('ScriptCollector 大源码', () => {
  it('多兆字节脚本完整落盘并由索引引用', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kvm-recon-script-test-'));
    const workspace = await startJobWorkspace({
      jobId: 'large-script', rootDir, deviceLabel: 'test', safetyMarginBytes: 1,
    });
    try {
      const evidence = createCollectorEvidence();
      const collector = createScriptCollector(workspace, evidence);
      const source = `function login(){return "${'x'.repeat(6 * 1024 * 1024)}";}`;
      await collector.addParsed({
        scriptId: 'script-1',
        targetId: 'target-1',
        url: 'https://bmc.test/source.min.js',
        source,
        lengthBytes: source.length,
        contentHash: 'large-source-hash',
      });
      await collector.flush();

      const index = JSON.parse((await workspace.readArtifact('raw/scripts/index.json')).toString('utf8')) as PackV2ScriptsIndex;
      expect(index.scripts).toHaveLength(1);
      expect(index.scripts[0].bodyRef?.bytes).toBe(Buffer.byteLength(source));
      expect((await workspace.readArtifact(index.scripts[0].bodyRef!.path)).toString('utf8')).toBe(source);
      expect(evidence.diagnostics().gapCounts.missingWorkerSources ?? 0).toBe(0);
    } finally {
      await workspace.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
