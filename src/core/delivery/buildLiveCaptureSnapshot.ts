import type { CaptureChecklist, CaptureReadiness, ChecklistItem } from '../capture-pack/types';
import type {
  HttpRequestRecord,
  WebSocketFrameRecord,
  WebSocketRecord,
} from '../network/createNetworkRecorder';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import { buildReadinessChecklist } from '../readiness/buildReadinessChecklist';

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

interface BuildLiveCaptureSnapshotInput {
  probe?: ProbeBmcTargetResult | null;
  page?: BrowserTimelineJson | null;
  network?: NetworkSnapshot | null;
}

export interface LiveCaptureSnapshot {
  readiness: CaptureReadiness;
  items: ChecklistItem[];
}

export function buildLiveCaptureSnapshot(input: BuildLiveCaptureSnapshotInput): LiveCaptureSnapshot {
  const checklist: CaptureChecklist = buildReadinessChecklist({
    probe: input.probe,
    page: input.page,
    network: input.network,
    redaction: {
      status: 'pass',
      redactedFields: 0,
    },
  });

  const items = checklist.items.filter(item => item.id !== 'redaction.safe');
  const blockingMissing = items.some(
    item =>
      item.severity === 'blocking' && item.status !== 'pass' && item.status !== 'not_applicable',
  );
  const warningMissing = items.some(
    item =>
      item.severity === 'warning' && item.status !== 'pass' && item.status !== 'not_applicable',
  );

  return {
    readiness: blockingMissing ? 'NO' : warningMissing ? 'PARTIAL' : 'YES',
    items,
  };
}
