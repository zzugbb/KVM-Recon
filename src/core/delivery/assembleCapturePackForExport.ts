import { viewerScreenshotPaths } from '../browser/browserCaptureCore';
import { buildBrowserArtifacts } from '../browser/buildBrowserArtifacts';
import { createEmptyCapturePack } from '../capture-pack/createEmptyCapturePack';
import type { CapturePackArtifact, CapturePackDraft, CaptureTarget } from '../capture-pack/types';
import type {
  HttpRequestRecord,
  NetworkIdleResult,
  WebSocketFrameRecord,
  WebSocketRecord,
} from '../network/createNetworkRecorder';
import { buildNetworkArtifacts } from '../network/buildNetworkArtifacts';
import { buildOemProfileArtifacts } from '../profile/buildOemProfileArtifacts';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import { overlayPathEvidence, scoreCapturedKvmFamily } from '../signatures/detectKvmFamily';
import { detectProductHints } from '../signatures/detectProductHints';
import { buildProbeArtifacts } from '../probe/buildProbeArtifacts';
import { applyReadinessToCapturePack } from '../readiness/applyReadinessToCapturePack';
import { buildReadinessChecklist } from '../readiness/buildReadinessChecklist';
import { validateRedactionForExport } from '../redaction/validateRedactionForExport';
import { buildCapturePackFileName } from './buildCapturePackFileName';
import { buildPackReadmeArtifact } from './buildPackReadmeArtifact';
import {
  buildOperatorObservedArtifact,
  normalizeOperatorObserved,
  observedForManifest,
  type OperatorObservedAsset,
} from './operatorObserved';

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
  operatorObserved?: Partial<OperatorObservedAsset> | null;
  probe: ProbeBmcTargetResult;
  page: BrowserTimelineJson;
  network: NetworkSnapshot;
  networkIdle?: NetworkIdleResult;
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
  const networkIdle = input.networkIdle ?? {
    timedOut: false,
    pendingTaskCount: 0,
    inFlightRequestIds: [],
  };
  const operatorObserved = normalizeOperatorObserved({
    ...input.operatorObserved,
    note: input.operatorObserved?.note ?? input.operatorNote,
  });
  const operatorArtifact = buildOperatorObservedArtifact(operatorObserved);
  let pack = createEmptyCapturePack({
    jobId: input.jobId,
    startedAt: input.startedAt,
    target: input.target,
    operatorNote: operatorObserved.note,
    observed: observedForManifest(operatorObserved),
  });

  pack.manifest.job.endedAt = input.endedAt;
  const familySignatures = scoreCapturedKvmFamily(input.probe, input.network);
  const productHints = detectProductHints({
    redfish: {
      vendor: input.probe.basic.vendor,
      product: input.probe.basic.product,
    },
    observed: operatorObserved,
    traffic: {
      httpUrls: input.network.httpRequests.map(request => request.url).filter(Boolean),
      webSocketUrls: input.network.webSockets.map(socket => socket.url).filter(Boolean),
      frameHeads: input.network.webSocketFrames.map(frame => frame.magic || frame.headHex).filter(Boolean),
      frameHeadHexes: input.network.webSocketFrames.map(frame => frame.headHex).filter(Boolean),
    },
  });
  const probe = {
    ...input.probe,
    paths: overlayPathEvidence(input.probe.paths, input.probe.authenticated?.paths),
    familySignatures,
  };
  pack.manifest.family = {
    primary: familySignatures.primary,
    confidence: familySignatures.confidence,
    candidates: familySignatures.candidates,
    productHints,
  };

  const artifacts = [
    ...buildProbeArtifacts(probe),
    {
      path: 'probe/product-hints.json',
      content: JSON.stringify(productHints, null, 2),
    },
    ...(operatorArtifact ? [operatorArtifact] : []),
    ...buildBrowserArtifacts(input.page),
    ...(input.screenshotArtifacts ?? []),
    ...buildNetworkArtifacts(input.network),
    {
      path: 'http/capture-status.json',
      content: JSON.stringify(networkIdle, null, 2),
    },
    ...buildOemProfileArtifacts({
      probe,
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
      probe: probe,
      page: input.page,
      network: input.network,
      networkIdle,
      redaction: {
        status: redaction.status,
        redactedFields: redaction.redactedFields,
      },
    }),
  );
  pack.artifacts = [
    ...artifacts,
    buildPackReadmeArtifact({
      kvmFamily: pack.manifest.family.primary,
      familyConfidence: pack.manifest.family.confidence,
      readiness: pack.manifest.readiness.status,
      blockingTitles: pack.checklist.items
        .filter(
          item =>
            item.severity === 'blocking' &&
            item.status !== 'pass' &&
            item.status !== 'not_applicable',
        )
        .map(item => item.title),
      warningTitles: pack.checklist.items
        .filter(
          item =>
            item.severity === 'warning' &&
            item.status !== 'pass' &&
            item.status !== 'not_applicable',
        )
        .map(item => item.title),
      operatorNote: operatorObserved.note,
      operatorObserved,
      httpRequestCount: input.network.httpRequests.length,
      webSocketCount: input.network.webSockets.length,
      webSocketUrls: [...new Set(input.network.webSockets.map(socket => socket.url).filter(Boolean))],
      screenshotCount: viewerScreenshotPaths(input.page.events).length,
      hasOemProfile: artifacts.some(item => item.path === 'artifacts/oem-profile.yaml'),
      hasAuthenticated: Boolean(probe.authenticated),
      cookieNames: probe.authenticated?.cookieNames ?? [],
    }),
  ];

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
