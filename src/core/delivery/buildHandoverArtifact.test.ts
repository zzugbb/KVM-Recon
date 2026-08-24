import { describe, expect, it } from 'vitest';

import { buildHandoverArtifact } from './buildHandoverArtifact';

describe('buildHandoverArtifact', () => {
  it('tells operators to analyze the pack after leaving the machine room', () => {
    const artifact = buildHandoverArtifact({
      kvmFamily: 'ami-megarac',
      readiness: 'PARTIAL',
      operatorNote: '机房 A 柜',
      operatorObserved: {
        vendor: 'AMI',
        product: 'MegaRAC SPX',
        firmware: '1.0.0',
        location: 'A柜 U12',
        note: '机房 A 柜',
      },
      httpRequestCount: 4,
      webSocketCount: 1,
      screenshotCount: 2,
      hasOemProfile: true,
    });

    expect(artifact.path).toBe('artifacts/handover.md');
    expect(artifact.content).toContain('kvmFamily：ami-megarac');
    expect(artifact.content).toContain('离场结论：PARTIAL');
    expect(artifact.content).toContain('机房 A 柜');
    expect(artifact.content).toContain('现场厂商：AMI');
    expect(artifact.content).toContain('现场型号：MegaRAC SPX');
    expect(artifact.content).toContain('不能替代 kvmFamily');
    expect(artifact.content).toContain('oem-profile.yaml');
    expect(artifact.content).not.toContain('自动写 Adapter');
  });

  it('does not imply an adapter will be generated for unknown families', () => {
    const artifact = buildHandoverArtifact({
      kvmFamily: 'unknown-h5',
      readiness: 'NO',
      httpRequestCount: 0,
      webSocketCount: 0,
      screenshotCount: 0,
      hasOemProfile: false,
    });

    expect(artifact.content).toContain('不要期望本工具写出 Adapter');
    expect(artifact.content).toContain('作业备注：（无）');
    expect(artifact.content).toContain('现场厂商：（无）');
  });
});
