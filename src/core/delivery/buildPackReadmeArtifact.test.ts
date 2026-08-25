import { describe, expect, it } from 'vitest';

import { buildPackReadmeArtifact } from './buildPackReadmeArtifact';

describe('buildPackReadmeArtifact', () => {
  it('writes a Chinese pack README that maps files and lists decisions', () => {
    const artifact = buildPackReadmeArtifact({
      kvmFamily: 'ami-megarac',
      familyConfidence: 0.9,
      readiness: 'PARTIAL',
      blockingTitles: [],
      warningTitles: ['KVM 画面截图'],
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
      webSocketUrls: ['wss://10.0.0.10/kvm'],
      screenshotCount: 2,
      hasOemProfile: true,
      hasAuthenticated: true,
      cookieNames: ['QSESSIONID'],
    });

    expect(artifact.path).toBe('README.md');
    expect(artifact.content).toContain('kvmFamily：ami-megarac');
    expect(artifact.content).toContain('离场结论：PARTIAL');
    expect(artifact.content).toContain('机房 A 柜');
    expect(artifact.content).toContain('现场厂商：AMI');
    expect(artifact.content).toContain('现场型号：MegaRAC SPX');
    expect(artifact.content).toContain('不能替代工具判定的采集桶');
    expect(artifact.content).toContain('oem-profile.yaml');
    expect(artifact.content).toContain('文件做什么');
    expect(artifact.content).toContain('必须问人或看网关仓库');
    expect(artifact.content).toContain('KVM 画面截图：2');
    expect(artifact.content).toContain('有没有 viewer 截图：有 2 张');
    expect(artifact.content).toContain('核对真实族再动手');
    expect(artifact.content).toContain('同构');
    expect(artifact.content).not.toContain('自动写 Adapter');
    expect(artifact.content).not.toContain('artifacts/handover.md');
  });

  it('does not imply an adapter will be generated for unknown families', () => {
    const artifact = buildPackReadmeArtifact({
      kvmFamily: 'unknown-h5',
      familyConfidence: 0,
      readiness: 'NO',
      blockingTitles: ['BMC 基础连接'],
      warningTitles: [],
      httpRequestCount: 0,
      webSocketCount: 0,
      webSocketUrls: [],
      screenshotCount: 0,
      hasOemProfile: false,
      hasAuthenticated: false,
      cookieNames: [],
    });

    expect(artifact.content).toContain('不要指望采集工具写出 Adapter');
    expect(artifact.content).toContain('本包工具判定为 `unknown-h5`');
    expect(artifact.content).toContain('不要把 `unknown-h5` / `not-h5` 写进网关 registry');
    expect(artifact.content).toContain('dell-idrac-h5');
    expect(artifact.content).toContain('作业备注：（无）');
    expect(artifact.content).toContain('现场厂商：（无）');
    expect(artifact.content).toContain('不要用残缺包硬写网关');
  });
});
