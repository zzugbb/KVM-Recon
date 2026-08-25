import { describe, expect, it } from 'vitest';

import type { ChecklistItem } from '../core/capture-pack/types';
import { jobRowStatus, nextStepText, phaseLabel } from './captureStatus';

const emptyItems: ChecklistItem[] = [];

describe('captureStatus', () => {
  it('keeps the idle phase as 新建采集', () => {
    expect(phaseLabel('idle', 'NO', false)).toBe('当前阶段：新建采集');
  });

  it('shows 可导出 instead of 采集中 when readiness is YES', () => {
    expect(phaseLabel('capturing', 'YES', false)).toBe('当前阶段：可导出');
    expect(
      jobRowStatus({
        exported: false,
        paused: false,
        windowsOpen: true,
        readiness: 'YES',
      }),
    ).toBe('可导出');
  });

  it('shows 已导出 after the pack is saved', () => {
    expect(phaseLabel('exported', 'YES', false)).toBe('当前阶段：已导出');
    expect(
      jobRowStatus({
        exported: true,
        paused: false,
        windowsOpen: false,
        readiness: 'YES',
      }),
    ).toBe('已导出');
  });

  it('asks the operator to log in, then open KVM, near the action buttons', () => {
    expect(
      nextStepText({
        phase: 'idle',
        readiness: 'NO',
        items: emptyItems,
        capturingScreenshot: false,
        paused: false,
        windowsOpen: false,
      }),
    ).toContain('新建采集作业');

    expect(
      nextStepText({
        phase: 'capturing',
        readiness: 'NO',
        items: [
          {
            id: 'login.chain',
            title: '登录链路 HTTP 资料',
            status: 'needs_user_action',
            severity: 'blocking',
            evidence: [],
            userAction: '请重新采集',
          },
        ],
        capturingScreenshot: false,
        paused: false,
        windowsOpen: true,
      }),
    ).toContain('登录 BMC');

    expect(
      nextStepText({
        phase: 'capturing',
        readiness: 'NO',
        items: [
          {
            id: 'ws.kvm.established',
            title: 'KVM WebSocket',
            status: 'needs_user_action',
            severity: 'blocking',
            evidence: [],
            userAction: '请打开 KVM',
          },
        ],
        capturingScreenshot: false,
        paused: false,
        windowsOpen: true,
      }),
    ).toContain('打开 HTML5 KVM');
  });
});
