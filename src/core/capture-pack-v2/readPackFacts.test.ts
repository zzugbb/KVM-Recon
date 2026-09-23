import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import { readPackFacts } from './readPackFacts';

/**
 * 装配时事实束读取器（规范 §15）：主框架导航与观察钩子失败从
 * raw/cdp/events.jsonl 重放（与在线采集同一规则）；缺文件 / 坏行退回
 * 空维度并记缺口，不抛错（dossier 是派生物不是证据）。
 */

const roots: string[] = [];

async function newRootDir() {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-readfacts-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const TX_ROW = {
  id: 'http-000001',
  targetId: 'target-page-0001',
  startedAt: '2026-09-21T10:00:01.000Z',
  method: 'GET',
  url: 'https://kvm.test/console',
  resourceType: 'Document',
  requestHeaders: {},
  status: 200,
  responseHeaders: {},
};

describe('readPackFacts（装配时事实束读取）', () => {
  it('从工作区工件重建事实束：事务 / 动作 / target / 表面 / crypto / 脚本 / WS 握手', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-readfacts-full', rootDir });
    await workspace.writeArtifact(
      'raw/http/transactions.jsonl',
      `${JSON.stringify(TX_ROW)}\n`,
    );
    await workspace.writeArtifact(
      'raw/browser/actions.jsonl',
      `${JSON.stringify({
        id: 'action-0001',
        occurredAt: '2026-09-21T10:00:02.000Z',
        kind: 'click',
        targetId: 'target-page-0001',
        elementSummary: '#open',
      })}\n`,
    );
    await workspace.writeArtifact(
      'catalog/targets.json',
      JSON.stringify({
        schemaVersion: '2.0.0',
        targets: [{ id: 'target-page-0001', type: 'page', attached: true, url: 'https://kvm.test/' }],
      }),
    );
    await workspace.writeArtifact(
      'raw/browser/render-surfaces.jsonl',
      `${JSON.stringify({
        id: 'render-0001',
        occurredAt: '2026-09-21T10:00:03.000Z',
        targetId: 'target-page-0001',
        surface: 'canvas-context',
        detail: '2d',
      })}\n`,
    );
    await workspace.writeArtifact(
      'raw/runtime/crypto.jsonl',
      `${JSON.stringify({
        id: 'crypto-0001',
        occurredAt: '2026-09-21T10:00:00.500Z',
        targetId: 'target-page-0001',
        kind: 'digest',
        algorithm: 'SHA-256',
      })}\n`,
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
        schemaVersion: '2.0.0',
        channelId: 'ws-0001',
        url: 'wss://kvm.test/stream',
        targetId: 'target-page-0001',
        createdAt: '2026-09-21T10:00:05.000Z',
        closedAt: null,
        requestedSubProtocols: [],
        acceptedSubProtocol: null,
        extensions: [],
        closeCode: null,
        closeReason: null,
        handshakeStatus: 101,
        requestHeaders: { cookie: 'session=abc' },
        responseHeaders: {},
        frameCounts: { up: 1, down: 1 },
        framesBinPath: 'raw/websocket/ws-0001/frames.bin',
      }),
    );
    await workspace.writeArtifact('raw/websocket/ws-0001/frames.index.jsonl', '');
    // events.jsonl：主框架导航（无 parentId）+ 子框架导航（有 parentId，必须排除）
    await workspace.writeArtifact(
      'raw/cdp/events.jsonl',
      [
        JSON.stringify({
          seq: 1,
          timestamp: '2026-09-21T10:00:04.000Z',
          method: 'Page.frameNavigated',
          targetId: 'target-page-0001',
          params: { frame: { id: 'frame-0001', url: 'https://kvm.test/viewer' } },
        }),
        JSON.stringify({
          seq: 2,
          timestamp: '2026-09-21T10:00:04.100Z',
          method: 'Page.frameNavigated',
          targetId: 'target-page-0001',
          params: { frame: { id: 'frame-0002', parentId: 'frame-0001', url: 'https://kvm.test/embed' } },
        }),
        JSON.stringify({
          seq: 3,
          timestamp: '2026-09-21T10:00:04.200Z',
          method: 'Runtime.bindingCalled',
          targetId: 'target-page-0001',
          params: {
            name: 'kvmReconObserver',
            payload: JSON.stringify({
              kind: 'observer-hook-failed',
              hook: 'webrtc',
              stage: 'install',
              detail: 'RTCPeerConnection 不可观察',
            }),
          },
        }),
        JSON.stringify({
          seq: 4,
          timestamp: '2026-09-21T10:00:04.300Z',
          method: 'Runtime.bindingCalled',
          targetId: 'target-page-0001',
          params: { name: 'pageOwnBinding', payload: 'not-json-at-all' },
        }),
      ].join('\n') + '\n',
    );

    const result = await readPackFacts(workspace, {
      channels: [
        {
          id: 'ws-0001',
          kind: 'websocket',
          url: 'wss://kvm.test/stream',
          targetId: 'target-page-0001',
          createdAt: '2026-09-21T10:00:05.000Z',
          closedAt: null,
          payloadPath: 'raw/websocket/ws-0001/frames.bin',
        },
      ],
    });

    expect(result.gaps).toEqual([]);
    expect(result.facts.transactions.map(tx => tx.id)).toEqual(['http-000001']);
    expect(result.facts.actions.map(action => action.id)).toEqual(['action-0001']);
    expect(result.facts.targets.map(target => target.id)).toEqual(['target-page-0001']);
    expect(result.facts.renderSurfaces.map(surface => surface.id)).toEqual(['render-0001']);
    expect(result.facts.channels.map(channel => channel.id)).toEqual(['ws-0001']);
    expect(result.cryptoRows.map(row => row.id)).toEqual(['crypto-0001']);
    expect(result.scripts.map(script => script.id)).toEqual(['script-inline-0001']);
    // 只有主框架导航；子框架导航与在线采集规则一致地排除
    expect(result.facts.navigations).toEqual([
      { occurredAt: '2026-09-21T10:00:04.000Z', targetId: 'target-page-0001', url: 'https://kvm.test/viewer' },
    ]);
    expect(result.facts.hookFailures).toEqual([
      { hook: 'webrtc', stage: 'install', detail: 'RTCPeerConnection 不可观察' },
    ]);
    expect(result.wsHandshakes).toEqual([
      {
        channelId: 'ws-0001',
        url: 'wss://kvm.test/stream',
        createdAt: '2026-09-21T10:00:05.000Z',
        requestHeaders: { cookie: 'session=abc' },
        metadataPath: 'raw/websocket/ws-0001/metadata.json',
        framesIndexPath: 'raw/websocket/ws-0001/frames.index.jsonl',
      },
    ]);
    await workspace.close();
  });

  it('缺全部事实工件 → 各维度空数组 + 显式缺口（不抛错）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-readfacts-empty', rootDir });
    const result = await readPackFacts(workspace, { channels: [] });
    expect(result.facts.transactions).toEqual([]);
    expect(result.facts.navigations).toEqual([]);
    expect(result.facts.hookFailures).toEqual([]);
    expect(result.wsHandshakes).toEqual([]);
    expect(result.scripts).toEqual([]);
    expect(result.cryptoRows).toEqual([]);
    // 缺口必须显式列出（缺失记账红线），不能静默当「没有发生过」
    const missingPaths = result.gaps.filter(gap => gap.includes('不在包内'));
    expect(missingPaths.length).toBeGreaterThanOrEqual(7);
    await workspace.close();
  });

  it('反例：坏行 / 非法结构跳过并记缺口，好行保留', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-readfacts-broken', rootDir });
    await workspace.writeArtifact(
      'raw/http/transactions.jsonl',
      [
        JSON.stringify(TX_ROW),
        '{broken json',
        JSON.stringify({ no: 'id' }),
      ].join('\n') + '\n',
    );
    await workspace.writeArtifact('catalog/targets.json', '{"schemaVersion":"2.0.0"}\n');
    await workspace.writeArtifact(
      'raw/cdp/events.jsonl',
      [
        'not json at all',
        JSON.stringify({
          seq: 1,
          timestamp: '2026-09-21T10:00:04.000Z',
          method: 'Page.frameNavigated',
          // targetId 缺失：无法归属血缘的导航不计入
          params: { frame: { id: 'frame-0001', url: 'https://kvm.test/viewer' } },
        }),
      ].join('\n') + '\n',
    );

    const result = await readPackFacts(workspace, { channels: [] });
    expect(result.facts.transactions.map(tx => tx.id)).toEqual(['http-000001']);
    expect(result.facts.targets).toEqual([]);
    expect(result.facts.navigations).toEqual([]);
    expect(result.gaps.some(gap => gap.includes('2 行不可解析'))).toBe(true);
    expect(result.gaps.some(gap => gap.includes('catalog/targets.json 缺少 targets 数组'))).toBe(true);
    await workspace.close();
  });

  it('WS 元数据在场但帧索引缺失 → framesIndexPath 为 null（不编造路径）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-readfacts-ws', rootDir });
    await workspace.writeArtifact(
      'raw/websocket/ws-0001/metadata.json',
      JSON.stringify({
        channelId: 'ws-0001',
        url: 'wss://kvm.test/stream',
        createdAt: '2026-09-21T10:00:05.000Z',
        requestHeaders: {},
      }),
    );
    const result = await readPackFacts(workspace, { channels: [] });
    expect(result.wsHandshakes).toHaveLength(1);
    expect(result.wsHandshakes[0].framesIndexPath).toBeNull();
    await workspace.close();
  });

  it('反例：缺口超出 40 条上限 → 溢出哨兵记账，不静默截断', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-readfacts-overflow', rootDir });
    // 其余维度写空工件，保证缺口全部来自 WS 元数据
    await workspace.writeArtifact('raw/http/transactions.jsonl', '');
    await workspace.writeArtifact('raw/browser/actions.jsonl', '');
    await workspace.writeArtifact('raw/browser/render-surfaces.jsonl', '');
    await workspace.writeArtifact('raw/runtime/crypto.jsonl', '');
    await workspace.writeArtifact('catalog/targets.json', '{"schemaVersion":"2.0.0","targets":[]}');
    await workspace.writeArtifact('raw/scripts/index.json', '{"schemaVersion":"2.0.0","scripts":[]}');
    await workspace.writeArtifact('raw/cdp/events.jsonl', '');
    for (let index = 1; index <= 45; index += 1) {
      const dirId = `ws-${String(index).padStart(4, '0')}`;
      await workspace.writeArtifact(`raw/websocket/${dirId}/metadata.json`, '{broken json');
    }
    const result = await readPackFacts(workspace, { channels: [] });
    expect(result.gaps.length).toBe(41);
    expect(result.gaps.filter(gap => gap.includes('不可解析，该通道握手事实跳过')).length).toBe(40);
    expect(result.gaps[40]).toBe('派生事实缺口：另有 5 条超出 40 条上限，已聚合');
    await workspace.close();
  });
});
