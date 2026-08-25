import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { buildCapturePackZip } from '../capture-pack/buildCapturePackZip';
import { createEmptyCapturePack } from '../capture-pack/createEmptyCapturePack';
import type { CaptureChecklist } from '../capture-pack/types';
import { applyReadinessToCapturePack } from './applyReadinessToCapturePack';

const partialChecklist: CaptureChecklist = {
  readiness: 'PARTIAL',
  items: [
    {
      id: 'ws.kvm.established',
      title: 'KVM WebSocket',
      status: 'pass',
      severity: 'blocking',
      evidence: ['ws-1'],
      userAction: '',
    },
    {
      id: 'page.viewer.screenshot',
      title: 'KVM 画面截图',
      status: 'missing',
      severity: 'warning',
      evidence: [],
      userAction: '请打开 HTML5 KVM 后等待画面区域稳定，再采集 viewer 页面截图。',
    },
  ],
};

describe('applyReadinessToCapturePack', () => {
  it('updates manifest readiness and generates markdown/html reports', async () => {
    const pack = createEmptyCapturePack({
      jobId: 'job-readiness-001',
      startedAt: '2026-08-24T12:00:00.000+08:00',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
    });

    const updated = applyReadinessToCapturePack(pack, partialChecklist);

    expect(updated.manifest.readiness).toEqual({
      status: 'PARTIAL',
      blockingCount: 0,
      warningCount: 1,
    });
    expect(updated.checklist).toBe(partialChecklist);
    expect(updated.reportMarkdown).toContain('离场适配就绪：PARTIAL');
    expect(updated.reportMarkdown).toContain('请打开 HTML5 KVM 后等待画面区域稳定');
    expect(updated.reportMarkdown).toContain('离场后怎么用');
    expect(updated.reportMarkdown).toContain('artifacts/handover.md');
    expect(updated.reportHtml).toContain('<!doctype html>');
    expect(updated.files).toContain('report.html');

    const zip = await JSZip.loadAsync(await buildCapturePackZip(updated));
    expect(await zip.file('report.html')!.async('string')).toContain('离场适配就绪：PARTIAL');
  });
});
