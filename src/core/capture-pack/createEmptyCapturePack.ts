import type {
  CaptureChecklist,
  CapturePackDraft,
  CaptureTarget,
} from './types';

interface CreateEmptyCapturePackInput {
  jobId: string;
  target: CaptureTarget;
  startedAt: string;
  operatorNote?: string;
  observed?: {
    vendor: string;
    product: string;
    firmware: string;
    location: string;
  };
}

const TOOL_VERSION = '0.1.0';

export function createEmptyCapturePack(input: CreateEmptyCapturePackInput): CapturePackDraft {
  const checklist: CaptureChecklist = {
    readiness: 'NO',
    items: [
      {
        id: 'capture.empty',
        title: '尚未采集 KVM 适配资料',
        status: 'missing',
        severity: 'blocking',
        evidence: [],
        userAction: '请开始采集并至少完成 BMC 登录、HTML5 KVM 入口点击和 WebSocket 建立。',
      },
    ],
  };

  return {
    manifest: {
      schemaVersion: '1.0.0',
      tool: {
        name: 'KVM-Recon',
        version: TOOL_VERSION,
      },
      job: {
        id: input.jobId,
        startedAt: input.startedAt,
        endedAt: null,
        operatorNote: input.operatorNote || '',
        ...(input.observed ? { observed: input.observed } : {}),
      },
      target: input.target,
      family: {
        primary: 'unknown-h5',
        confidence: 0,
        candidates: [],
      },
      readiness: {
        status: checklist.readiness,
        blockingCount: 1,
        warningCount: 0,
      },
      redaction: {
        status: 'pass',
        redactedFields: 0,
      },
    },
    checklist,
    reportMarkdown: [
      '# KVM-Recon Capture Report',
      '',
      '离场适配就绪：NO',
      '',
      '当前 Capture Pack 尚未包含登录、KVM 入口或 WebSocket 资料。',
    ].join('\n'),
    files: ['manifest.json', 'checklist.json', 'report.md'],
  };
}
