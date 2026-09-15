export const PRODUCTION_CAPTURE_E2E_PASSED = 'production capture controller e2e passed';

interface EvaluateProductionCaptureE2eExitInput {
  code: number | null;
  output: string;
  expectEarlyCloseFail?: boolean;
}

export function evaluateProductionCaptureE2eExit(input: EvaluateProductionCaptureE2eExitInput): {
  ok: boolean;
  message: string;
} {
  const passed = input.output.includes(PRODUCTION_CAPTURE_E2E_PASSED);
  if (input.expectEarlyCloseFail) {
    if (passed || input.code === 0) {
      return { ok: false, message: '预期断言前关窗应失败，但 E2E 以成功退出' };
    }
    return { ok: true, message: '' };
  }
  if (input.code !== 0 || !passed) {
    return {
      ok: false,
      message: passed
        ? `生产采集 E2E 退出码 ${input.code}`
        : '生产采集 E2E 退出但未出现成功标记',
    };
  }
  return { ok: true, message: '' };
}
