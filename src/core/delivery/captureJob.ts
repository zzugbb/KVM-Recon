import type { CaptureReadiness } from '../capture-pack/types';

export const MAX_CAPTURE_JOBS = 8;

export interface CaptureJobSummary {
  jobId: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  family: string;
  startedAt: string;
  vendor: string;
  product: string;
  windowsOpen: boolean;
  paused: boolean;
  exported: boolean;
  exportedAt?: string;
  readiness: CaptureReadiness;
}

export function canAddCaptureJob(currentCount: number, max = MAX_CAPTURE_JOBS) {
  if (currentCount >= max) {
    return {
      ok: false as const,
      message: `最多同时保留 ${max} 个采集作业，请先关闭已导出或不再需要的作业。`,
    };
  }
  return { ok: true as const };
}
