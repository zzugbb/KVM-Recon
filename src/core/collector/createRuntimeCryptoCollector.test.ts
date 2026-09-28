import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { derivePackIntegrity } from '../capture-pack-v2/packStatus';
import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import { createCollectorEvidence } from './collectorEvidence';
import { createRuntimeCryptoCollector } from './createRuntimeCryptoCollector';

describe('RuntimeCryptoCollector 故障记账', () => {
  it('正文写入器打开失败时记录缺失的调用行并阻止 COMPLETE', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kvm-recon-crypto-open-failure-'));
    const workspace = await startJobWorkspace({
      jobId: 'crypto-open-failure', rootDir, deviceLabel: 'test', safetyMarginBytes: 1,
    });
    try {
      const evidence = createCollectorEvidence();
      const collector = createRuntimeCryptoCollector(workspace, evidence);
      const lease = vi.spyOn(workspace, 'trackInFlightWrite').mockImplementationOnce(() => {
        throw new Error('injected single body writer failure');
      });
      await expect(collector.recordBindingPayload({
        op: 'digest',
        algorithm: 'SHA-256',
        inputB64: Buffer.from('secret').toString('base64'),
      }, 'target-1', '2026-09-28T00:00:00.000Z')).rejects.toThrow('injected single body writer failure');
      lease.mockRestore();

      const summary = evidence.summary({
        collectorReadyBeforeFirstNavigation: true,
        rawJournalsClosed: true,
        browserStateWritten: true,
        evidenceReferencesClosed: true,
        workflowStatus: 'KVM_REACHED',
      });
      expect(summary.journalWriteFailures).toHaveLength(1);
      expect(summary.journalWriteFailures[0].id).toBe('crypto-0001');
      expect(derivePackIntegrity(summary).reasons).toContain('INCOMPLETE_RAW_JOURNAL');
    } finally {
      await workspace.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
