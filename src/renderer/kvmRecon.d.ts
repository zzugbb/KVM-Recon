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
}

type StartCaptureResult =
  | {
      ok: true;
      jobId: string;
      family: unknown;
      timeline: unknown;
      network: unknown;
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

declare global {
  interface Window {
    kvmRecon?: {
      appName: string;
      startCapture(target: StartCaptureTarget): Promise<StartCaptureResult>;
      exportCapture(jobId: string): Promise<ExportCaptureResult>;
    };
  }
}
