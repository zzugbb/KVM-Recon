export {};

/** 最近事实条目（规范 §5.2：非敏感摘要，稳定 ID + 类型 + URL origin/path）。 */
interface RecentFactEntry {
  occurredAt: string;
  kind:
    | 'target-attached'
    | 'channel-opened'
    | 'user-action'
    | 'navigation'
    | 'render-surface';
  text: string;
}

interface CaptureStatusJob {
  jobId: string;
  state: 'capturing' | 'stopped' | 'exported';
  /** 采集会话派生的工作流状态（观察事实推导）。 */
  workflowStatus: 'TARGET_OPENED' | 'LOGIN_REACHED' | 'KVM_REACHED';
  windowsOpen: boolean;
  storageLimited: boolean;
  windowsLabel: string;
  targetLabel: string;
  targetUrl: string;
  /** stop 序列进行中（手动与自动收尾共用路径；界面「正在收尾」瞬态）。 */
  finalizing: boolean;
  /** 稳定宽度计数器（规范 §5.2）。 */
  counts: {
    httpTransactions: number;
    targets: number;
    channels: number;
    websocketChannels: number;
    actions: number;
  };
  /** 包工件字节记账（JSONL + 工件 + 已发布正文；不含 ZIP 导出）。 */
  bytesWritten: number;
  /** 收尾后的预导出完整度（仅界面文案用；导出后以导出结果为准）。收尾前为 null。 */
  captureIntegrity: 'COMPLETE' | 'INCOMPLETE' | null;
  /** INCOMPLETE 时的稳定原因码（收尾前为空）。 */
  incompleteReasons: string[];
  recentFacts: RecentFactEntry[];
  diagnostics: {
    droppedEvents: number;
    droppedEventByMethod: Record<string, number>;
    gapCounts: Record<string, number>;
    storageLimitReached: boolean;
    observerHookFailures: Array<{ hook: string; stage: string; detail: string }>;
    channelGaps: string[];
    unsupportedChannels: string[];
    captureWindowLogTail: string[];
    disk: { freeBytes: number; marginBytes: number; ok: boolean } | null;
  };
}

interface CaptureExportInfo {
  zipPath: string;
  fileName: string;
  status: {
    captureIntegrity: 'COMPLETE' | 'INCOMPLETE';
    workflowStatus: string;
  };
}

interface RecoveryNotice {
  kind: 'recovered' | 'exported' | 'discarded' | 'retained' | 'refused' | 'failed';
  jobId?: string;
  zipPath?: string;
  workspacePath?: string;
  reason?: string;
  error?: string;
  conservative?: boolean;
  /** 待导出恢复作业的信息（kind=recovered）：导出由用户在恢复卡上手动触发。 */
  workflowStatus?: string;
  targetUrl?: string;
  deviceLabel?: string;
  /** 恢复作业的只读丢弃门禁结果：非 true（含检查中的缺省）时界面置灰丢弃按钮。 */
  discardable?: boolean;
  discardNote?: string;
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
      discardRecoveredCapture(): Promise<StatusResult>;
      retainWorkspace(): Promise<StatusResult>;
      revealExportFolder(): Promise<{ ok: true } | IpcError>;
      revealWorkspaceFolder(): Promise<{ ok: true } | IpcError>;
      discardCapture(): Promise<StatusResult>;
    };
  }
}
