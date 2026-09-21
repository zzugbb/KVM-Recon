export {};

interface CaptureStatusJob {
  jobId: string;
  state: 'capturing' | 'stopped' | 'exported';
  /** 采集会话派生的工作流状态（观察事实推导）。 */
  workflowStatus: 'TARGET_OPENED' | 'LOGIN_REACHED' | 'KVM_REACHED';
  windowsOpen: boolean;
  storageLimited: boolean;
  windowsLabel: string;
  diagnostics: {
    droppedEvents: number;
    droppedEventByMethod: Record<string, number>;
    gapCounts: Record<string, number>;
    storageLimitReached: boolean;
  };
}

interface CaptureExportInfo {
  zipPath: string;
  fileName: string;
  status: {
    captureIntegrity: 'COMPLETE' | 'INCOMPLETE' | 'LEGACY_UNVERIFIED';
    workflowStatus: string;
    classificationStatus: string;
  };
}

interface RecoveryNotice {
  kind: 'exported' | 'refused' | 'failed';
  jobId?: string;
  zipPath?: string;
  reason?: string;
  error?: string;
  conservative?: boolean;
}

type IpcError = { ok: false; error: string };

type StartResult =
  | { ok: true; jobId: string; target: { host: string; port: number; scheme: string } }
  | IpcError;

type StatusResult =
  | {
      ok: true;
      job: CaptureStatusJob | null;
      export: CaptureExportInfo | null;
      recovery: RecoveryNotice | null;
      zipPath?: string;
      fileName?: string;
    }
  | IpcError;

declare global {
  interface Window {
    kvmRecon?: {
      appName: string;
      appVersion: string;
      startCapture(target: string, deviceLabel?: string): Promise<StartResult>;
      getCaptureStatus(): Promise<StatusResult>;
      stopCapture(): Promise<StatusResult>;
      exportCapture(zipDir?: string): Promise<StatusResult>;
      discardCapture(): Promise<StatusResult>;
    };
  }
}
