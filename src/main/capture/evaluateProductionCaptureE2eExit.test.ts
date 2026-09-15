import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_CAPTURE_E2E_PASSED,
  evaluateProductionCaptureE2eExit,
} from './evaluateProductionCaptureE2eExit';

describe('evaluateProductionCaptureE2eExit', () => {
  it('rejects a zero exit without the success marker as a false pass', () => {
    expect(
      evaluateProductionCaptureE2eExit({
        code: 0,
        output: 'capture-window-created\n',
      }),
    ).toEqual({
      ok: false,
      message: '生产采集 E2E 退出但未出现成功标记',
    });
  });

  it('accepts a zero exit only when the success marker is present', () => {
    expect(
      evaluateProductionCaptureE2eExit({
        code: 0,
        output: `${PRODUCTION_CAPTURE_E2E_PASSED} in 158ms\n`,
      }).ok,
    ).toBe(true);
  });

  it('requires an early window close to fail instead of exiting 0', () => {
    expect(
      evaluateProductionCaptureE2eExit({
        code: 0,
        output: 'capture-window-created\n',
        expectEarlyCloseFail: true,
      }).ok,
    ).toBe(false);
    expect(
      evaluateProductionCaptureE2eExit({
        code: 1,
        output: '断言前采集窗口已关闭\n',
        expectEarlyCloseFail: true,
      }).ok,
    ).toBe(true);
  });
});
