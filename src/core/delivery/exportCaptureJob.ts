import { buildCapturePackZip } from '../capture-pack/buildCapturePackZip';
import type { CaptureReadiness, CaptureTarget } from '../capture-pack/types';
import type {
  HttpRequestRecord,
  WebSocketFrameRecord,
  WebSocketRecord,
} from '../network/createNetworkRecorder';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import { assembleCapturePackForExport } from './assembleCapturePackForExport';
import {
  classifyCaptureError,
  formatCaptureError,
  type FormattedCaptureError,
} from './formatCaptureError';

interface BrowserTimelineJson {
  jobId: string;
  events: Array<{
    type: string;
    [key: string]: unknown;
  }>;
}

interface NetworkSnapshot {
  httpRequests: HttpRequestRecord[];
  webSockets: WebSocketRecord[];
  webSocketFrames: WebSocketFrameRecord[];
}

export interface CaptureExportJob {
  jobId: string;
  startedAt: string;
  target: CaptureTarget;
  probe: ProbeBmcTargetResult;
  operatorNote?: string;
}

interface ExportCaptureJobInput {
  job: CaptureExportJob;
  collectPageFacts(label: string): Promise<void>;
  getPage(): BrowserTimelineJson;
  getNetwork(): NetworkSnapshot;
  chooseSavePath(fileName: string): Promise<string | null>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  now?: () => string;
}

export type ExportCaptureJobResult =
  | {
      ok: true;
      fileName: string;
      filePath: string;
      readiness: CaptureReadiness;
    }
  | {
      ok: false;
      canceled?: boolean;
      error: FormattedCaptureError;
    };

export async function exportCaptureJob(input: ExportCaptureJobInput): Promise<ExportCaptureJobResult> {
  try {
    await input.collectPageFacts('viewer');
    const assembled = assembleCapturePackForExport({
      jobId: input.job.jobId,
      startedAt: input.job.startedAt,
      endedAt: (input.now ?? (() => new Date().toISOString()))(),
      target: input.job.target,
      operatorNote: input.job.operatorNote,
      probe: input.job.probe,
      page: input.getPage(),
      network: input.getNetwork(),
    });
    const filePath = await input.chooseSavePath(assembled.fileName);
    if (!filePath) {
      return {
        ok: false,
        canceled: true,
        error: formatCaptureError({
          code: 'EXPORT_FAILED',
          detail: '用户取消了导出。',
        }),
      };
    }

    const zip = await buildCapturePackZip(assembled.pack);
    await input.writeFile(filePath, zip);

    return {
      ok: true,
      fileName: assembled.fileName,
      filePath,
      readiness: assembled.pack.manifest.readiness.status,
    };
  } catch (error) {
    // 捕获导出失败：可能由磁盘权限、空间不足或采集窗口已关闭导致
    // 策略：返回现场可读错误，不中断主窗口，便于改目录后重试
    return {
      ok: false,
      error: formatCaptureError({
        code: classifyCaptureError(error),
        detail: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
