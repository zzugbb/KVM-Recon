/**
 * 现场 HAR 回放 E2E（规范 §20 的现场语料版）：
 * 把 0.2.x 时代的真实现场语料（HAR）在本地回放给 0.3.0 新链路采集，
 * 断言新包是旧语料的超集——
 * - 所有资源 URL 均在 catalog/resources.jsonl（>24 个资源反例）；
 * - 每个响应正文 SHA-256 逐条目相等（>1 MiB 文本 / >2 MiB 大正文无上限）；
 * - 二进制正文（base64，如字体）解码后哈希相等；
 * - 登录 POST 请求正文原样保留（不脱敏，规范 §13：现场口令逐字节在场）；
 * - 包 INCOMPLETE + verifyPackV2Zip 重开逐条目校验通过。
 *
 * 语料在仓库外（KVM_RECON_FIELD_COLLECTION_2 指向目录），只读不改。
 */

import { app } from 'electron';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseChecksumsManifest, sha256OfContent } from '../../core/export/checksumsManifest';
import { PACK_V2_CHECKSUMS_PATH, verifyPackV2Zip } from '../../core/export/exportPackV2Zip';
import type { ProbeBmcTargetResult } from '../../core/probe/probeBmcTarget';
import { FIELD_HAR_REPLAY_E2E_PASSED } from './runProductionCaptureE2e';
import { readZipEntries } from './runProductionCaptureE2e';
import { createProductionCapture } from './productionCaptureController';
import { createElectronNetlogSource } from './electronNetlogSource';

interface HarEntry {
  method: string;
  path: string;
  status: number;
  mimeType: string;
  /** 完整 Content-Type 响应头（含 charset）；缺失时退回 content.mimeType。 */
  contentType: string;
  bodyText: string | null;
  encoding: string | null;
  postData: string | null;
  redirectUrl: string | null;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fail(message: string): never {
  console.error(message);
  app.exit(1);
  process.exit(1);
}

function sha256Buffer(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

/** 首个差异字节的位置 + 上下文（十六进制），无差异 offset=-1。 */
function firstByteDiff(expected: Buffer, actual: Buffer): { offset: number; detail: string } {
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i += 1) {
    if (expected[i] !== actual[i]) {
      return {
        offset: i,
        detail: `期望 ${expected.toString('hex', Math.max(0, i - 8), i + 9)} 实得 ${actual.toString('hex', Math.max(0, i - 8), i + 9)}`,
      };
    }
  }
  return { offset: n, detail: `前 ${n} 字节一致（长度不同）` };
}

/** HAR → 回放条目（同 method+path 去重，保留首条）。 */
function parseHarEntries(har: {
  log: { entries: Array<Record<string, unknown>> };
}): { entries: HarEntry[]; total: number; skippedUpgrades: number } {
  const seen = new Set<string>();
  const entries: HarEntry[] = [];
  let skippedUpgrades = 0;
  for (const raw of har.log.entries) {
    const request = raw.request as
      | { method: string; url: string; postData?: { text?: string } }
      | undefined;
    const response = raw.response as
      | {
          status: number;
          content?: { mimeType?: string; text?: string; encoding?: string };
          redirectURL?: string;
          headers?: Array<{ name?: string; value?: string }>;
        }
      | undefined;
    if (!request || !response) continue;
    if (response.status === 101) {
      // HAR 的 WS 升级不是可由 fetch 重放的 HTTP 正文；WS 帧由专项测试校验。
      skippedUpgrades += 1;
      continue;
    }
    let path: string;
    try {
      path = new URL(request.url).pathname + new URL(request.url).search;
    } catch {
      continue;
    }
    const key = `${request.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 回放必须带原始 charset：Chromium 对无 charset 的 text/css 走编码嗅探，
    // 会把非 ASCII 字节 mojibake 后再以 UTF-8 重编码（clarity.css 的 ✓ 即此例）
    const contentTypeHeader = response.headers
      ?.find(header => (header.name || '').toLowerCase() === 'content-type')
      ?.value;
    entries.push({
      method: request.method,
      path,
      status: response.status,
      mimeType: response.content?.mimeType || 'application/octet-stream',
      contentType: contentTypeHeader || response.content?.mimeType || 'application/octet-stream',
      bodyText: response.content?.text ?? null,
      encoding: response.content?.encoding || null,
      postData: request.postData?.text ?? null,
      redirectUrl: response.redirectURL || null,
    });
  }
  return { entries, total: har.log.entries.length, skippedUpgrades };
}

function entryBody(entry: HarEntry): Buffer | null {
  if (!entry.bodyText) return null;
  if (entry.encoding === 'base64') {
    return Buffer.from(entry.bodyText, 'base64');
  }
  return Buffer.from(entry.bodyText, 'utf8');
}

function replayContentType(entry: HarEntry): string {
  if (entry.encoding === 'base64' || !entry.bodyText ||
      !/^(?:text\/|application\/(?:json|javascript|x-javascript|xml)|image\/svg\+xml)/i.test(entry.contentType)) {
    return entry.contentType;
  }
  // HAR text 是已解码的 Unicode；本地回放按 UTF-8 重新编码后必须显式声明。
  return `${entry.contentType.replace(/;\s*charset=(?:"[^"]*"|[^;]*)/i, '')}; charset=utf-8`;
}

export async function runFieldHarReplayE2e(harPath: string) {
  const har = JSON.parse(await readFile(harPath, 'utf8'));
  const { entries, total, skippedUpgrades } = parseHarEntries(har);
  if (entries.length === 0) {
    fail(`HAR 无可回放条目：${harPath}`);
  }

  const workspacesRoot = await mkdtemp(join(tmpdir(), 'kvm-recon-field-ws-'));
  const zipDir = await mkdtemp(join(tmpdir(), 'kvm-recon-field-zip-'));

  const byKey = new Map(entries.map(entry => [`${entry.method} ${entry.path}`, entry]));
  let served = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = String(req.url || '/');
    if (url === '/' || url === '/__replay-index') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // 回放脚本：按 6 条一批把 HAR 里每个条目真实请求一遍（含 POST 正文）
      const targets = entries.map(entry => ({
        method: entry.method,
        path: entry.path,
        body: entry.postData,
      }));
      res.end(`<!doctype html><html><body><script>
        window.__replayTotal = ${targets.length};
        window.__replayDone = false;
        (async () => {
          const targets = ${JSON.stringify(targets)};
          for (let i = 0; i < targets.length; i += 6) {
            await Promise.all(targets.slice(i, i + 6).map(t =>
              fetch(t.path, {
                method: t.method,
                body: t.body != null ? t.body : undefined,
                headers: t.body != null ? { 'content-type': 'application/json' } : undefined,
              }).then(() => null).catch(() => null)));
          }
          window.__replayDone = true;
        })();
      </script>replay</body></html>`);
      return;
    }
    const entry = byKey.get(`${req.method} ${url}`);
    if (!entry) {
      res.statusCode = 404;
      res.end('not-in-har');
      return;
    }
    served += 1;
    if (entry.redirectUrl && [300, 301, 302, 303, 307, 308].includes(entry.status)) {
      const redirectPath = (() => {
        try {
          const parsed = new URL(entry.redirectUrl);
          return parsed.pathname + parsed.search;
        } catch {
          return '/';
        }
      })();
      res.statusCode = entry.status;
      res.setHeader('location', redirectPath);
      res.end();
      return;
    }
    // Chrome HAR 可把缓存正文附在 304 上；本地服务必须用 200 才能让
    // Chromium 将这些字节作为新响应正文交给 CDP。原始 304 仍留在源 HAR。
    res.statusCode = entry.status === 304 && entry.bodyText ? 200 : entry.status;
    res.setHeader('content-type', replayContentType(entry));
    const body = entryBody(entry);
    if (body) res.end(body);
    else res.end();
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const e2eProbe = async (): Promise<ProbeBmcTargetResult> => ({
    basic: { host: '127.0.0.1', port, scheme: 'http', vendor: '', product: '', firmwareVersion: '' },
    redfish: {
      path: '/redfish/v1/',
      status: 0,
      reachable: false,
      vendor: '',
      product: '',
      firmwareVersion: '',
      rootFields: {},
    },
    tls: {
      reachable: true,
      authorized: true,
      authorizationError: '',
      protocol: '',
      cipher: null,
      certificate: null,
    },
  });

  const controller = await createProductionCapture({
    jobId: 'e2e-field-har-replay',
    workspacesRootDir: workspacesRoot,
    target: { host: '127.0.0.1', port, scheme: 'http', originalInput: harPath },
    tool: { version: '0.3.0-dev', buildId: 'e2e-field' },
    probeRunner: e2eProbe,
    netlog: createElectronNetlogSource(),
  });

  try {
    await controller.start();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    server.close();
    app.exit(1);
    return;
  }

  // 等全部条目真实回放完（resources 索引里出现全部 path）
  const expectedPaths = new Set(entries.map(entry => entry.path));
  let resourcesText = '';
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      resourcesText = (await controller.session.workspace.readArtifact('catalog/resources.jsonl')).toString('utf8');
    } catch {
      resourcesText = '';
    }
    const captured = new Set(
      resourcesText
        .split('\n')
        .filter(Boolean)
        .map(line => (JSON.parse(line) as { url: string }).url),
    );
    const missing = [...expectedPaths].filter(
      path => ![...captured].some(url => url.endsWith(path)),
    );
    if (missing.length === 0) break;
    await sleep(500);
  }

  await controller.stop();
  const exportResult = await controller.exportPack(zipDir);
  const zipEntries = await readZipEntries(exportResult.zipPath);

  // catalog/resources 行（path → 任意一行，含 requestBody/responseBody 引用）
  const resourceRows = (zipEntries.get('catalog/resources.jsonl') ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line =>
      JSON.parse(line) as {
        url: string;
        requestBody?: { path: string; sha256: string };
        responseBody?: { path: string; sha256: string };
      },
    );
  const rowByPath = new Map<string, (typeof resourceRows)[number]>();
  for (const row of resourceRows) {
    for (const entry of entries) {
      if (row.url.endsWith(entry.path)) {
        if (!rowByPath.has(entry.path)) rowByPath.set(entry.path, row);
      }
    }
  }

  const failures: string[] = [];
  let hashChecked = 0;
  let requestChecked = 0;
  let biggestBody = 0;
  for (const entry of entries) {
    const row = rowByPath.get(entry.path);
    if (!row) {
      failures.push(`resources 缺少条目：${entry.method} ${entry.path}`);
      continue;
    }
    const expectedBody = entryBody(entry);
    if (expectedBody && expectedBody.length > 0) {
      biggestBody = Math.max(biggestBody, expectedBody.length);
      if (!row.responseBody) {
        failures.push(`响应正文缺失：${entry.path}（mimeType=${entry.mimeType}）`);
      } else if (row.responseBody.sha256 !== sha256Buffer(expectedBody)) {
        const actualBuf = zipEntries.get(row.responseBody.path);
        let diff = '';
        if (actualBuf != null) {
          const actualBody = Buffer.from(actualBuf, 'utf8');
          const offset = firstByteDiff(expectedBody, actualBody);
          diff = `（期望 ${expectedBody.length}B / 实得 ${actualBody.length}B，首差异 @${offset.offset}：${offset.detail}）`;
        }
        failures.push(`响应正文哈希不一致：${entry.path}${diff}（期望 ${sha256Buffer(expectedBody).slice(0, 12)}，实得 ${row.responseBody.sha256.slice(0, 12)}）`);
      } else {
        hashChecked += 1;
      }
    }
    if (entry.postData != null && entry.postData.length > 0) {
      if (!row.requestBody) {
        failures.push(`请求正文缺失：${entry.method} ${entry.path}`);
      } else {
        const actual = zipEntries.get(row.requestBody.path) ?? '';
        if (actual !== entry.postData) {
          failures.push(`请求正文不一致：${entry.method} ${entry.path}（期望 ${JSON.stringify(entry.postData.slice(0, 80))}，实得 ${JSON.stringify(actual.slice(0, 80))}）`);
        } else {
          requestChecked += 1;
        }
      }
    }
  }

  // 回放完整性：HAR 条目（去重后）全部请求过
  const harSum = total;
  if (served < entries.length) {
    failures.push(`回放未走完：服务端只收到 ${served}/${entries.length} 个请求（HAR 原始 ${harSum} 条）`);
  }

  if (exportResult.status.captureIntegrity !== 'INCOMPLETE') {
    failures.push(`包完整度应为 INCOMPLETE：${exportResult.status.captureIntegrity}`);
  }
  if (!exportResult.derived.reasons.includes('INCOMPLETE_WORKFLOW_NOT_REACHED')) {
    failures.push('INCOMPLETE 包缺少 INCOMPLETE_WORKFLOW_NOT_REACHED 原因');
  }

  const checksums = zipEntries.get(PACK_V2_CHECKSUMS_PATH);
  if (!checksums) {
    failures.push('ZIP 缺少 checksums.sha256');
  } else {
    const expected = parseChecksumsManifest(checksums);
    expected.set(PACK_V2_CHECKSUMS_PATH, sha256OfContent(checksums));
    try {
      await verifyPackV2Zip(exportResult.zipPath, expected);
    } catch (error) {
      failures.push(`ZIP 重开校验失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length) {
    fail(
      [
        `现场 HAR 回放 E2E 失败：${harPath}`,
        `条目 ${entries.length}（HAR 原始 ${harSum}），正文哈希校验 ${hashChecked}，请求正文校验 ${requestChecked}，最大正文 ${biggestBody} 字节`,
        ...failures.slice(0, 20),
      ].join('\n'),
    );
  }

  try {
    await controller.closeWindows();
  } catch {
    void 0;
  }
  server.close();
  await rm(workspacesRoot, { recursive: true, force: true }).catch(() => undefined);
  console.log(
    `${FIELD_HAR_REPLAY_E2E_PASSED} har=${harPath} entries=${entries.length}/${harSum} wsUpgradesNotReplayed=${skippedUpgrades} bodies=${hashChecked} requests=${requestChecked} maxBody=${biggestBody} zip=${exportResult.zipPath}`,
  );
  app.exit(0);
}
