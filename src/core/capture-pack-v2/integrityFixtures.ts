import type {
  DerivedPackIntegrity,
  IncompleteReasonCode,
  PackIntegrityEvidenceSummary,
} from './types';

/**
 * 完整度失败 Fixture（规范 §19 阶段 0：为每个完整度错误建立失败 Fixture）。
 *
 * 每个 INCOMPLETE 稳定原因代码对应一个失败 fixture：除该缺失外，
 * 其余证据全部在。阶段 3 的 IntegrityEngine 必须让每个 fixture
 * 派生出 INCOMPLETE + 对应原因代码；任何「缺失但显示完整」的回归
 * 都会在这里暴露。
 */

export interface IntegrityFailureFixture {
  /** fixture 稳定 ID。 */
  id: string;
  reason: IncompleteReasonCode;
  /** 中文场景描述。 */
  scenario: string;
  summary: PackIntegrityEvidenceSummary;
  expected: {
    captureIntegrity: 'INCOMPLETE';
    reasons: IncompleteReasonCode[];
  };
}

function allEvidencePresentSummary(): PackIntegrityEvidenceSummary {
  return {
    collectorReadyBeforeFirstNavigation: true,
    rawJournalsClosed: true,
    browserStateWritten: true,
    evidenceReferencesClosed: true,
    storageLimitReached: false,
    targetAttachFailures: [],
    missingBodies: [],
    missingWorkerSources: [],
    channelGaps: [],
    unsupportedChannels: [],
    journalWriteFailures: [],
    exportValidationFailures: [],
    workflowStatus: 'KVM_REACHED',
  };
}

export const INTEGRITY_FAILURE_FIXTURES: readonly IntegrityFailureFixture[] = [
  {
    id: 'fixture-body-missing-viewer-bundle',
    reason: 'INCOMPLETE_BODY_MISSING',
    scenario: 'Viewer 主 bundle 的 4.1 MiB 响应正文没有写入磁盘（0.2.x 会因 2 MiB 单文件上限截断；2.0 不允许）。',
    summary: {
      ...allEvidencePresentSummary(),
      missingBodies: [
        { id: 'http-000021', detail: 'application/javascript 响应正文缺失' },
      ],
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_BODY_MISSING'] },
  },
  {
    id: 'fixture-target-attach-oopif-failed',
    reason: 'INCOMPLETE_TARGET_ATTACH',
    scenario: 'Viewer 页面中的 OOPIF iframe 未能自动挂载，该 target 内的网络事实缺失。',
    summary: {
      ...allEvidencePresentSummary(),
      targetAttachFailures: [
        { id: 'target-oopif-0003', detail: 'OOPIF attach 失败：Session with given id not found' },
      ],
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_TARGET_ATTACH'] },
  },
  {
    id: 'fixture-worker-source-missing',
    reason: 'INCOMPLETE_WORKER_SOURCE',
    scenario: 'Viewer 的解码 Worker（blob: URL 动态创建）入口源码没有采到。',
    summary: {
      ...allEvidencePresentSummary(),
      missingWorkerSources: [
        { id: 'script-worker-0002', detail: 'blob: Worker 入口源码缺失' },
      ],
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_WORKER_SOURCE'] },
  },
  {
    id: 'fixture-channel-gap-ws-payload',
    reason: 'INCOMPLETE_CHANNEL_GAP',
    scenario: 'KVM WebSocket 在第 128 帧后停止写入 payload，通道出现断档（0.2.x 只保留 64 帧摘要属于此类断档）。',
    summary: {
      ...allEvidencePresentSummary(),
      channelGaps: [
        { id: 'ws-0001', detail: '第 128 帧后 payload 未落盘' },
      ],
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_CHANNEL_GAP'] },
  },
  {
    id: 'fixture-unsupported-channel-jnlp',
    reason: 'INCOMPLETE_UNSUPPORTED_CHANNEL',
    scenario: '页面触发 Java Web Start .jnlp 下载，控制台运行在浏览器之外的私有进程内，Chromium 不可观测（规范 §2.2）。',
    summary: {
      ...allEvidencePresentSummary(),
      unsupportedChannels: [
        { id: 'download-jnlp-0001', detail: 'Java Web Start 客户端通道不可采集' },
      ],
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_UNSUPPORTED_CHANNEL'] },
  },
  {
    id: 'fixture-storage-limit-reached',
    reason: 'INCOMPLETE_STORAGE_LIMIT',
    scenario: '磁盘触及安全余量，采集停止写入新的大流数据（规范 §9）。',
    summary: {
      ...allEvidencePresentSummary(),
      storageLimitReached: true,
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_STORAGE_LIMIT'] },
  },
  {
    id: 'fixture-export-validation-failed',
    reason: 'INCOMPLETE_EXPORT_VALIDATION',
    scenario: '导出 ZIP 重新打开校验时 checksums 与实际文件 SHA-256 不一致（规范 §9：校验失败不生成正式文件名）。',
    summary: {
      ...allEvidencePresentSummary(),
      exportValidationFailures: [
        { id: 'raw/http/bodies/9f2c', detail: 'SHA-256 与清单不一致' },
      ],
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_EXPORT_VALIDATION'] },
  },
  {
    id: 'fixture-workflow-not-reached',
    reason: 'INCOMPLETE_WORKFLOW_NOT_REACHED',
    scenario: '用户登录成功但没有点击 HTML5 KVM，采集机械上完整但关键事实尚未发生。',
    summary: {
      ...allEvidencePresentSummary(),
      workflowStatus: 'LOGIN_REACHED',
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_WORKFLOW_NOT_REACHED'] },
  },
  {
    id: 'fixture-raw-journal-not-closed',
    reason: 'INCOMPLETE_RAW_JOURNAL',
    scenario: '作业被强制结束后原始 CDP journal / NetLog 未正常关闭写入，未来 Analyzer 无法重新解释原始事件（规范 §14 条件 7）。',
    summary: {
      ...allEvidencePresentSummary(),
      rawJournalsClosed: false,
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_RAW_JOURNAL'] },
  },
  {
    id: 'fixture-browser-state-not-written',
    reason: 'INCOMPLETE_BROWSER_STATE',
    scenario: '页面、截图、Storage、console 或运行环境资料写入失败（规范 §14 条件 8）。',
    summary: {
      ...allEvidencePresentSummary(),
      browserStateWritten: false,
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_BROWSER_STATE'] },
  },
  {
    id: 'fixture-evidence-reference-dangling',
    reason: 'INCOMPLETE_EVIDENCE_REFERENCE',
    scenario: '资源图存在悬空的必需 body/script/channel 引用：索引指向的正文文件缺失或哈希不一致（规范 §14 条件 9）。',
    summary: {
      ...allEvidencePresentSummary(),
      evidenceReferencesClosed: false,
    },
    expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_EVIDENCE_REFERENCE'] },
  },
];

/** 正向 fixture：完全未知协议 + 全部证据在 → COMPLETE + KVM_REACHED + UNKNOWN（规范 §20）。 */
export interface IntegrityPositiveFixture {
  id: string;
  summary: PackIntegrityEvidenceSummary;
  expected: DerivedPackIntegrity;
}

export const INTEGRITY_POSITIVE_FIXTURE: IntegrityPositiveFixture = {
  id: 'fixture-unknown-protocol-complete',
  summary: allEvidencePresentSummary(),
  expected: { captureIntegrity: 'COMPLETE', reasons: [], gates: [] },
};

/** 采集器晚于首次导航挂载也必须判不完整（规范 §14 条件 1），按 target 挂载缺失处理。 */
export const INTEGRITY_LATE_COLLECTOR_FIXTURE: IntegrityFailureFixture = {
  id: 'fixture-collector-late-after-first-navigation',
  reason: 'INCOMPLETE_TARGET_ATTACH',
  scenario: '采集器在第一次导航之后才挂载，首屏 Document 与登录页资源未进入记录。',
  summary: {
    ...allEvidencePresentSummary(),
    collectorReadyBeforeFirstNavigation: false,
  },
  expected: { captureIntegrity: 'INCOMPLETE', reasons: ['INCOMPLETE_TARGET_ATTACH'] },
};
