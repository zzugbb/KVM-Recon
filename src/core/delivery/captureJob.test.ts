import { describe, expect, it } from 'vitest';

import { MAX_CAPTURE_JOBS, canAddCaptureJob } from './captureJob';

describe('canAddCaptureJob', () => {
  it('allows a new job until the in-memory cap is reached', () => {
    expect(canAddCaptureJob(0).ok).toBe(true);
    expect(canAddCaptureJob(MAX_CAPTURE_JOBS - 1).ok).toBe(true);
    expect(canAddCaptureJob(MAX_CAPTURE_JOBS)).toEqual({
      ok: false,
      message: `最多同时保留 ${MAX_CAPTURE_JOBS} 个采集作业，请先关闭已导出或不再需要的作业。`,
    });
  });
});
