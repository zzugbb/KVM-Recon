import { describe, expect, it } from 'vitest';

import { buildPackV2FileName } from './buildPackV2FileName';

describe('buildPackV2FileName（规范 §10）', () => {
  const base = {
    startedAt: '2026-09-18T14:35:22+08:00',
    targetHost: '10.10.8.111',
    workflowStatus: 'KVM_REACHED' as const,
    captureIntegrity: 'COMPLETE' as const,
    shortJobId: '7f3a2c',
  };

  it('生成规范示例形式的文件名，不含协议族与设备说明', () => {
    expect(buildPackV2FileName(base)).toBe(
      'KVM-Recon_20260918-143522_10-10-8-111_KVM-REACHED_COMPLETE_7f3a2c.zip',
    );
  });

  it('WORKFLOW 段使用 KVM-REACHED / LOGIN-REACHED / TARGET-OPENED', () => {
    expect(
      buildPackV2FileName({ ...base, workflowStatus: 'LOGIN_REACHED', captureIntegrity: 'INCOMPLETE' }),
    ).toBe('KVM-Recon_20260918-143522_10-10-8-111_LOGIN-REACHED_INCOMPLETE_7f3a2c.zip');
    expect(
      buildPackV2FileName({ ...base, workflowStatus: 'TARGET_OPENED', captureIntegrity: 'INCOMPLETE' }),
    ).toBe('KVM-Recon_20260918-143522_10-10-8-111_TARGET-OPENED_INCOMPLETE_7f3a2c.zip');
  });

  it('HOST 做文件名安全化（点号与非法字符转连字符）', () => {
    expect(buildPackV2FileName({ ...base, targetHost: 'bmc.lab.example.com' })).toContain(
      '_bmc-lab-example-com_',
    );
    expect(buildPackV2FileName({ ...base, targetHost: 'fd00::10' })).not.toMatch(/[:]/);
  });

  it('不包含协议族、厂商名、采集桶与设备说明', () => {
    for (const name of [
      buildPackV2FileName(base),
      buildPackV2FileName({ ...base, workflowStatus: 'LOGIN_REACHED', captureIntegrity: 'INCOMPLETE' }),
    ]) {
      expect(name).not.toMatch(
        /ami|megarac|openbmc|huawei|ibmc|idrac|ilo|hdm|dell|hpe|h3c|lenovo|nettrix|unknown-h5|not-h5/i,
      );
    }
  });

  it('LEGACY_UNVERIFIED 不能进入 2.0 导出文件名', () => {
    expect(() =>
      buildPackV2FileName({ ...base, captureIntegrity: 'LEGACY_UNVERIFIED' }),
    ).toThrow(/LEGACY_UNVERIFIED/);
  });

  it('空短作业 ID 抛错；非安全字符被剔除', () => {
    expect(() => buildPackV2FileName({ ...base, shortJobId: '   ' })).toThrow(/短作业 ID/);
    expect(buildPackV2FileName({ ...base, shortJobId: 'ab/cd-ef' })).toContain('_abcdef.zip');
  });

  it('非法时间直接拒绝，不静默生成占位段', () => {
    expect(() => buildPackV2FileName({ ...base, startedAt: '' })).toThrow(/无法从 startedAt 解析/);
    expect(() => buildPackV2FileName({ ...base, startedAt: 'yesterday' })).toThrow(
      /无法从 startedAt 解析/,
    );
  });
});
