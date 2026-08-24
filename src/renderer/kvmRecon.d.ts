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
}

type StartCaptureResult =
  | {
      ok: true;
      jobId: string;
      family: unknown;
      timeline: unknown;
      network: unknown;
      snapshot: LiveCaptureSnapshot;
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
    }
  | {
      ok: false;
      canceled?: boolean;
      error: FormattedCaptureError;
    };

type SnapshotResult =
  | ({
      ok: true;
      windowsOpen: boolean;
    } & LiveCaptureSnapshot)
  | {
      ok: false;
      error: FormattedCaptureError;
    };

declare global {
  interface Window {
    kvmRecon?: {
      appName: string;
      startCapture(target: StartCaptureTarget): Promise<StartCaptureResult>;
      exportCapture(jobId: string): Promise<ExportCaptureResult>;
      getCaptureSnapshot(jobId: string): Promise<SnapshotResult>;
      collectCapturePage(jobId: string, role?: string): Promise<SnapshotResult>;
      stopCapture(jobId: string): Promise<SnapshotResult>;
      refreshCaptureProbe(jobId: string): Promise<SnapshotResult>;
    };
  }
}
