/**
 * 协议 Fixture 回放 E2E 运行器（规范 §16）。
 *
 * 1. 子进程完整跑一遍 mock-kvm-collector-flow（真实浏览器采集 + 装配导出包），
 *    从 stdout 解析导出包路径——回放客户端只消费导出交付物，不读工作区。
 * 2. 起全新 Mock 实例 B（同 seed → 路径/字段名/头名与 A 相同；
 *    perInstanceTokens → token 值全部 OS 随机），模拟「同一台设备上的
 *    全新会话」：包内模板的 URL / 字段名仍有效，携带的旧 token 必须替换。
 * 3. Node 回放客户端（协议适配器角色）按 replay/manifest.json 的
 *    requiresDynamicValueIds 驱动替换：真实交互获取新鲜 nonce/csrf/cookie/
 *    viewerToken，重放登录 → 启动 → WS 握手，服务端断言接受。
 * 4. 反例（先于通过断言）：不替换 / 半替换的回放必须被服务端拒绝——
 *    证明替换是必要的，而不是服务端没在校验。
 * 5. 记账：回放客户端实际执行的每一次替换都必须由 manifest 声明的动态值
 *    背书；manifest 声明的动态值（登录/启动/通道）必须全部被消费。
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const here = dirname(fileURLToPath(import.meta.url));

const successMarker = 'protocol fixture replay e2e passed';
const captureSuccessMarker = 'mock kvm collector e2e passed';
const capturePackMarker = 'exported-capture-pack: ';

const appDir = mkdtempSync(join(tmpdir(), 'protocol-fixture-replay-'));

function fail(message) {
  console.error(`[protocol-fixture-replay] ${message}`);
  process.exit(1);
}

function jsonl(text) {
  return String(text || '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/** 登录页隐藏域的值（nonce 来源；mock 登录页 <input type="hidden" value="...">）。 */
function hiddenInputValue(html) {
  for (const tag of html.match(/<input[^>]*>/g) || []) {
    if (!/type="hidden"/.test(tag)) continue;
    const match = /value="([^"]*)"/.exec(tag);
    if (match) return match[1];
  }
  throw new Error('登录页缺少 hidden 域值（nonce 来源不可解析）');
}

function httpExchange(urlString, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== null) req.end(body);
    else req.end();
  });
}

/** 裸 WS 握手：返回状态行与收到的全部字节（含 101 后服务端初始下行帧）。 */
function wsHandshake(urlString, cookiePair, settleDelayMs = 400) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const secKey = randomBytes(16).toString('base64');
    const socket = netConnect({ host: u.hostname, port: Number(u.port) || 80 });
    const chunks = [];
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const failWith = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(8000, () => failWith(new Error('WS 握手超时')));
    socket.on('error', failWith);
    socket.on('connect', () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${secKey}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          `Cookie: ${cookiePair}\r\n` +
          '\r\n',
      );
    });
    socket.on('data', chunk => {
      if (settled) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const all = Buffer.concat(chunks).toString('latin1');
      if (!all.includes('\r\n\r\n')) return;
      const statusLine = all.split('\r\n', 1)[0];
      if (!statusLine.includes(' 101 ')) {
        finish({ statusLine, received: Buffer.alloc(0) });
        return;
      }
      // 101 后服务端立即下发初始帧：短暂等待帧字节再收尾
      setTimeout(() => finish({ statusLine, received: Buffer.concat(chunks) }), settleDelayMs);
    });
  });
}

/** 子进程跑完整采集导出，解析导出包路径。 */
function runCaptureE2e() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'mock-kvm-collector-flow.mjs')], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('采集导出子进程超时（120s）'));
    }, 120000);
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`采集导出子进程退出码 ${code}`));
        return;
      }
      if (!output.includes(captureSuccessMarker)) {
        reject(new Error('采集导出子进程未出现成功标记'));
        return;
      }
      const markerLine = output
        .split('\n')
        .find(line => line.startsWith(capturePackMarker));
      if (!markerLine) {
        reject(new Error('采集导出子进程未输出导出包路径'));
        return;
      }
      resolve(markerLine.slice(capturePackMarker.length).trim());
    });
  });
}

async function main() {
  // ---- 构建回放 e2e 用的纯 Node 模块（不依赖 Electron）----
  await build({
    entryPoints: [join(rootDir, 'src/core/mock-kvm/createMockKvmServer.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'mock-kvm-server.mjs'),
  });
  await build({
    entryPoints: [join(rootDir, 'src/core/export/readZipEntries.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'read-zip-entries.mjs'),
    banner: {
      js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
  });

  const { createMockKvmServer } = await import(join(appDir, 'mock-kvm-server.mjs'));
  const { readZipEntries, readZipEntryBuffers } = await import(join(appDir, 'read-zip-entries.mjs'));

  const zipPath = await runCaptureE2e();
  const entries = await readZipEntries(zipPath);
  // 二进制正文（crypto 输出原始字节）逐字节读取——utf8 解码有损
  const entryBuffers = await readZipEntryBuffers(zipPath);
  // 包已整包载入内存（回放客户端只消费导出交付物），临时 zip 目录即可清理
  rmSync(dirname(zipPath), { recursive: true, force: true });

  // ---- 全新 Mock 实例 B：同 seed（路径/字段名/头名一致）+ OS 随机 token ----
  const handleB = await createMockKvmServer({
    seed: 'mock-kvm-collector-e2e',
    perInstanceTokens: true,
  });
  try {
    await replayPack(entries, entryBuffers, handleB);
  } finally {
    await handleB.close().catch(() => {});
  }

  console.log(successMarker);
}

/**
 * 回放主体：包内事实 → manifest 声明的动态值驱动替换 → 服务端接受断言。
 * 全部断言失败即抛错（e2e 失败），静默通过不存在。
 */
async function replayPack(entries, entryBuffers, handleB) {
  const json = path => JSON.parse(entries.get(path) || 'null');

  const manifest = json('replay/manifest.json');
  if (manifest?.replayable !== true) {
    throw new Error(`回放包不可回放：${JSON.stringify(manifest?.notReplayableReasons)}`);
  }

  const transactions = jsonl(entries.get('raw/http/transactions.jsonl'));
  const txById = new Map(transactions.map(tx => [tx.id, tx]));
  const valueFlow = json('ai/value-flow.json');
  const nodeById = new Map((valueFlow?.nodes || []).map(node => [node.id, node]));
  const edgeList = valueFlow?.edges || [];
  const cryptoRows = jsonl(entries.get('raw/runtime/crypto.jsonl'));
  const cryptoById = new Map(cryptoRows.map(row => [row.id, row]));
  const storageSnapshot = json('raw/browser/storage.json') || {};
  const sessionStorageSnap = storageSnapshot.sessionStorage || {};
  const localStorageSnap = storageSnapshot.localStorage || {};
  const cookieSnapshots = storageSnapshot.cookies || [];
  const channelRows = (json('catalog/channels.json') || {}).channels || [];

  const kindOf = id => nodeById.get(id)?.kind;

  // URL 重指向：同 seed 的全新实例——路径必须逐字节一致，只换主机/端口
  const knownPaths = new Set(Object.values(handleB.paths));
  const rehost = rawUrl => {
    const u = new URL(rawUrl);
    const base = new URL(handleB.base);
    if (!knownPaths.has(u.pathname)) {
      throw new Error(`回放 URL 路径不在目标实例上（seed 不一致？）：${u.pathname}`);
    }
    return `${u.protocol}//${base.host}${u.pathname}${u.search}`;
  };

  /** 动态值节点在包内可定位的捕获值（替换的「旧值」）。 */
  const capturedValueOfNode = node => {
    if (!node) return null;
    if (node.kind === 'cookie') {
      const cookie = cookieSnapshots.find(candidate => candidate.name === node.name);
      return cookie ? `${cookie.name}=${cookie.value}` : null;
    }
    if (node.kind === 'storage') {
      const key = node.name.replace(/（.*$/, '');
      return sessionStorageSnap[key] ?? localStorageSnap[key] ?? null;
    }
    if (node.kind === 'crypto-output') {
      const row = cryptoById.get(node.evidenceId);
      return row?.outputRef ? (entries.get(row.outputRef.path) ?? null) : null;
    }
    if (node.kind === 'http-response') {
      if (node.name.includes('（响应 Set-Cookie）')) {
        const cookieName = node.name.replace(/（.*$/, '');
        const cookie = cookieSnapshots.find(candidate => candidate.name === cookieName);
        return cookie ? `${cookie.name}=${cookie.value}` : null;
      }
      const tx = txById.get(node.evidenceId);
      return tx?.responseBody ? (entries.get(tx.responseBody.path) ?? null) : null;
    }
    return null;
  };

  // 请求识别：登录 = 声明了 crypto-output 动态值的请求；启动 = 其余请求
  const requests = manifest.requests || [];
  const loginRow = requests.find(row =>
    (row.requiresDynamicValueIds || []).some(id => kindOf(id) === 'crypto-output'),
  );
  const launchRow = requests.find(row => row !== loginRow);
  if (!loginRow || !launchRow) {
    throw new Error(`回放请求不完整（login=${!!loginRow} launch=${!!launchRow})`);
  }
  const channelRow = (manifest.channels || [])[0];
  if (!channelRow) {
    throw new Error('回放包缺少实时通道');
  }

  // 记账：manifest 声明的动态值必须全部被回放消费
  const consumedIds = new Set();
  const requiredIds = new Set([
    ...loginRow.requiresDynamicValueIds,
    ...launchRow.requiresDynamicValueIds,
    ...(channelRow.requiresDynamicValueIds || []),
  ]);

  const loginTx = txById.get(loginRow.requestId);
  const launchTx = txById.get(launchRow.requestId);

  // ---- 1. 登录回放：新鲜 nonce → 重算摘要 → 正文替换 ----
  // manifest 声明的动态值是 crypto 输出（摘要）本身；摘要输入的来源
  // （登录页 nonce）由协议适配器定位——捕获值必须逐字节出现在捕获的
  // crypto 输入里，证据可查，不是凭空构造
  const digestNodeId = loginRow.requiresDynamicValueIds.find(id => kindOf(id) === 'crypto-output');
  const digestRow = cryptoById.get(nodeById.get(digestNodeId).evidenceId);
  if (!digestRow?.inputRef?.path || !digestRow.outputRef?.path) {
    throw new Error('crypto 行缺少输入/输出正文引用（摘要链断裂）');
  }
  const capturedInput = entries.get(digestRow.inputRef.path) || '';

  // 登录页 = 响应正文带 hidden 域、且域值逐字节出现在 crypto 输入里的事务
  const loginPageTx = transactions
    .filter(tx => tx.responseBody?.path)
    .find(tx => {
      const body = entries.get(tx.responseBody.path) || '';
      try {
        return capturedInput.includes(hiddenInputValue(body));
      } catch {
        return false;
      }
    });
  if (!loginPageTx?.responseBody?.path) {
    throw new Error('未定位到登录页（响应正文缺少 crypto 输入的 hidden 域来源）');
  }
  const capturedNonce = hiddenInputValue(entries.get(loginPageTx.responseBody.path) || '');

  // 先访问 B 的登录页拿新鲜 nonce（真实交互，不用任何旁路）
  const loginPageResp = await httpExchange(rehost(loginPageTx.url));
  if (loginPageResp.status !== 200) {
    throw new Error(`登录页获取被拒绝：${loginPageResp.status}`);
  }
  const freshNonce = hiddenInputValue(loginPageResp.body);
  if (freshNonce === capturedNonce) {
    throw new Error('新实例 nonce 与包内相同（perInstanceTokens 未生效？）');
  }
  if (!capturedInput.includes(capturedNonce)) {
    throw new Error('crypto 输入未包含登录页 nonce（摘要输入链断裂）');
  }
  // 输入模板逐字节替换 nonce → 重算摘要（回放客户端不知道摘要公式的细节，
  // 只知道「输入模板里 nonce 是动态值」——公式保持捕获时的形状）
  const freshInput = capturedInput.split(capturedNonce).join(freshNonce);
  const capturedOutputBytes = entryBuffers.get(digestRow.outputRef.path) || Buffer.alloc(0);
  const freshOutputBytes = createHash('sha256').update(freshInput).digest();

  const loginBodyTemplate = entries.get(loginTx.requestBody?.path) ?? '';
  // 摘要在正文里的编码形态（原始字节 / hex / base64——与值传播图的
  // containedVariants 同一组可观察编码）逐个试替换
  const digestForms = [
    [capturedOutputBytes.toString('latin1'), freshOutputBytes.toString('latin1')],
    [capturedOutputBytes.toString('hex'), freshOutputBytes.toString('hex')],
    [capturedOutputBytes.toString('base64'), freshOutputBytes.toString('base64')],
  ];
  let loginBody = loginBodyTemplate;
  let digestSubstituted = false;
  for (const [capturedForm, freshForm] of digestForms) {
    if (capturedForm && loginBody.includes(capturedForm)) {
      loginBody = loginBody.split(capturedForm).join(freshForm);
      digestSubstituted = true;
    }
  }
  if (!digestSubstituted) {
    throw new Error('登录正文模板缺少捕获摘要输出（used-in 链断裂）');
  }

  // 反例先行：不替换摘要的登录必须被拒绝（401）——证明替换是必要的
  const staleLogin = await httpExchange(rehost(loginRow.url), {
    method: 'POST',
    headers: { ...loginTx.requestHeaders },
    body: loginBodyTemplate,
  });
  if (staleLogin.status !== 401) {
    throw new Error(`旧摘要登录应被 401 拒绝，实际 ${staleLogin.status}`);
  }

  const loginResp = await httpExchange(rehost(loginRow.url), {
    method: 'POST',
    headers: { ...loginTx.requestHeaders },
    body: loginBody,
  });
  const loginJson = JSON.parse(loginResp.body || '{}');
  if (loginResp.status !== 200 || loginJson.ok !== true) {
    throw new Error(`回放登录被拒绝：${loginResp.status} ${loginResp.body}`);
  }
  consumedIds.add(digestNodeId);

  // ---- 2. 新鲜会话事实：B 签发的 Cookie 与 csrfToken ----
  const setCookie = (loginResp.headers['set-cookie'] || [])[0] || '';
  const freshPair = setCookie.split(';')[0];
  if (!freshPair.includes('=')) {
    throw new Error(`登录响应缺少 Set-Cookie：${JSON.stringify(loginResp.headers)}`);
  }
  const freshCsrf = loginJson.csrfToken;
  if (typeof freshCsrf !== 'string' || !freshCsrf) {
    throw new Error('登录响应缺少 csrfToken');
  }

  // ---- 3. 启动回放：按声明的动态值替换 Cookie 头与逐字节等于 storage 值的头 ----
  const launchHeaders = { ...launchTx.requestHeaders };
  let capturedCsrfValue = null;
  let capturedSessionPair = null;
  for (const valueId of launchRow.requiresDynamicValueIds) {
    const node = nodeById.get(valueId);
    const capturedPair = capturedValueOfNode(node);
    if (!capturedPair) continue;
    // Cookie 链动态值（cookie 节点 / Set-Cookie 来源响应节点）：替换 Cookie 头里的捕获对
    if (node.kind === 'cookie' || (node.kind === 'http-response' && node.name.includes('（响应 Set-Cookie）'))) {
      const cookieKey = Object.keys(launchHeaders).find(key => key.toLowerCase() === 'cookie');
      if (!cookieKey || !launchHeaders[cookieKey].includes(capturedPair)) {
        throw new Error(`启动请求 Cookie 头缺少捕获会话对：${node.name}`);
      }
      launchHeaders[cookieKey] = launchHeaders[cookieKey].split(capturedPair).join(freshPair);
      capturedSessionPair = capturedPair;
      consumedIds.add(valueId);
      continue;
    }
    // storage 值链动态值：头值逐字节等于捕获 storage 值（如 CSRF 头）
    if (node.kind === 'storage') {
      const headerKey = Object.keys(launchHeaders).find(
        key => key.toLowerCase() !== 'cookie' && launchHeaders[key] === capturedPair,
      );
      if (!headerKey) {
        throw new Error(`启动请求没有逐字节等于 storage 值的头：${node.name}`);
      }
      launchHeaders[headerKey] = freshCsrf;
      capturedCsrfValue = capturedPair;
      consumedIds.add(valueId);
    }
  }
  if (!capturedCsrfValue) {
    throw new Error('启动请求未消耗任何 storage 动态值（csrf 替换缺失）');
  }
  if (!capturedSessionPair) {
    throw new Error('启动请求未消耗任何会话 Cookie 动态值（Cookie 替换缺失）');
  }
  if (freshPair === capturedSessionPair) {
    throw new Error('新实例会话 Cookie 与包内相同（perInstanceTokens 未生效？）');
  }
  if (freshCsrf === capturedCsrfValue) {
    throw new Error('新实例 csrfToken 与包内相同（perInstanceTokens 未生效？）');
  }

  // 反例：完全未替换的启动（旧 Cookie）→ 401；新鲜 Cookie + 旧 csrf 值 → 403
  const staleLaunch = await httpExchange(rehost(launchRow.url), {
    method: 'POST',
    headers: { ...launchTx.requestHeaders },
    body: launchTx.requestBody ? (entries.get(launchTx.requestBody.path) ?? null) : null,
  });
  if (staleLaunch.status !== 401) {
    throw new Error(`旧会话启动应被 401 拒绝，实际 ${staleLaunch.status}`);
  }
  const mixedHeaders = { ...launchHeaders };
  const csrfHeaderKey = Object.keys(mixedHeaders).find(key => mixedHeaders[key] === freshCsrf);
  mixedHeaders[csrfHeaderKey] = capturedCsrfValue;
  const mixedLaunch = await httpExchange(rehost(launchRow.url), {
    method: 'POST',
    headers: mixedHeaders,
    body: launchTx.requestBody ? (entries.get(launchTx.requestBody.path) ?? null) : null,
  });
  if (mixedLaunch.status !== 403) {
    throw new Error(`新鲜 Cookie + 旧 csrf 应被 403 拒绝，实际 ${mixedLaunch.status}`);
  }

  const launchResp = await httpExchange(rehost(launchRow.url), {
    method: 'POST',
    headers: launchHeaders,
    body: launchTx.requestBody ? (entries.get(launchTx.requestBody.path) ?? null) : null,
  });
  const launchJson = JSON.parse(launchResp.body || '{}');
  if (launchResp.status !== 200 || launchJson.ok !== true) {
    throw new Error(`回放启动被拒绝：${launchResp.status} ${launchResp.body}`);
  }
  const freshViewerToken = launchJson.viewerToken;
  if (typeof freshViewerToken !== 'string' || !freshViewerToken) {
    throw new Error('启动响应缺少 viewerToken');
  }

  // ---- 4. WS 握手回放：通道 URL 的动态查询参数替换 + Cookie 头替换 ----
  const wsChannel = channelRows.find(channel => channel.id === channelRow.channelId);
  if (!wsChannel?.url) {
    throw new Error(`通道 ${channelRow.channelId} 缺少 URL`);
  }
  const wsUrl = new URL(rehost(wsChannel.url));
  const capturedViewerToken = wsUrl.searchParams.get('t');
  if (!capturedViewerToken) {
    throw new Error('通道 URL 缺少 t 查询参数（viewerToken 传播缺失）');
  }
  if (freshViewerToken === capturedViewerToken) {
    throw new Error('新实例 viewerToken 与包内相同（perInstanceTokens 未生效？）');
  }
  wsUrl.searchParams.set('t', freshViewerToken);

  // 反例：新鲜 Cookie + 旧 viewerToken → 握手被拒（401）
  const staleWs = await wsHandshake(`${wsUrl.protocol}//${wsUrl.host}${wsUrl.pathname}?t=${encodeURIComponent(capturedViewerToken)}`, freshPair);
  if (!staleWs.statusLine.includes(' 401 ')) {
    throw new Error(`旧 viewerToken 握手应被 401 拒绝，实际 ${staleWs.statusLine}`);
  }

  const ws = await wsHandshake(wsUrl.toString(), freshPair);
  if (!ws.statusLine.includes(' 101 ')) {
    throw new Error(`回放 WS 握手被拒绝：${ws.statusLine}`);
  }
  // 101 后服务端立即下发初始帧：必须收到帧字节（帧序列索引在包内可重放）
  const headerEnd = ws.received.toString('latin1').indexOf('\r\n\r\n');
  if (ws.received.length <= headerEnd + 4) {
    throw new Error('WS 握手后未收到任何帧字节');
  }
  for (const valueId of channelRow.requiresDynamicValueIds || []) {
    const node = nodeById.get(valueId);
    if (node?.kind === 'cookie' || (node?.kind === 'http-response' && node.name.includes('（响应 Set-Cookie）'))) {
      // WS 握手 Cookie 头已替换为 B 签发的新鲜对
      consumedIds.add(valueId);
      continue;
    }
    const captured = capturedValueOfNode(node) ?? '';
    // storage 值（逐字节相同）或来源响应正文（包含）背书 t 参数替换
    if (node?.kind === 'storage' || node?.kind === 'http-response') {
      if (captured === capturedViewerToken || captured.includes(capturedViewerToken)) {
        consumedIds.add(valueId);
      }
    }
  }

  // ---- 5. 记账收口：manifest 声明的动态值必须全部被消费 ----
  const notConsumed = [...requiredIds].filter(id => !consumedIds.has(id));
  if (notConsumed.length > 0) {
    const detail = notConsumed.map(id => {
      const node = nodeById.get(id);
      return `${id}(${node?.kind ?? '?'}:${node?.name ?? '?'})`;
    });
    throw new Error(`回放未消费 manifest 声明的动态值：${detail.join(', ')}`);
  }
}

try {
  await main();
} finally {
  rmSync(appDir, { recursive: true, force: true });
}
