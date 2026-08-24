import { buildBrowserArtifacts } from '../browser/buildBrowserArtifacts';
import { createEmptyCapturePack } from '../capture-pack/createEmptyCapturePack';
import type { CapturePackArtifact, CapturePackDraft, CaptureTarget } from '../capture-pack/types';
import type {
  HttpRequestRecord,
  WebSocketFrameRecord,
  WebSocketRecord,
} from '../network/createNetworkRecorder';
import { buildNetworkArtifacts } from '../network/buildNetworkArtifacts';
import { buildOemProfileArtifacts } from '../profile/buildOemProfileArtifacts';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import { buildProbeArtifacts } from '../probe/buildProbeArtifacts';
import { applyReadinessToCapturePack } from '../readiness/applyReadinessToCapturePack';
import { buildReadinessChecklist } from '../readiness/buildReadinessChecklist';
import { validateRedactionForExport } from '../redaction/validateRedactionForExport';
import { buildCapturePackFileName } from './buildCapturePackFileName';

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

export interface AssembleCapturePackForExportInput {
  jobId: string;
  startedAt: string;
  endedAt: string;
  target: CaptureTarget;
  operatorNote?: string;
  probe: ProbeBmcTargetResult;
  page: BrowserTimelineJson;
  network: NetworkSnapshot;
  sensitiveValues?: string[];
  screenshotArtifacts?: CapturePackArtifact[];
}

export interface AssembledCapturePack {
  pack: CapturePackDraft;
  fileName: string;
  canExportSafePack: boolean;
}

function countRedactedFields(network: NetworkSnapshot): number {
  return network.httpRequests.reduce((total, request) => {
    return (
      total +
      request.requestBodySummary.redactedFields.length +
      request.responseBodySummary.redactedFields.length
    );
  }, 0);
}

export function assembleCapturePackForExport(
  input: AssembleCapturePackForExportInput,
): AssembledCapturePack {
  let pack = createEmptyCapturePack({
    jobId: input.jobId,
    startedAt: input.startedAt,
    target: input.target,
    operatorNote: input.operatorNote,
  });

  pack.manifest.job.endedAt = input.endedAt;
  pack.manifest.family = {
    primary: input.probe.familySignatures.primary,
    confidence: input.probe.familySignatures.confidence,
    candidates: input.probe.familySignatures.candidates,
  };

  const artifacts = [
    ...buildProbeArtifacts(input.probe),
    ...buildBrowserArtifacts(input.page),
    ...(input.screenshotArtifacts ?? []),
    ...buildNetworkArtifacts(input.network),
    ...buildOemProfileArtifacts({
      probe: input.probe,
      network: input.network,
    }),
  ];

  const redactedFields = countRedactedFields(input.network);
  const redaction = validateRedactionForExport({
    data: {
      artifacts,
      network: input.network,
      page: input.page,
    },
    sensitiveValues: input.sensitiveValues ?? [],
    redactedFields,
  });
  pack.manifest.redaction = {
    status: redaction.status,
    redactedFields: redaction.redactedFields,
  };

  pack = applyReadinessToCapturePack(
    pack,
    buildReadinessChecklist({
      probe: input.probe,
      page: input.page,
      network: input.network,
      redaction: {
        status: redaction.status,
        redactedFields: redaction.redactedFields,
      },
    }),
  );
  pack.artifacts = artifacts;

  return {
    pack,
    canExportSafePack: redaction.canExportSafePack,
    fileName: buildCapturePackFileName({
      startedAt: input.startedAt,
      targetHost: input.target.host,
      kvmFamily: pack.manifest.family.primary,
      readiness: pack.manifest.readiness.status,
    }),
  };
}
