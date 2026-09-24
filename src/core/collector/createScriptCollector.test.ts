import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PackV2ScriptsIndex } from '../capture-pack-v2/types';
import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import { createCollectorEvidence } from './collectorEvidence';
import { createScriptCollector } from './createScriptCollector';

describe('ScriptCollector 大源码', () => {
  it('单脚本超过 2 MiB、总源码超过 8 MiB 且超过 24 个脚本均完整落盘', async () => {
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
      const secondSource = `function viewer(){return "${'y'.repeat(3 * 1024 * 1024)}";}`;
      await collector.addParsed({
        scriptId: 'script-2',
        targetId: 'target-1',
        url: 'https://bmc.test/viewer.min.js',
        source: secondSource,
        lengthBytes: secondSource.length,
        contentHash: 'viewer-source-hash',
      });
      for (let index = 3; index <= 26; index += 1) {
        const smallSource = `function script${index}(){return ${index};}`;
        await collector.addParsed({
          scriptId: `script-${index}`,
          targetId: 'target-1',
          url: `https://bmc.test/script-${index}.js`,
          source: smallSource,
          lengthBytes: smallSource.length,
          contentHash: `script-hash-${index}`,
        });
      }
      await collector.flush();

      const index = JSON.parse((await workspace.readArtifact('raw/scripts/index.json')).toString('utf8')) as PackV2ScriptsIndex;
      expect(index.scripts).toHaveLength(26);
      expect(index.scripts.reduce((total, script) => total + (script.bodyRef?.bytes ?? 0), 0)).toBeGreaterThan(8 * 1024 * 1024);
      expect(index.scripts[0].bodyRef?.bytes).toBe(Buffer.byteLength(source));
      expect((await workspace.readArtifact(index.scripts[0].bodyRef!.path)).toString('utf8')).toBe(source);
      expect((await workspace.readArtifact(index.scripts[1].bodyRef!.path)).toString('utf8')).toBe(secondSource);
      for (let scriptIndex = 2; scriptIndex < index.scripts.length; scriptIndex += 1) {
        const script = index.scripts[scriptIndex];
        expect((await workspace.readArtifact(script.bodyRef!.path)).length).toBe(script.bodyRef!.bytes);
      }
      expect(evidence.diagnostics().gapCounts.missingWorkerSources ?? 0).toBe(0);
    } finally {
      await workspace.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
