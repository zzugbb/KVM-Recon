export type CaptureReadiness = 'YES' | 'PARTIAL' | 'NO';

export type ChecklistStatus =
  | 'pass'
  | 'fail'
  | 'unknown'
  | 'missing'
  | 'not_applicable'
  | 'needs_user_action';

export type ChecklistSeverity = 'blocking' | 'warning' | 'info';

export interface CaptureTarget {
  host: string;
  port: number;
  scheme: 'http' | 'https';
}

export interface CaptureManifest {
  schemaVersion: '1.0.0';
  tool: {
    name: 'KVM-Recon';
    version: string;
  };
  job: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    operatorNote: string;
  };
  target: CaptureTarget;
  family: {
    primary: string;
    confidence: number;
    candidates: Array<{
      kvmFamily: string;
      confidence: number;
      evidence: string[];
    }>;
  };
  readiness: {
    status: CaptureReadiness;
    blockingCount: number;
    warningCount: number;
  };
  redaction: {
    status: 'pass' | 'fail';
    redactedFields: number;
  };
}

export interface ChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  severity: ChecklistSeverity;
  evidence: string[];
  userAction: string;
}

export interface CaptureChecklist {
  readiness: CaptureReadiness;
  items: ChecklistItem[];
}

export interface CapturePackArtifact {
  path: string;
  content: string | Uint8Array;
}

export interface CapturePackDraft {
  manifest: CaptureManifest;
  checklist: CaptureChecklist;
  reportMarkdown: string;
  reportHtml?: string;
  files: string[];
  artifacts?: CapturePackArtifact[];
}
