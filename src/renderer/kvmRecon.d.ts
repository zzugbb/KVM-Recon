export {};

interface FormattedCaptureError {
  title: string;
  impact: string;
  action: string;
  detail: string;
}

interface StartCaptureTarget {
  host: string;
  port: number;
  scheme: 'http' | 'https';
  operatorNote?: string;
  operatorObserved?: {
    vendor?: string;
    product?: string;
    firmware?: string;
    location?: string;
    note?: string;
  };
}

interface CaptureJobSummary {
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
  readiness: 'YES' | 'PARTIAL' | 'NO';
}

interface CapturePackSummary {
  family: string;
  readiness: string;
  host: string;
  port: number;
  jobId: string;
  httpRequestCount: number;
  webSocketCount: number;
  webSocketUrls: string[];
  screenshotRoles: string[];
  pathHits: string[];
  blockingItems: string[];
  schemaErrors: string[];
  observedVendor: string;
  observedProduct: string;
}

interface CapturePackDiff {
  field: string;
  left: string;
  right: string;
  changed: boolean;
}

interface CapturePackComparison {
  left: CapturePackSummary;
  right: CapturePackSummary;
  diffs: CapturePackDiff[];
}

interface LiveCaptureSnapshot {
  readiness: 'YES' | 'PARTIAL' | 'NO';
  items: Array<{
    id: string;
    title: string;
    status: 'pass' | 'fail' | 'unknown' | 'missing' | 'not_applicable' | 'needs_user_action';
    severity: 'blocking' | 'warning' | 'info';
    evidence: string[];
    userAction: string;
  }>;
  windowsOpen?: boolean;
  paused?: boolean;
  capturingScreenshot?: boolean;
  jobs?: CaptureJobSummary[];
}

type StartCaptureResult =
  | {
      ok: true;
      jobId: string;
      family: unknown;
      timeline: unknown;
      network: unknown;
      snapshot: LiveCaptureSnapshot;
      jobs: CaptureJobSummary[];
    }
  | {
      ok: false;
      error: FormattedCaptureError;
    };

type ExportCaptureResult =
  | {
      ok: true;
      fileName: string;
      filePath: string;
      readiness: 'YES' | 'PARTIAL' | 'NO';
      jobs?: CaptureJobSummary[];
    }
  | {
      ok: false;
      canceled?: boolean;
      error: FormattedCaptureError;
      jobs?: CaptureJobSummary[];
    };

type SnapshotResult =
  | ({
      ok: true;
      windowsOpen: boolean;
      paused?: boolean;
      jobs?: CaptureJobSummary[];
    } & LiveCaptureSnapshot)
  | {
      ok: false;
      error: FormattedCaptureError;
    };

type JobListResult =
  | {
      ok: true;
      jobs: CaptureJobSummary[];
    }
  | {
      ok: false;
      error: FormattedCaptureError;
    };

type PackChooseResult =
  | {
      ok: true;
      filePath: string;
    }
  | {
      ok: false;
      canceled?: boolean;
      error?: FormattedCaptureError;
    };

type PackSummaryResult =
  | {
      ok: true;
      summary: CapturePackSummary;
      filePath: string;
    }
  | {
      ok: false;
      error: FormattedCaptureError;
    };

type PackCompareResult =
  | {
      ok: true;
      comparison: CapturePackComparison;
      leftPath: string;
      rightPath: string;
    }
  | {
      ok: false;
      error: FormattedCaptureError;
    };

declare global {
  interface Window {
    kvmRecon?: {
      appName: string;
      appVersion: string;
      startCapture(target: StartCaptureTarget): Promise<StartCaptureResult>;
      exportCapture(jobId: string): Promise<ExportCaptureResult>;
      getCaptureSnapshot(jobId: string): Promise<SnapshotResult>;
      collectCapturePage(jobId: string, role?: string): Promise<SnapshotResult>;
      stopCapture(jobId: string): Promise<SnapshotResult>;
      refreshCaptureProbe(jobId: string): Promise<SnapshotResult>;
      listCaptureJobs(): Promise<JobListResult>;
      pauseCapture(jobId: string): Promise<SnapshotResult>;
      resumeCapture(jobId: string): Promise<SnapshotResult>;
      closeCaptureJob(jobId: string): Promise<JobListResult>;
      chooseCapturePack(): Promise<PackChooseResult>;
      summarizeCapturePack(filePath: string): Promise<PackSummaryResult>;
      compareCapturePacks(leftPath: string, rightPath: string): Promise<PackCompareResult>;
    };
  }
}
