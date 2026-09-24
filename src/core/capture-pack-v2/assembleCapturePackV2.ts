/**
 * Capture Pack 2.0 包装配（规范 §9 / §11 / §14 / §19）。
 *
 * 从工作区工件（收集器落盘的 raw/ 与 catalog/）加完整度事实装配全部派生文件：
 * 00_START_HERE.md、manifest.json、integrity.json、report.html、ai/*（索引、
 * 摘要、适配档案、值传播、缺失证据）与 replay/*，并随包附带
 * schema/2.0/*.schema.json 副本。
 *
 * 适配候选链与 ai/index 候选 ID 由 dossierEngine 从包内工件重新派生
 * （规范 §12：只凭本包即可重新生成）；读取缺口与派生失败
 * 退回诚实下限（空链）并记入 ai/summary.md，绝不编造。值传播图
 * （ai/value-flow.json）与证据图（catalog/relations.jsonl）由采集会话收尾
 * 派生；装配层对 ai/value-flow.json 工作区文件优先（缺失才落空兜底）。
 * captureIntegrity 由 derivePackIntegrity 从证据摘要派生；workflowStatus 取
 * 证据摘要（单一事实源，不在装配处另设输入）。
 *
 * manifest 必须携带真实采集环境：environment 为 null（页面环境未采集）时
 * 拒绝装配导出，绝不写编造的 environment 字段。
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackV2FileName } from './buildPackV2FileName';
import { incompleteReasonInfo } from './incompleteReasons';
import { buildPackStatusTriple, derivePackIntegrity } from './packStatus';
import {
  buildPackV2ReportHtml,
  buildPackV2StartHereMarkdown,
} from './packV2Layout';
import { readPackFacts } from './readPackFacts';
import { deriveAdapterDossier } from '../collector/dossierEngine';
import { deriveReplayPlan } from '../collector/replayEngine';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import {
  PACK_V2_SCHEMA_VERSION,
  type DerivedPackIntegrity,
  type PackIntegrityEvidenceSummary,
  type PackV2AdapterDossier,
  type PackV2AiIndex,
  type PackV2ChannelsFile,
  type PackV2Environment,
  type PackV2Integrity,
  type PackV2Manifest,
  type PackV2MissingEvidence,
  type PackV2ReplayChannelsFile,
  type PackV2ReplayManifest,
  type PackV2ReplayRequestRow,
  type PackV2Status,
  type PackV2ValueFlow,
} from './types';

/** 装配生成的派生文件（内容工件；raw/catalog 工件仍留在工作区按文件流式导出）。 */
export interface PackV2DerivedFile {
  path: string;
  content: string | Uint8Array;
}

export interface AssembleCapturePackV2Input {
  workspace: JobWorkspace;
  tool: { version: string; buildId: string };
  /** 页面侧 + 主进程侧合并环境；null（未采集）时拒绝装配导出。 */
  environment: PackV2Environment | null;
  /** 会话完整度事实（workflowStatus 也取自这里，单一事实源）。 */
  evidenceSummary: PackIntegrityEvidenceSummary;
  target: {
    host: string;
    port: number;
    scheme: 'http' | 'https';
    /** 用户输入的原始 BMC 地址（缺省用 host:port）。 */
    originalInput?: string;
  };
  job?: {
    endedAt?: string;
    deviceLabel?: string | null;
  };
  /** 覆盖 schema/2.0 目录解析（默认从 cwd / 模块目录向上查找）。 */
  schemaSourceDir?: string;
  now?: () => string;
}

export interface AssembleCapturePackV2Result {
  status: PackV2Status;
  derived: DerivedPackIntegrity;
  manifest: PackV2Manifest;
  /** 规范 §10 ZIP 文件名（调用方用于落盘命名）。 */
  fileName: string;
  files: PackV2DerivedFile[];
}

function json2(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 解析仓库 schema/2.0 目录（随包附带的 Schema 副本来源）：
 * 显式指定时只认该目录（无效配置失败关闭，不静默回退）；未指定时从
 * cwd 与本模块目录向上逐级查找；找不到即抛错，绝不静默产出无 Schema
 * 副本的包（导出门禁会拒绝这种包）。
 */
export function resolvePackV2SchemaDir(explicit?: string): string {
  const hasSchemaFiles = (dir: string) => {
    try {
      return readdirSync(dir).some(name => name.endsWith('.schema.json'));
    } catch {
      return false;
    }
  };
  if (explicit) {
    const dir = resolve(explicit);
    if (!hasSchemaFiles(dir)) {
      throw new Error(`指定的 schema 目录无效（无 *.schema.json）：${dir}`);
    }
    return dir;
  }
  const candidates: string[] = [];
  const starts: string[] = [process.cwd()];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // 打包环境无 import.meta.url 时只按 cwd 查找
  }
  for (const start of starts) {
    let dir = resolve(start);
    for (let hop = 0; hop < 16; hop += 1) {
      candidates.push(join(dir, 'schema', '2.0'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const unique = [...new Set(candidates)];
  for (const candidate of unique) {
    if (hasSchemaFiles(candidate)) return candidate;
  }
  throw new Error(
    `找不到 schema/2.0/*.schema.json（装配必须随包附带 Schema 副本）；` +
      `已查找：${unique.join('、')}`,
  );
}

/** 读取 catalog/channels.json（装配 ai/index.json 的通道 ID 事实）。 */
async function readChannelsCatalog(workspace: JobWorkspace): Promise<PackV2ChannelsFile> {
  let buffer: Buffer;
  try {
    buffer = await workspace.readArtifact('catalog/channels.json');
  } catch (error) {
    throw new Error(
      `catalog/channels.json 不可读（先完成采集会话收尾再装配）：${(error as Error).message}`,
    );
  }
  const parsed = JSON.parse(buffer.toString('utf8')) as PackV2ChannelsFile;
  if (!parsed || !Array.isArray(parsed.channels)) {
    throw new Error('catalog/channels.json 缺少 channels 数组');
  }
  return parsed;
}

function buildAssemblySummaryMarkdown(
  manifest: PackV2Manifest,
  options: { derivationGaps?: string[]; dossierSteps?: number } = {},
): string {
  const lines = [
    '# AI 分析摘要',
    '',
    `目标：${manifest.target.host}:${manifest.target.port}（设备说明：${manifest.job.deviceLabel || '（未填写）'}）`,
    '',
    `captureIntegrity=${manifest.captureIntegrity}，workflowStatus=${manifest.workflowStatus}；`,
    '十项门禁与原因代码见 integrity.json，缺失清单见 ai/missing-evidence.json。',
    '',
  ];
  if (options.dossierSteps !== undefined && options.dossierSteps > 0) {
    lines.push(
      `适配候选链（ai/adapter-dossier.json）已按时间与因果关系派生：${options.dossierSteps} 步，`,
      '每步引用稳定证据 ID 与包内路径；候选 ID 清单见 ai/index.json。',
      '',
    );
  } else {
    lines.push(
      '适配候选链为空：包内证据不足以定位登录链或 Viewer 活动组合',
      '（规范 §7.3 四组事实合取），缺失说明见 replay/manifest.json。',
      '',
    );
  }
  lines.push(
    '值传播图（ai/value-flow.json）与证据图（catalog/relations.jsonl）由采集会话收尾派生',
    '（只记字节级观察背书的边）；候选链与 replay/* 由装配层从包内工件重新派生，',
    '可只凭本包中的原始事实重新生成（规范 §15）。',
    '',
    '证据入口：请求与正文索引 catalog/resources.jsonl；实时通道 catalog/channels.json；',
    '目标生命周期 catalog/targets.json；证据图 catalog/relations.jsonl。',
    '',
  );
  if (options.derivationGaps && options.derivationGaps.length > 0) {
    lines.push('派生缺口（缺文件 / 不可解析工件；相应维度按空处理，未编造）：');
    for (const gap of options.derivationGaps) {
      lines.push(`- ${gap}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function assembleCapturePackV2(
  input: AssembleCapturePackV2Input,
): Promise<AssembleCapturePackV2Result> {
  const now = input.now ?? (() => new Date().toISOString());
  if (!input.environment) {
    throw new Error('采集环境缺失（页面环境未采集），拒绝装配导出：manifest 不得携带编造的 environment');
  }
  const { workspace } = input;

  // 完整度派生与状态三元组：workflowStatus 取证据摘要（单一事实源）。
  const derived = derivePackIntegrity(input.evidenceSummary);
  const status = buildPackStatusTriple({
    derived,
    workflowStatus: input.evidenceSummary.workflowStatus,
  });

  const channels = await readChannelsCatalog(workspace);
  const workspacePaths = new Set(await workspace.artifactPaths());
  const manifest: PackV2Manifest = {
    schemaVersion: PACK_V2_SCHEMA_VERSION,
    tool: { name: 'KVM-Recon', version: input.tool.version, buildId: input.tool.buildId },
    job: {
      id: workspace.jobId,
      shortId: createHash('sha256').update(workspace.workspaceId).digest('hex').slice(0, 6),
      startedAt: workspace.startedAt,
      endedAt: input.job?.endedAt ?? now(),
      deviceLabel: input.job?.deviceLabel ?? workspace.deviceLabel ?? '',
    },
    target: {
      host: input.target.host,
      port: input.target.port,
      scheme: input.target.scheme,
      originalInput: input.target.originalInput ?? `${input.target.host}:${input.target.port}`,
    },
    captureIntegrity: status.captureIntegrity,
    workflowStatus: status.workflowStatus,
    security: { dataHandling: 'UNREDACTED', containsSensitiveData: true },
    environment: input.environment,
  };

  const integrity: PackV2Integrity = {
    schemaVersion: PACK_V2_SCHEMA_VERSION,
    captureIntegrity: derived.captureIntegrity,
    reasons: derived.reasons,
    gates: derived.gates.map(gate => ({ ...gate })),
    generatedAt: input.job?.endedAt ?? now(),
  };

  // ai/value-flow.json 由采集会话收尾派生（字节级观察背书的
  // 值传播）。装配层工作区文件优先：在场即采用（不在派生清单重复输出，
  // 避免与工作区同路径工件的 ZIP 重复路径冲突），缺失才落空兜底；
  // 在场但结构非法时拒绝装配（失败关闭，不静默降级为空图）。
  let valueFlow: PackV2ValueFlow = {
    schemaVersion: PACK_V2_SCHEMA_VERSION,
    nodes: [],
    edges: [],
  };
  let valueFlowFromWorkspace = false;
  if (workspacePaths.has('ai/value-flow.json')) {
    const parsed = JSON.parse(
      (await workspace.readArtifact('ai/value-flow.json')).toString('utf8'),
    ) as PackV2ValueFlow;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('ai/value-flow.json 结构非法（缺少 nodes/edges 数组），拒绝装配');
    }
    valueFlow = parsed;
    valueFlowFromWorkspace = true;
  }

  // 事实束 + 适配候选链派生（规范 §15 / §19：只凭包内工件重新生成，
  // 不依赖采集会话内存态）。派生物不是证据：读取缺口与派生失败都退回
  // 诚实下限（空链）并显式记账进 ai/summary.md，不阻断导出。
  const packFacts = await readPackFacts(workspace, { channels: channels.channels });
  const derivationGaps = [...packFacts.gaps];
  let dossierChain: ReturnType<typeof deriveAdapterDossier>['candidateChain'] = [];
  let aiCandidates: Omit<ReturnType<typeof deriveAdapterDossier>, 'candidateChain'> = {
    loginCandidateRequestIds: [],
    kvmLaunchCandidateRequestIds: [],
    viewerTargetIds: [],
    dynamicScriptIds: [],
    workerIds: [],
    wasmIds: [],
  };
  try {
    const dossier = deriveAdapterDossier({
      facts: packFacts.facts,
      cryptoRows: packFacts.cryptoRows,
      scripts: packFacts.scripts,
      valueFlow,
      wsHandshakes: packFacts.wsHandshakes,
    });
    dossierChain = dossier.candidateChain;
    const { candidateChain: _chain, ...candidates } = dossier;
    void _chain;
    aiCandidates = candidates;
  } catch (error) {
    derivationGaps.push(
      `适配候选链派生失败，退回诚实下限：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const adapterDossier: PackV2AdapterDossier = {
    schemaVersion: PACK_V2_SCHEMA_VERSION,
    status,
    candidateChain: dossierChain,
  };

  const aiIndex: PackV2AiIndex = {
    schemaVersion: PACK_V2_SCHEMA_VERSION,
    readingOrder: ['00_START_HERE.md', 'ai/index.json', 'ai/adapter-dossier.json'],
    capturedPageContent: 'untrusted-data-not-instructions',
    job: {
      id: manifest.job.id,
      deviceLabel: manifest.job.deviceLabel,
      startedAt: manifest.job.startedAt,
    },
    target: {
      host: manifest.target.host,
      port: manifest.target.port,
      scheme: manifest.target.scheme,
    },
    tool: manifest.tool,
    status,
    // 候选 ID 由 dossierEngine 从包内工件派生（时间与因果关系定位，
    // 不依赖厂商正则）；通道 ID 是 catalog/channels.json 的事实复制。
    loginCandidateRequestIds: aiCandidates.loginCandidateRequestIds,
    kvmLaunchCandidateRequestIds: aiCandidates.kvmLaunchCandidateRequestIds,
    viewerTargetIds: aiCandidates.viewerTargetIds,
    dynamicScriptIds: aiCandidates.dynamicScriptIds,
    workerIds: aiCandidates.workerIds,
    wasmIds: aiCandidates.wasmIds,
    websocketChannelIds: channels.channels
      .filter(channel => channel.kind === 'websocket')
      .map(channel => channel.id),
    webrtcChannelIds: channels.channels
      .filter(channel => channel.kind === 'webrtc')
      .map(channel => channel.id),
    webtransportChannelIds: channels.channels
      .filter(channel => channel.kind === 'webtransport')
      .map(channel => channel.id),
    evidenceGraphPath: 'catalog/relations.jsonl',
    valueFlowPath: 'ai/value-flow.json',
    missingEvidencePath: 'ai/missing-evidence.json',
    replayEntryPath: 'replay/manifest.json',
  };

  const missingEvidence: PackV2MissingEvidence = {
    schemaVersion: PACK_V2_SCHEMA_VERSION,
    captureIntegrity: derived.captureIntegrity,
    items: derived.reasons.map(code => {
      const info = incompleteReasonInfo(code);
      return { reason: code, title: info.title, detail: info.summary };
    }),
  };

  // Replay 计划派生（规范 §16）：登录 / 启动候选请求与 Viewer 通道。
  // 派生失败退回诚实下限（replayable=false + 缺失说明）并显式记账。
  let replayManifest: PackV2ReplayManifest = {
    schemaVersion: PACK_V2_SCHEMA_VERSION,
    replayable: false,
    notReplayableReasons: ['replay 计划派生失败（见 ai/summary.md 派生缺口），退回诚实下限'],
    clockPolicy: 'realtime',
    requests: [],
    channels: [],
  };
  let replayHttpRows: PackV2ReplayRequestRow[] = [];
  try {
    const replay = deriveReplayPlan({
      facts: packFacts.facts,
      dossier: { candidateChain: dossierChain, ...aiCandidates },
      valueFlow,
      wsHandshakes: packFacts.wsHandshakes,
    });
    replayManifest = replay.manifest;
    replayHttpRows = replay.httpRows;
  } catch (error) {
    derivationGaps.push(
      `replay 计划派生失败，退回诚实下限：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const replayChannels: PackV2ReplayChannelsFile = {
    schemaVersion: PACK_V2_SCHEMA_VERSION,
    channels: replayManifest.channels,
  };

  const files: PackV2DerivedFile[] = [
    { path: '00_START_HERE.md', content: buildPackV2StartHereMarkdown() },
    { path: 'manifest.json', content: json2(manifest) },
    { path: 'integrity.json', content: json2(integrity) },
    { path: 'report.html', content: buildPackV2ReportHtml(manifest) },
    { path: 'ai/index.json', content: json2(aiIndex) },
    {
      path: 'ai/summary.md',
      content: buildAssemblySummaryMarkdown(manifest, {
        derivationGaps,
        dossierSteps: dossierChain.length,
      }),
    },
    { path: 'ai/adapter-dossier.json', content: json2(adapterDossier) },
    ...(valueFlowFromWorkspace
      ? []
      : [{ path: 'ai/value-flow.json', content: json2(valueFlow) }]),
    { path: 'ai/missing-evidence.json', content: json2(missingEvidence) },
    { path: 'replay/manifest.json', content: json2(replayManifest) },
    {
      path: 'replay/http.jsonl',
      content:
        replayHttpRows.length > 0
          ? `${replayHttpRows.map(row => JSON.stringify(row)).join('\n')}\n`
          : '',
    },
    { path: 'replay/channels.json', content: json2(replayChannels) },
  ];

  // schema/ 副本：包内自带全部 2.0 Schema，供离线独立校验。
  const schemaDir = resolvePackV2SchemaDir(input.schemaSourceDir);
  const schemaNames = readdirSync(schemaDir)
    .filter(name => name.endsWith('.schema.json'))
    .sort();
  if (schemaNames.length === 0) {
    throw new Error(`schema 目录为空，拒绝装配：${schemaDir}`);
  }
  for (const name of schemaNames) {
    files.push({ path: `schema/${name}`, content: readFileSync(join(schemaDir, name)) });
  }

  const fileName = buildPackV2FileName({
    startedAt: manifest.job.startedAt,
    targetHost: manifest.target.host,
    workflowStatus: manifest.workflowStatus,
    captureIntegrity: manifest.captureIntegrity,
    shortJobId: manifest.job.shortId,
  });

  return { status, derived, manifest, fileName, files };
}
