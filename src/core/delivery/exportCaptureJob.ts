import { readFile } from 'node:fs/promises';

import { collectScreenshotArtifacts } from '../browser/collectScreenshotArtifacts';
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

export interface ExportConfirmSummary {
  readiness: CaptureReadiness;
  redactionStatus: 'pass' | 'fail';
  redactedFields: number;
  pendingActions: string[];
}

interface ExportCaptureJobInput {
  job: CaptureExportJob;
  collectPageFacts(label: string): Promise<void>;
  getPage(): BrowserTimelineJson;
  getNetwork(): NetworkSnapshot;
  chooseSavePath(fileName: string): Promise<string | null>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  now?: () => string;
  sensitiveValues?: string[];
  readScreenshotFile?(path: string): Promise<Uint8Array>;
  confirmExport?(summary: ExportConfirmSummary): Promise<boolean>;
  getChromiumAccess?(): { reachable: boolean; authorizationError: string };
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
    const page = input.getPage();
    const screenshotArtifacts = await collectScreenshotArtifacts({
      page,
      readFile: async path => {
        try {
          const bytes = await (input.readScreenshotFile
            ? input.readScreenshotFile(path)
            : readFile(path));
          return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        } catch (error) {
          // 捕获截图文件缺失：采集目录可能被清理或路径不可读
          // 策略：跳过该文件，继续导出其余脱敏资料，避免整包失败
          void error;
          return null;
        }
      },
    });
    const assembled = assembleCapturePackForExport({
      jobId: input.job.jobId,
      startedAt: input.job.startedAt,
      endedAt: (input.now ?? (() => new Date().toISOString()))(),
      target: input.job.target,
      operatorNote: input.job.operatorNote,
      probe: {
        ...input.job.probe,
        tls: {
          ...input.job.probe.tls,
          ...(input.getChromiumAccess ? { chromium: input.getChromiumAccess() } : {}),
        },
      },
      page,
      network: input.getNetwork(),
      sensitiveValues: input.sensitiveValues,
      screenshotArtifacts,
    });
    if (!assembled.canExportSafePack) {
      return {
        ok: false,
        error: formatCaptureError({
          code: 'REDACTION_FAILED',
          detail: assembled.pack.manifest.redaction.status,
        }),
      };
    }
    const confirmed = input.confirmExport
      ? await input.confirmExport({
          readiness: assembled.pack.manifest.readiness.status,
          redactionStatus: assembled.pack.manifest.redaction.status,
          redactedFields: assembled.pack.manifest.redaction.redactedFields,
          pendingActions: assembled.pack.checklist.items
            .filter(item => item.userAction)
            .map(item => item.userAction),
        })
      : true;
    if (!confirmed) {
      return {
        ok: false,
        canceled: true,
        error: formatCaptureError({
          code: 'EXPORT_FAILED',
          detail: '用户取消了导出。',
        }),
      };
    }
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
