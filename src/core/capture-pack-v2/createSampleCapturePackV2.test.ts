import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { deriveAdapterDossier } from '../collector/dossierEngine';
import { scanStreamForNeedles } from '../collector/chunkedNeedleScan';
import { deriveReplayPlan } from '../collector/replayEngine';
import { deriveValueFlow } from '../collector/valueFlowEngine';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import { checkPackStatus } from './packStatus';
import { checkPackV2Layout, checkStartHereContent } from './packV2Layout';
import { createSampleCapturePackV2, type SampleArtifact } from './createSampleCapturePackV2';
import { readPackFacts } from './readPackFacts';
import { validatePackV2Consistency } from './packV2Consistency';
import type { PackV2ChannelRow } from './types';

function walkFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap(name => {
    if (name.startsWith('.')) return [];
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const fullPath = join(dir, name);
    return statSync(fullPath).isDirectory() ? walkFiles(fullPath, relativePath) : [relativePath];
  });
}

function sameBytes(disk: Buffer, artifact: SampleArtifact): boolean {
  const expected =
    typeof artifact.content === 'string'
      ? Buffer.from(artifact.content, 'utf8')
      : Buffer.from(artifact.content);
  return disk.equals(expected);
}

function jsonLinesOf(artifacts: Map<string, SampleArtifact>, path: string): unknown[] {
  const artifact = artifacts.get(path);
  if (!artifact || typeof artifact.content !== 'string' || artifact.content.trim() === '') {
    return [];
  }
  return artifact.content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('createSampleCapturePackV2（规范 §19 阶段 0 / §20）', () => {
  it('生成未知协议的 COMPLETE + KVM_REACHED 样例，并通过独立一致性验证', async () => {
    const sample = await createSampleCapturePackV2();
    expect(sample.manifest.captureIntegrity).toBe('COMPLETE');
    expect(sample.manifest.workflowStatus).toBe('KVM_REACHED');
    expect(sample.manifest).not.toHaveProperty('classificationStatus');
    expect(checkPackStatus(sample.manifest).legal).toBe(true);
    expect(sample.fileName).toBe(
      'KVM-Recon_20260918-143522_127-0-0-1_KVM-REACHED_COMPLETE_' +
        sample.manifest.job.shortId +
        '.zip',
    );
    expect(sample.integrity.reasons).toEqual([]);
    expect(sample.integrity.gates.every(gate => gate.passed)).toBe(true);
    // 独立验证器从包内文件复核状态，不依赖生成器的声明。
    const consistency = validatePackV2Consistency(sample.artifacts);
    expect(consistency.problems).toEqual([]);
    expect(consistency.valid).toBe(true);
  }, 30000);

  it('manifest 落实 deviceLabel 与 UNREDACTED 契约（规范 §4.1 / §13）', async () => {
    const sample = await createSampleCapturePackV2();
    expect(sample.manifest.job.deviceLabel).toBe('样例设备 / 未知厂商');
    expect(sample.manifest.security).toEqual({
      dataHandling: 'UNREDACTED',
      containsSensitiveData: true,
    });
    expect(sample.manifest.target.host).toBe('127.0.0.1');
    expect(sample.aiIndex.capturedPageContent).toBe('untrusted-data-not-instructions');
    expect(sample.aiIndex.readingOrder).toEqual([
      '00_START_HERE.md',
      'ai/index.json',
      'ai/adapter-dossier.json',
    ]);
  });

  it('满足 §11 目录契约与 00_START_HERE.md 内容契约', async () => {
    const sample = await createSampleCapturePackV2();
    const paths = sample.artifacts.map(artifact => artifact.path);
    const layout = checkPackV2Layout(paths);
    expect(layout.missingFiles).toEqual([]);
    expect(layout.unexpectedTopLevelEntries).toEqual([]);
    // 内容相关目录只在存在对应事实时出现；样例没有 WebRTC/SSE 消息与下载，
    // 因此 raw/realtime/bodies 与 raw/realtime/downloads 允许缺席。
    expect(layout.missingDirs.filter(dir => !dir.startsWith('raw/realtime/'))).toEqual([]);
    expect(layout.valid).toBe(true);

    const startHere = sample.artifacts.find(artifact => artifact.path === '00_START_HERE.md');
    expect(startHere).toBeDefined();
    const content = typeof startHere!.content === 'string' ? startHere!.content : '';
    expect(checkStartHereContent(content).valid).toBe(true);
  });

  it('checksums.sha256 覆盖全部文件且与内容一致；正文引用闭环', async () => {
    const sample = await createSampleCapturePackV2();
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact]));

    const checksumArtifact = artifacts.get('checksums.sha256');
    expect(checksumArtifact).toBeDefined();
    const lines = (checksumArtifact!.content as string)
      .split('\n')
      .filter(Boolean)
      .map(line => line.split('  ', 2));
    expect(lines).toHaveLength(sample.artifacts.length - 1);
    for (const [digest, path] of lines) {
      const artifact = artifacts.get(path);
      expect(artifact, path).toBeDefined();
      const bytes =
        typeof artifact!.content === 'string'
          ? Buffer.from(artifact!.content, 'utf8')
          : Buffer.from(artifact!.content);
      expect(digest, path).toBe(createHash('sha256').update(bytes).digest('hex'));
    }

    // 资源行引用的正文 blob 全部在包内，sha256 一致（引用闭环，规范 §14 条件 9）。
    const resourceRows = jsonLinesOf(artifacts, 'catalog/resources.jsonl') as Array<{
      id: string;
      responseBody?: { sha256: string; path: string };
      requestBody?: { sha256: string; path: string };
    }>;
    expect(resourceRows).toHaveLength(6);
    for (const row of resourceRows) {
      for (const ref of [row.requestBody, row.responseBody]) {
        if (!ref) continue;
        const bodyArtifact = artifacts.get(ref.path);
        expect(bodyArtifact, `${row.id} → ${ref.path}`).toBeDefined();
        const bytes =
          typeof bodyArtifact!.content === 'string'
            ? Buffer.from(bodyArtifact!.content, 'utf8')
            : Buffer.from(bodyArtifact!.content);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256);
      }
    }
  });

  it('完整 WebSocket 双向帧：索引偏移、FIN 与 frames.bin 载荷一致，关闭码保留', async () => {
    const sample = await createSampleCapturePackV2();
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact]));
    const frameIndex = jsonLinesOf(artifacts, 'raw/websocket/ws-0001/frames.index.jsonl') as Array<{
      frameIndex: number;
      direction: 'up' | 'down';
      opcode: string;
      fin: boolean;
      payloadOffset: number;
      payloadLength: number;
    }>;
    const framesBin = artifacts.get('raw/websocket/ws-0001/frames.bin');
    expect(framesBin).toBeDefined();
    const bin = Buffer.from(framesBin!.content as Uint8Array);

    expect(frameIndex).toHaveLength(7);
    expect(frameIndex.filter(frame => frame.direction === 'down')).toHaveLength(5);
    expect(frameIndex.filter(frame => frame.direction === 'up')).toHaveLength(2);
    expect(frameIndex.every(frame => frame.fin)).toBe(true);

    let offset = 0;
    for (const frame of frameIndex) {
      expect(frame.frameIndex).toBe(offset === 0 ? 0 : frameIndex[frame.frameIndex - 1].frameIndex + 1);
      expect(frame.payloadOffset).toBe(offset);
      expect(bin.subarray(frame.payloadOffset, frame.payloadOffset + frame.payloadLength).length).toBe(
        frame.payloadLength,
      );
      offset += frame.payloadLength;
    }
    expect(offset).toBe(bin.length);

    const metadata = JSON.parse(String(artifacts.get('raw/websocket/ws-0001/metadata.json')!.content));
    expect(metadata.handshakeStatus).toBe(101);
    expect(metadata.url).toContain('ws://127.0.0.1:48080/');
    expect(metadata.extensions).toEqual([]);
    expect(metadata.closeCode).toBe(1000);
    expect(metadata.closeReason).toBe('sample-done');
  }, 30000);

  it('HTTP 事务保存发起栈、Referer、时序与连接信息（规范 §8.2）', async () => {
    const sample = await createSampleCapturePackV2();
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact]));
    const transactions = jsonLinesOf(artifacts, 'raw/http/transactions.jsonl') as Array<{
      id: string;
      frameId: string;
      windowId: string;
      initiator: { type: string; url?: string; stackTrace?: unknown[] };
      referer?: string;
      timing: { sendMs: number; waitMs: number; receiveMs: number };
      connectionId: string;
      remotePort: number;
      contentEncoding: string | null;
    }>;
    expect(transactions).toHaveLength(6);
    for (const transaction of transactions) {
      expect(transaction.frameId).toBeTruthy();
      expect(transaction.windowId).toBeTruthy();
      expect(transaction.initiator.type).toBeTruthy();
      expect(transaction.timing.sendMs).toBeGreaterThanOrEqual(0);
      expect(transaction.connectionId).toBeTruthy();
      expect(transaction.remotePort).toBe(48080);
    }
    const login = transactions.find(row => row.id === 'http-000002')!;
    expect(login.initiator.stackTrace).toBeDefined();
    expect(login.referer).toContain('http://127.0.0.1:48080/');
    const launch = transactions.find(row => row.id === 'http-000004')!;
    expect(launch.initiator.url).toContain('http://127.0.0.1:48080/');
  }, 30000);

  it('AI 入口引用闭环：dossier 链覆盖全部角色且证据 ID 在包内可定位', async () => {
    const sample = await createSampleCapturePackV2();
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact]));
    const dossier = JSON.parse(String(artifacts.get('ai/adapter-dossier.json')!.content)) as {
      candidateChain: Array<{ role: string; evidenceIds: string[]; evidencePaths: string[] }>;
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

    const knownIds = new Set<string>();
    for (const row of jsonLinesOf(artifacts, 'catalog/resources.jsonl') as Array<{ id: string }>) {
      knownIds.add(row.id);
    }
    for (const row of jsonLinesOf(artifacts, 'catalog/relations.jsonl') as Array<{ from: string; to: string }>) {
      knownIds.add(row.from);
      knownIds.add(row.to);
    }
    for (const target of (
      JSON.parse(String(artifacts.get('catalog/targets.json')!.content)) as { targets: Array<{ id: string }> }
    ).targets) {
      knownIds.add(target.id);
    }
    for (const channel of (
      JSON.parse(String(artifacts.get('catalog/channels.json')!.content)) as { channels: Array<{ id: string }> }
    ).channels) {
      knownIds.add(channel.id);
    }
    for (const script of (
      JSON.parse(String(artifacts.get('raw/scripts/index.json')!.content)) as { scripts: Array<{ id: string }> }
    ).scripts) {
      knownIds.add(script.id);
    }
    for (const value of (
      JSON.parse(String(artifacts.get('ai/value-flow.json')!.content)) as { nodes: Array<{ id: string }> }
    ).nodes) {
      knownIds.add(value.id);
    }
    for (const action of jsonLinesOf(artifacts, 'raw/browser/actions.jsonl') as Array<{ id: string }>) {
      knownIds.add(action.id);
    }
    for (const cryptoCall of jsonLinesOf(artifacts, 'raw/runtime/crypto.jsonl') as Array<{ id: string }>) {
      knownIds.add(cryptoCall.id);
    }

    for (const step of dossier.candidateChain) {
      expect(step.evidenceIds.length, step.role).toBeGreaterThan(0);
      for (const evidenceId of step.evidenceIds) {
        expect(knownIds.has(evidenceId), `${step.role}: ${evidenceId}`).toBe(true);
      }
      for (const evidencePath of step.evidencePaths) {
        expect(artifacts.has(evidencePath), `${step.role}: ${evidencePath}`).toBe(true);
      }
    }
  });

  it('Replay 动态值语义：只引用请求发生前已存在的值，不引用本次响应产物', async () => {
    const sample = await createSampleCapturePackV2();
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact]));
    const valueFlow = JSON.parse(String(artifacts.get('ai/value-flow.json')!.content)) as {
      nodes: Array<{ id: string; kind: string; name: string; evidenceId?: string }>;
    };
    const nodesById = new Map(valueFlow.nodes.map(node => [node.id, node]));
    const replay = JSON.parse(
      String(artifacts.get('replay/manifest.json')!.content),
    ) as {
      requests: Array<{ requestId: string; requiresDynamicValueIds: string[] }>;
    };
    const byRequestId = new Map(replay.requests.map(request => [request.requestId, request]));

    // 登录请求依赖摘要输出（crypto-0001 的输出字节被观察喂入登录正文）；
    // 不依赖登录响应才签发的 Session Cookie 值（无 cookie / header 节点）。
    const login = byRequestId.get('http-000002')!;
    expect(login.requiresDynamicValueIds).toHaveLength(1);
    const loginValue = nodesById.get(login.requiresDynamicValueIds[0])!;
    expect(loginValue.kind).toBe('crypto-output');
    expect(loginValue.evidenceId).toBe('crypto-0001');
    expect(
      login.requiresDynamicValueIds.some(id => nodesById.get(id)?.kind === 'cookie'),
      '登录请求不得依赖登录响应才产生的 Session Cookie',
    ).toBe(false);

    // KVM 启动请求依赖已建立的 Session Cookie（cookie 节点）与登录响应
    // 存入 sessionStorage 的 csrfToken（storage 值链节点）；不依赖本次响应
    // 才产生的 viewerToken（无 evidenceId=http-000004 的响应正文节点）。
    const launch = byRequestId.get('http-000004')!;
    expect(launch.requiresDynamicValueIds).toHaveLength(2);
    expect(launch.requiresDynamicValueIds.map(id => nodesById.get(id)!.kind).sort()).toEqual([
      'cookie',
      'storage',
    ]);
    const csrfStorageId = launch.requiresDynamicValueIds.find(
      id => nodesById.get(id)?.kind === 'storage',
    )!;
    const storageFile = JSON.parse(String(artifacts.get('raw/browser/storage.json')!.content)) as {
      sessionStorage: Record<string, string>;
    };
    const csrfStorageKey = nodesById.get(csrfStorageId)!.name.split('（')[0];
    // storage 节点对应页面真实写入的 sessionStorage 条目，其值逐字节等于
    // 启动请求实际携带的 CSRF 头值（同一事实，不是两份手写数据）。
    expect(storageFile.sessionStorage[csrfStorageKey]).toBeTruthy();
    const transactions = jsonLinesOf(artifacts, 'raw/http/transactions.jsonl') as Array<{
      id: string;
      requestHeaders: Record<string, string>;
    }>;
    const launchTx = transactions.find(row => row.id === 'http-000004')!;
    const csrfHeader = Object.entries(launchTx.requestHeaders).find(([name]) =>
      name.endsWith('-csrf'),
    )!;
    expect(storageFile.sessionStorage[csrfStorageKey]).toBe(csrfHeader[1]);
    expect(
      launch.requiresDynamicValueIds.some(id => nodesById.get(id)?.evidenceId === 'http-000004'),
      '启动请求不得依赖本次响应才产生的 viewerToken',
    ).toBe(false);

    // crypto 调用绑定登录页内联脚本（脚本本体在脚本索引中可解析）。
    const cryptoRows = jsonLinesOf(artifacts, 'raw/runtime/crypto.jsonl') as Array<{
      id: string;
      scriptId: string;
      algorithm: string;
      inputRef?: { path: string };
      outputRef?: { path: string };
    }>;
    expect(cryptoRows).toHaveLength(1);
    expect(cryptoRows[0].algorithm).toBe('SHA-256');
    expect(cryptoRows[0].scriptId).toBe('script-inline-0000');
    const scriptIds = new Set(
      (
        JSON.parse(String(artifacts.get('raw/scripts/index.json')!.content)) as {
          scripts: Array<{ id: string }>;
        }
      ).scripts.map(script => script.id),
    );
    expect(scriptIds.has(cryptoRows[0].scriptId)).toBe(true);
    expect(artifacts.has(cryptoRows[0].inputRef?.path || '')).toBe(true);
    expect(artifacts.has(cryptoRows[0].outputRef?.path || '')).toBe(true);
  }, 30000);

  it('样例证据与 Mock 实际协议一致：启动带 CSRF 头、WS 握手带 Cookie 与 token、无编造关系', async () => {
    const sample = await createSampleCapturePackV2();
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact]));

    // KVM 启动请求（http-000004）实际携带 CSRF 头（服务端缺失/错误一律 403）。
    const transactions = jsonLinesOf(artifacts, 'raw/http/transactions.jsonl') as Array<{
      id: string;
      requestHeaders: Record<string, string>;
      status: number;
    }>;
    const launch = transactions.find(row => row.id === 'http-000004')!;
    expect(launch.status).toBe(200);
    const csrfHeaderNames = Object.keys(launch.requestHeaders).filter(name => name.endsWith('-csrf'));
    expect(csrfHeaderNames).toHaveLength(1);
    expect(launch.requestHeaders[csrfHeaderNames[0]]).toBeTruthy();

    // WS 握手事实：URL 查询参数 t 携带 viewerToken，Cookie 头携带会话。
    const metadata = JSON.parse(String(artifacts.get('raw/websocket/ws-0001/metadata.json')!.content)) as {
      url: string;
      requestHeaders: Record<string, string>;
    };
    expect(metadata.url).toContain('?t=');
    expect(metadata.requestHeaders.cookie).toContain('=');
    // 会话 Cookie 与启动请求携带的一致（同一事实，不是两份手写数据）。
    expect(metadata.requestHeaders.cookie).toBe(launch.requestHeaders.cookie);

    // 无法证明的关系不编造：页面分别创建 Worker 与 WS，不存在 attached 关系。
    const relations = jsonLinesOf(artifacts, 'catalog/relations.jsonl') as Array<{
      from: string;
      to: string;
      relation: string;
    }>;
    expect(relations.some(relation => relation.relation === 'attached')).toBe(false);

    // value-flow：viewerToken 有两条被观察的传播路径——启动响应正文直接
    // 进 WS 握手查询参数 t，以及先存 sessionStorage 再进查询参数（中转跳）。
    const valueFlow = JSON.parse(String(artifacts.get('ai/value-flow.json')!.content)) as {
      nodes: Array<{ id: string; kind: string; name: string; evidenceId?: string }>;
      edges: Array<{ from: string; to: string; relation: string }>;
    };
    const nodesById = new Map(valueFlow.nodes.map(node => [node.id, node]));
    const urlParamNode = valueFlow.nodes.find(
      node => node.kind === 'url-param' && node.evidenceId === 'ws-0001',
    );
    expect(urlParamNode).toBeDefined();
    const launchResponseNode = valueFlow.nodes.find(
      node =>
        node.kind === 'http-response' &&
        node.evidenceId === 'http-000004' &&
        valueFlow.edges.some(
          edge =>
            edge.from === node.id &&
            edge.to === urlParamNode!.id &&
            edge.relation === 'propagated-to',
        ),
    );
    expect(launchResponseNode).toBeDefined();
    const storageHopNode = valueFlow.nodes.find(
      node =>
        node.kind === 'storage' &&
        valueFlow.edges.some(
          edge =>
            edge.from === node.id &&
            edge.to === urlParamNode!.id &&
            edge.relation === 'propagated-to',
        ),
    );
    expect(storageHopNode).toBeDefined();
    // 查询参数 t 的值逐字节等于 viewerToken（storage 快照里的真实条目）。
    const urlParam = new URL(metadata.url).searchParams.get('t')!;
    const storageFile = JSON.parse(String(artifacts.get('raw/browser/storage.json')!.content)) as {
      sessionStorage: Record<string, string>;
    };
    const storageKey = storageHopNode!.name.split('（')[0];
    expect(storageFile.sessionStorage[storageKey]).toBe(urlParam);

    // 页面脚本实际写入 sessionStorage 的 csrfToken / viewerToken 已采集。
    expect(Object.keys(storageFile.sessionStorage)).toHaveLength(2);
    for (const value of Object.values(storageFile.sessionStorage)) {
      expect(value).toBeTruthy();
    }

    // Replay 通道声明 WS 握手实际依赖的动态值：Session Cookie（cookie
    // 节点）+ viewerToken 的两个来源（启动响应正文 + storage 值）。
    const replayManifest = JSON.parse(String(artifacts.get('replay/manifest.json')!.content)) as {
      channels: Array<{ channelId: string; requiresDynamicValueIds: string[] }>;
    };
    const wsReplay = replayManifest.channels.find(channel => channel.channelId === 'ws-0001')!;
    expect(wsReplay.requiresDynamicValueIds).toHaveLength(3);
    expect(
      wsReplay.requiresDynamicValueIds.map(id => nodesById.get(id)!.kind).sort(),
    ).toEqual(['cookie', 'http-response', 'storage']);
    expect(wsReplay.requiresDynamicValueIds).toContain(launchResponseNode!.id);
    expect(wsReplay.requiresDynamicValueIds).toContain(storageHopNode!.id);
  }, 30000);

  it('离线再生契约（规范 §15）：只凭包内工件重新派生得到相同的 ai/ 与 replay/ 内容', async () => {
    const sample = await createSampleCapturePackV2();
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact]));
    const bufferOf = (path: string): Buffer => {
      const artifact = artifacts.get(path);
      if (!artifact) throw new Error(`样例包缺少 ${path}`);
      return typeof artifact.content === 'string'
        ? Buffer.from(artifact.content, 'utf8')
        : Buffer.from(artifact.content);
    };
    // readPackFacts 只依赖 readArtifact / openArtifactStream / artifactPaths
    // 三个只读口；这里用包内工件构造一个最小只读工作区（离线 Analyzer 视角）。
    const packWorkspace = {
      readArtifact: async (path: string) => bufferOf(path),
      openArtifactStream: async (path: string) => Readable.from([bufferOf(path)]),
      artifactPaths: async () => [...artifacts.keys()],
    } as unknown as JobWorkspace;

    const channelsFile = JSON.parse(String(artifacts.get('catalog/channels.json')!.content)) as {
      channels: PackV2ChannelRow[];
    };
    const packFacts = await readPackFacts(packWorkspace, { channels: channelsFile.channels });
    // 样例包工件齐全：事实束重建无缺口。
    expect(packFacts.gaps).toEqual([]);
    // 主框架导航从 raw/cdp/events.jsonl 离线重放（Page.frameNavigated 且
    // frame 无 parentId，与在线采集同一规则）。
    expect(packFacts.facts.navigations).toHaveLength(3);

    // 值传播图：storage 快照 + 通道握手事实 + 包内正文 blob 重新派生，
    // 与生成时写入的 ai/value-flow.json 逐字节等价。
    const storageFile = JSON.parse(String(artifacts.get('raw/browser/storage.json')!.content)) as {
      capturedAt: string;
      cookies: Array<Record<string, unknown>>;
      sessionStorage: Record<string, string>;
      localStorage: Record<string, string>;
    };
    const derivedFlow = await deriveValueFlow(
      {
        transactions: packFacts.facts.transactions,
        cryptoRows: packFacts.cryptoRows,
        wsChannels: packFacts.wsHandshakes.map(handshake => ({
          channelId: handshake.channelId,
          url: handshake.url,
          createdAt: handshake.createdAt,
          requestHeaders: handshake.requestHeaders,
          metadataPath: handshake.metadataPath,
        })),
        storageCookies: storageFile.cookies
          .map(cookie => ({ name: cookie.name, value: cookie.value }))
          .filter(
            (cookie): cookie is { name: string; value: string } =>
              typeof cookie.name === 'string' && typeof cookie.value === 'string',
          ),
        storageValues: [
          ...Object.entries(storageFile.sessionStorage),
          ...Object.entries(storageFile.localStorage),
        ].map(([key, value]) => ({ key, value })),
        storageCapturedAt: storageFile.capturedAt,
      },
      {
        readBody: async ref => bufferOf(ref.path),
        scanBody: async (ref, needles) => {
          const body = bufferOf(ref.path);
          if (body === null) return null;
          if (needles.length === 0) return new Set<Buffer>();
          return scanStreamForNeedles(Readable.from([body]), needles);
        },
      },
    );
    expect(derivedFlow.valueFlow).toEqual(
      JSON.parse(String(artifacts.get('ai/value-flow.json')!.content)),
    );

    // 适配候选链与 ai/index 候选列表由同一引擎从包内事实派生，结果一致。
    const dossier = deriveAdapterDossier({
      facts: packFacts.facts,
      cryptoRows: packFacts.cryptoRows,
      scripts: packFacts.scripts,
      valueFlow: derivedFlow.valueFlow,
      wsHandshakes: packFacts.wsHandshakes,
    });
    expect(dossier.candidateChain).toEqual(
      JSON.parse(String(artifacts.get('ai/adapter-dossier.json')!.content)).candidateChain,
    );
    const aiIndex = JSON.parse(String(artifacts.get('ai/index.json')!.content));
    expect(dossier.loginCandidateRequestIds).toEqual(aiIndex.loginCandidateRequestIds);
    expect(dossier.kvmLaunchCandidateRequestIds).toEqual(aiIndex.kvmLaunchCandidateRequestIds);
    expect(dossier.viewerTargetIds).toEqual(aiIndex.viewerTargetIds);
    expect(dossier.dynamicScriptIds).toEqual(aiIndex.dynamicScriptIds);
    expect(dossier.workerIds).toEqual(aiIndex.workerIds);
    expect(dossier.wasmIds).toEqual(aiIndex.wasmIds);

    // Replay 三件套同样离线再生一致（§16 派生可再生）。
    const replay = deriveReplayPlan({
      facts: packFacts.facts,
      dossier,
      valueFlow: derivedFlow.valueFlow,
      wsHandshakes: packFacts.wsHandshakes,
    });
    expect(replay.manifest).toEqual(
      JSON.parse(String(artifacts.get('replay/manifest.json')!.content)),
    );
    expect(replay.httpRows).toEqual(jsonLinesOf(artifacts, 'replay/http.jsonl'));
    expect(replay.channelsFile.channels).toEqual(
      JSON.parse(String(artifacts.get('replay/channels.json')!.content)).channels,
    );
  }, 30000);

  it('固定 seed 输出逐字节确定（端口无关）', async () => {
    const first = await createSampleCapturePackV2();
    const second = await createSampleCapturePackV2();
    expect(second.artifacts.map(artifact => artifact.path)).toEqual(
      first.artifacts.map(artifact => artifact.path),
    );
    for (let index = 0; index < first.artifacts.length; index += 1) {
      const left = first.artifacts[index];
      const right = second.artifacts[index];
      expect(right.path).toBe(left.path);
      const leftBytes =
        typeof left.content === 'string' ? Buffer.from(left.content, 'utf8') : Buffer.from(left.content);
      const rightBytes =
        typeof right.content === 'string' ? Buffer.from(right.content, 'utf8') : Buffer.from(right.content);
      expect(rightBytes.equals(leftBytes), left.path).toBe(true);
    }
    expect(second.fileName).toBe(first.fileName);
  });

  it('与 examples/capture-pack-v2 磁盘样例保持同步', async () => {
    const sample = await createSampleCapturePackV2();
    const root = join(process.cwd(), 'examples/capture-pack-v2');

    // 开发期再生成磁盘样例：
    //   KVM_RECON_WRITE_SAMPLE_PACK_V2=1 npx vitest run createSampleCapturePackV2
    if (process.env.KVM_RECON_WRITE_SAMPLE_PACK_V2 === '1') {
      for (const artifact of sample.artifacts) {
        const fullPath = join(root, artifact.path);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(
          fullPath,
          typeof artifact.content === 'string'
            ? artifact.content
            : Buffer.from(artifact.content),
        );
      }
    }

    const diskFiles = walkFiles(root).sort();
    expect(diskFiles).toEqual(sample.artifacts.map(artifact => artifact.path).sort());
    for (const artifact of sample.artifacts) {
      const disk = readFileSync(join(root, artifact.path));
      expect(sameBytes(disk, artifact), `${artifact.path} 必须与 createSampleCapturePackV2() 一致`).toBe(
        true,
      );
    }
  }, 30000);
});
