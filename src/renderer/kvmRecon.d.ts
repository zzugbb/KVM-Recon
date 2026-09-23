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
  kind: 'recovered' | 'exported' | 'refused' | 'failed';
  jobId?: string;
  zipPath?: string;
  reason?: string;
  error?: string;
  conservative?: boolean;
  /** 待导出恢复作业的信息（kind=recovered）：导出由用户在恢复卡上手动触发。 */
  workflowStatus?: string;
  targetUrl?: string;
  deviceLabel?: string;
  /** 本次导出的实际完整度（kind=exported）：照实显示，不得硬编码 INCOMPLETE。 */
  captureIntegrity?: string;
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
      exportRecoveredCapture(zipDir?: string): Promise<StatusResult>;
      discardCapture(): Promise<StatusResult>;
    };
  }
}
