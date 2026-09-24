import { describe, expect, it } from 'vitest';

import { STAGE_BAR_STEPS, derivePageStage, stageBarOf, stageStatusText } from './stage';

/**
 * 规范 §5.3：主窗口只表现 8 个阶段；阶段条四步三态。
 * 反例先行：收尾优先于工作流状态；未派生 COMPLETE 一律按 incomplete。
 */

const job = (overrides: Partial<NonNullable<Parameters<typeof derivePageStage>[0]['job']>>) => ({
  state: 'capturing' as const,
  workflowStatus: 'TARGET_OPENED' as const,
  finalizing: false,
  captureIntegrity: null,
  ...overrides,
});

describe('derivePageStage（页面阶段派生）', () => {
  it('无作业 → idle；启动中 → launching', () => {
    expect(derivePageStage({ job: null, launching: false })).toBe('idle');
    expect(derivePageStage({ job: null, launching: true })).toBe('launching');
  });

  it('采集中按派生工作流状态推进：TARGET_OPENED → 登录提示；LOGIN_REACHED → KVM 提示', () => {
    expect(derivePageStage({ job: job({ workflowStatus: 'TARGET_OPENED' }), launching: false })).toBe('capturing-login');
    expect(derivePageStage({ job: job({ workflowStatus: 'LOGIN_REACHED' }), launching: false })).toBe('capturing-viewer');
  });

  it('KVM_REACHED 采集中 → finalizing（自动收尾等待稳定窗口）', () => {
    expect(derivePageStage({ job: job({ workflowStatus: 'KVM_REACHED' }), launching: false })).toBe('finalizing');
  });

  it('finalizing 标志优先于工作流状态（手动/自动 stop 序列进行中）', () => {
    expect(derivePageStage({ job: job({ workflowStatus: 'TARGET_OPENED', finalizing: true }), launching: false })).toBe('finalizing');
  });

  it('反例：stop 序列进行中（workspace finalizing）载荷必须仍是 capturing + finalizing，不得提前报 stopped', () => {
    // 载荷契约：完整度只在 finalized 落盘后派生，finalizing 窗口内
    // captureIntegrity 为 null——若此时 state 已是 stopped，会在判定
    // 存在前显示「采集不完整」与「导出未完整包」。
    expect(derivePageStage({ job: job({ finalizing: true, captureIntegrity: null }), launching: false })).toBe('finalizing');
  });

  it('已收尾：派生 COMPLETE → complete；INCOMPLETE → incomplete', () => {
    expect(
      derivePageStage({ job: job({ state: 'stopped', captureIntegrity: 'COMPLETE' }), launching: false }),
    ).toBe('complete');
    expect(
      derivePageStage({ job: job({ state: 'stopped', captureIntegrity: 'INCOMPLETE' }), launching: false }),
    ).toBe('incomplete');
  });

  it('反例：已收尾但没有派生出 COMPLETE（null）→ incomplete（不主张未验证的完整）', () => {
    expect(derivePageStage({ job: job({ state: 'stopped', captureIntegrity: null }), launching: false })).toBe('incomplete');
  });

  it('已导出 → exported（导出后的完整度以导出结果为准，由导出区单独展示）', () => {
    expect(derivePageStage({ job: job({ state: 'exported', captureIntegrity: 'INCOMPLETE' }), launching: false })).toBe('exported');
  });
});

describe('stageBarOf（阶段条三态）', () => {
  it('idle 全 pending；launching 连接目标 active', () => {
    expect(stageBarOf('idle')).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(stageBarOf('launching')).toEqual(['active', 'pending', 'pending', 'pending']);
  });

  it('采集登录期：连接完成、登录 active；Viewer 期：登录完成、Viewer active', () => {
    expect(stageBarOf('capturing-login')).toEqual(['done', 'active', 'pending', 'pending']);
    expect(stageBarOf('capturing-viewer')).toEqual(['done', 'done', 'active', 'pending']);
  });

  it('finalizing：完整性校验 active；终态四步全 done', () => {
    expect(stageBarOf('finalizing')).toEqual(['done', 'done', 'done', 'active']);
    expect(stageBarOf('complete')).toEqual(['done', 'done', 'done', 'done']);
    expect(stageBarOf('incomplete')).toEqual(['done', 'done', 'done', 'done']);
    expect(stageBarOf('exported')).toEqual(['done', 'done', 'done', 'done']);
  });

  it('每个阶段都有非空状态文案且不出现 0.2.x 交互词（暂停/复验/截图）', () => {
    for (const stage of ['idle', 'launching', 'capturing-login', 'capturing-viewer', 'finalizing', 'complete', 'incomplete', 'exported'] as const) {
      const text = stageStatusText(stage);
      expect(text.length).toBeGreaterThan(0);
      for (const banned of ['暂停', '复验', '截图', '对比']) {
        expect(text).not.toContain(banned);
      }
    }
  });

  it('阶段条步骤与规范 §5.2 一致（四步）', () => {
    expect([...STAGE_BAR_STEPS]).toEqual(['连接目标', '登录活动', 'Viewer 活动', '完整性校验']);
  });
});
