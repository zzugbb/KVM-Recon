import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import {
  assembleCapturePackV2,
  resolvePackV2SchemaDir,
} from './assembleCapturePackV2';
import type { PackIntegrityEvidenceSummary } from './types';

/**
 * 包装配反例：environment 缺失拒绝；schema 目录缺失显式报错；
 * TARGET_OPENED 恒 INCOMPLETE + INCOMPLETE_WORKFLOW_NOT_REACHED；
 * 通道 ID 从 catalog/channels.json 事实复制；工作区无派生事实时候选链 /
 * 值传播 / Replay 退回诚实下限，派生缺口显式记入 ai/summary.md。
 */

const roots: string[] = [];

async function newRootDir() {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-assemble-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const ENVIRONMENT = {
  chromium: '152.0.7977.76',
  electron: '44.3.0',
  os: 'darwin 25.6.0',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) KVM-Recon-E2E',
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
  screen: '3008x1702@2x',
};

function evidence(workflowStatus: PackIntegrityEvidenceSummary['workflowStatus']): PackIntegrityEvidenceSummary {
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
    browserStateGaps: [],
    evidenceGraphFailures: [],
    exportValidationFailures: [],
    workflowStatus,
  };
}

function fileOf(result: Awaited<ReturnType<typeof assembleCapturePackV2>>, path: string) {
  const file = result.files.find(candidate => candidate.path === path);
  if (!file) throw new Error(`装配缺少文件：${path}`);
  return typeof file.content === 'string' ? file.content : Buffer.from(file.content).toString('utf8');
}

describe('assembleCapturePackV2（阶段 2 包装配）', () => {
  it('完整度从证据摘要派生：TARGET_OPENED 恒 INCOMPLETE + INCOMPLETE_WORKFLOW_NOT_REACHED；缺口映射 missing-evidence', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-asm-incomplete', rootDir });
    await workspace.writeArtifact('catalog/channels.json', '{"schemaVersion":"2.0.0","channels":[]}\n');

    const summary = evidence('TARGET_OPENED');
    summary.channelGaps = [{ id: 'ws-0001', detail: '帧写入失败后停止该 socket 写入' }];
    const result = await assembleCapturePackV2({
      workspace,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      environment: { ...ENVIRONMENT },
      evidenceSummary: summary,
      target: { host: '10.10.8.111', port: 443, scheme: 'https' },
    });

    expect(result.status).toEqual({
      captureIntegrity: 'INCOMPLETE',
      workflowStatus: 'TARGET_OPENED',
    });
    expect(result.derived.reasons).toContain('INCOMPLETE_WORKFLOW_NOT_REACHED');
    expect(result.derived.reasons).toContain('INCOMPLETE_CHANNEL_GAP');
    const missing = JSON.parse(fileOf(result, 'ai/missing-evidence.json')) as { items: unknown[] };
    expect(missing.items.length).toBe(result.derived.reasons.length);
    expect(result.fileName).toContain('TARGET-OPENED_INCOMPLETE');
    await workspace.close();
  });

  it('通道 ID 从 catalog/channels.json 事实复制；无派生事实时候选链 / 值传播 / Replay 退回下限且缺口显式', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-asm-channels', rootDir });
    await workspace.writeArtifact(
      'catalog/channels.json',
      JSON.stringify({
        schemaVersion: '2.0.0',
        channels: [
          {
            id: 'ws-0001',
            kind: 'websocket',
            url: 'wss://10.10.8.111/stream',
            targetId: 'target-root',
            createdAt: '2026-09-21T10:00:01.000Z',
            closedAt: null,
            payloadPath: 'raw/websocket/ws-0001/frames.bin',
          },
          {
            id: 'webrtc-0001',
            kind: 'webrtc',
            url: null,
            targetId: 'target-root',
            createdAt: '2026-09-21T10:00:02.000Z',
            closedAt: null,
            payloadPath: null,
          },
        ],
      }),
    );

    const result = await assembleCapturePackV2({
      workspace,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      environment: { ...ENVIRONMENT },
      evidenceSummary: evidence('TARGET_OPENED'),
      target: { host: '10.10.8.111', port: 443, scheme: 'https' },
    });

    const aiIndex = JSON.parse(fileOf(result, 'ai/index.json')) as {
      websocketChannelIds: string[];
      webrtcChannelIds: string[];
      loginCandidateRequestIds: string[];
    };
    expect(aiIndex.websocketChannelIds).toEqual(['ws-0001']);
    expect(aiIndex.webrtcChannelIds).toEqual(['webrtc-0001']);
    expect(aiIndex.loginCandidateRequestIds).toEqual([]);

    const dossier = JSON.parse(fileOf(result, 'ai/adapter-dossier.json')) as { candidateChain: unknown[] };
    expect(dossier.candidateChain).toEqual([]);
    const valueFlow = JSON.parse(fileOf(result, 'ai/value-flow.json')) as { nodes: unknown[]; edges: unknown[] };
    expect(valueFlow.nodes).toEqual([]);
    expect(valueFlow.edges).toEqual([]);
    const replay = JSON.parse(fileOf(result, 'replay/manifest.json')) as {
      replayable: boolean;
      requests: unknown[];
    };
    expect(replay.replayable).toBe(false);
    expect(replay.requests).toEqual([]);
    expect(fileOf(result, 'replay/http.jsonl')).toBe('');
    // 无事实工作区的派生缺口显式进 summary（缺失记账红线）
    const summary = fileOf(result, 'ai/summary.md');
    expect(summary).toContain('适配候选链为空');
    expect(summary).toContain('派生缺口');
    expect(summary).toContain('raw/http/transactions.jsonl 不在包内');
    await workspace.close();
  });

  it('正向：工作区含登录链与 Viewer 活动事实 → 装配派生候选链与候选 ID（规范 §12 / §19）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-asm-derived', rootDir });
    await workspace.writeArtifact(
      'catalog/channels.json',
      JSON.stringify({
        schemaVersion: '2.0.0',
        channels: [
          {
            id: 'ws-0001',
            kind: 'websocket',
            url: 'wss://10.10.8.111/stream?t=token-value',
            targetId: 'target-page-0001',
            createdAt: '2026-09-21T10:00:09.000Z',
            closedAt: null,
            frameCounts: { up: 2, down: 3 },
            payloadPath: 'raw/websocket/ws-0001/frames.bin',
          },
        ],
      }),
    );
    const txRow = (id: string, seconds: number, overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        id,
        targetId: 'target-page-0001',
        startedAt: `2026-09-21T10:00:0${seconds}.000Z`,
        method: 'GET',
        url: `https://10.10.8.111/${id}`,
        resourceType: 'Other',
        requestHeaders: {},
        status: 200,
        responseHeaders: {},
        ...overrides,
      });
    await workspace.writeArtifact(
      'raw/http/transactions.jsonl',
      [
        txRow('http-000001', 0, { resourceType: 'Document' }),
        txRow('http-000002', 2, {
          method: 'POST',
          requestBody: { sha256: 'a'.repeat(64), bytes: 8, path: 'raw/http/bodies/aaa' },
          responseHeaders: { 'set-cookie': 'session=abc123; Path=/' },
        }),
        txRow('http-000003', 3, { requestHeaders: { cookie: 'session=abc123' } }),
        txRow('http-000004', 4, {
          method: 'POST',
          requestBody: { sha256: 'b'.repeat(64), bytes: 8, path: 'raw/http/bodies/bbb' },
          requestHeaders: { cookie: 'session=abc123' },
        }),
        txRow('http-000005', 5, { resourceType: 'Document' }),
      ].join('\n') + '\n',
    );
    await workspace.writeArtifact(
      'raw/browser/actions.jsonl',
      JSON.stringify({
        id: 'action-0002',
        occurredAt: '2026-09-21T10:00:04.000Z',
        kind: 'click',
        targetId: 'target-page-0001',
        elementSummary: '#console-open',
      }) + '\n',
    );
    await workspace.writeArtifact(
      'catalog/targets.json',
      JSON.stringify({
        schemaVersion: '2.0.0',
        targets: [
          { id: 'target-page-0001', type: 'page', attached: true, url: 'https://10.10.8.111/login', attachedAt: '2026-09-21T10:00:00.000Z' },
        ],
      }),
    );
    await workspace.writeArtifact(
      'raw/browser/render-surfaces.jsonl',
      JSON.stringify({
        id: 'render-0001',
        occurredAt: '2026-09-21T10:00:06.000Z',
        targetId: 'target-page-0001',
        surface: 'canvas-context',
        detail: '2d',
      }) + '\n',
    );
    await workspace.writeArtifact(
      'raw/cdp/events.jsonl',
      JSON.stringify({
        seq: 1,
        timestamp: '2026-09-21T10:00:05.000Z',
        method: 'Page.frameNavigated',
        targetId: 'target-page-0001',
        params: { frame: { id: 'frame-0001', url: 'https://10.10.8.111/viewer' } },
      }) + '\n',
    );
    await workspace.writeArtifact(
      'raw/scripts/index.json',
      JSON.stringify({
        schemaVersion: '2.0.0',
        scripts: [{ id: 'script-inline-0001', kind: 'inline', url: null, targetId: 'target-page-0001' }],
      }),
    );
    await workspace.writeArtifact(
      'raw/websocket/ws-0001/metadata.json',
      JSON.stringify({
        channelId: 'ws-0001',
        url: 'wss://10.10.8.111/stream?t=token-value',
        createdAt: '2026-09-21T10:00:09.000Z',
        requestHeaders: { cookie: 'session=abc123' },
      }),
    );

    const result = await assembleCapturePackV2({
      workspace,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      environment: { ...ENVIRONMENT },
      evidenceSummary: evidence('KVM_REACHED'),
      target: { host: '10.10.8.111', port: 443, scheme: 'https' },
    });

    const aiIndex = JSON.parse(fileOf(result, 'ai/index.json')) as {
      loginCandidateRequestIds: string[];
      kvmLaunchCandidateRequestIds: string[];
      viewerTargetIds: string[];
      dynamicScriptIds: string[];
    };
    expect(aiIndex.loginCandidateRequestIds).toEqual(['http-000002']);
    expect(aiIndex.kvmLaunchCandidateRequestIds).toEqual(['http-000004']);
    expect(aiIndex.viewerTargetIds).toEqual(['target-page-0001']);
    expect(aiIndex.dynamicScriptIds).toEqual(['script-inline-0001']);

    const dossier = JSON.parse(fileOf(result, 'ai/adapter-dossier.json')) as {
      candidateChain: Array<{ role: string; evidenceIds: string[] }>;
    };
    expect(dossier.candidateChain.map(step => step.role)).toEqual([
      'login-interaction',
      'session-established',
      'kvm-click',
      'launch-request',
      'viewer-opened',
      'script-worker-wasm',
      'realtime-channel',
    ]);
    const summary = fileOf(result, 'ai/summary.md');
    expect(summary).toContain('已按时间与因果关系派生：7 步');
    await workspace.close();
  });

  it('工作区 ai/value-flow.json 在场时优先采用：不再重复输出派生文件（无 ZIP 重复路径）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-asm-valueflow', rootDir });
    await workspace.writeArtifact('catalog/channels.json', '{"schemaVersion":"2.0.0","channels":[]}\n');
    await workspace.writeArtifact(
      'ai/value-flow.json',
      JSON.stringify({
        schemaVersion: '2.0.0',
        nodes: [
          {
            id: 'value-0001',
            kind: 'cookie',
            name: 'sid',
            evidencePath: 'raw/browser/storage.json',
          },
        ],
        edges: [
          {
            from: 'value-0001',
            to: 'value-0001',
            relation: 'propagated-to',
            evidencePath: 'raw/browser/storage.json',
          },
        ],
      }),
    );

    const result = await assembleCapturePackV2({
      workspace,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      environment: { ...ENVIRONMENT },
      evidenceSummary: evidence('TARGET_OPENED'),
      target: { host: '10.10.8.111', port: 443, scheme: 'https' },
    });

    // 工作区版本直接进包（导出器逐文件带出），派生清单不得重复输出同路径
    expect(result.files.some(file => file.path === 'ai/value-flow.json')).toBe(false);
    await workspace.close();
  });

  it('反例：工作区 ai/value-flow.json 结构非法（缺 nodes/edges 数组）时拒绝装配', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-asm-valueflow-bad', rootDir });
    await workspace.writeArtifact('catalog/channels.json', '{"schemaVersion":"2.0.0","channels":[]}\n');
    await workspace.writeArtifact('ai/value-flow.json', '{"schemaVersion":"2.0.0"}\n');

    await expect(
      assembleCapturePackV2({
        workspace,
        tool: { version: '0.3.0-dev', buildId: 'test-build' },
        environment: { ...ENVIRONMENT },
        evidenceSummary: evidence('TARGET_OPENED'),
        target: { host: '10.10.8.111', port: 443, scheme: 'https' },
      }),
    ).rejects.toThrow('ai/value-flow.json 结构非法');
    await workspace.close();
  });

  it('反例：environment 为 null 拒绝装配（manifest 不得携带编造环境）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-asm-noenv', rootDir });
    await workspace.writeArtifact('catalog/channels.json', '{"schemaVersion":"2.0.0","channels":[]}\n');

    await expect(
      assembleCapturePackV2({
        workspace,
        tool: { version: '0.3.0-dev', buildId: 'test-build' },
        environment: null,
        evidenceSummary: evidence('TARGET_OPENED'),
        target: { host: '10.10.8.111', port: 443, scheme: 'https' },
      }),
    ).rejects.toThrow('采集环境缺失');
    await workspace.close();
  });

  it('反例：catalog/channels.json 缺失时拒绝装配（先完成采集会话收尾）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-asm-nochannels', rootDir });

    await expect(
      assembleCapturePackV2({
        workspace,
        tool: { version: '0.3.0-dev', buildId: 'test-build' },
        environment: { ...ENVIRONMENT },
        evidenceSummary: evidence('TARGET_OPENED'),
        target: { host: '10.10.8.111', port: 443, scheme: 'https' },
      }),
    ).rejects.toThrow('catalog/channels.json 不可读');
    await workspace.close();
  });

  it('反例：schema 目录缺失显式报错，绝不产出无 Schema 副本的包', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-asm-noschema', rootDir });
    await workspace.writeArtifact('catalog/channels.json', '{"schemaVersion":"2.0.0","channels":[]}\n');

    await expect(
      assembleCapturePackV2({
        workspace,
        tool: { version: '0.3.0-dev', buildId: 'test-build' },
        environment: { ...ENVIRONMENT },
        evidenceSummary: evidence('TARGET_OPENED'),
        target: { host: '10.10.8.111', port: 443, scheme: 'https' },
        schemaSourceDir: join(rootDir, 'no-schema-here'),
      }),
    ).rejects.toThrow('指定的 schema 目录无效');
    await workspace.close();

    expect(resolvePackV2SchemaDir()).toContain('schema/2.0');
  });
});
