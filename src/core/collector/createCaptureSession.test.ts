import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startCaptureSession, type CaptureSession, type CdpSession } from './createCaptureSession';
import { derivePackIntegrity } from '../capture-pack-v2/packStatus';

/**
 * 阶段 2 采集会话：协议无关采集把 CDP 事实落到 JobWorkspace。
 * 不接 0.2.x recorder，不截断，不脱敏。
 */

const tempRoots: string[] = [];
const sessions: CaptureSession[] = [];

async function newRootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-collector-test-'));
  tempRoots.push(root);
  return root;
}

async function startSession(
  options: Parameters<typeof startCaptureSession>[0],
): Promise<CaptureSession> {
  const session = await startCaptureSession(options);
  sessions.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async session => {
      try {
        await session.workspace.close();
      } catch (error) {
        // 捕获测试收尾 close 失败：目录随后会整棵删除
        // 策略：不阻断 afterEach 清理
        void error;
      }
    }),
  );
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonl(buffer: Buffer): Array<Record<string, unknown>> {
  return buffer
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/** 有界轮询等待异步事件链产生可观察状态（每轮一个 macrotask）。 */
async function until(condition: () => Promise<boolean> | boolean, maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
}

function electronLikeSendCommand(
  impl: (command: string, params?: Record<string, unknown>, sessionId?: string) => unknown,
): CdpSession['sendCommand'] {
  return function sendCommand(command, params, sessionId) {
    if (arguments.length >= 3 && !(typeof sessionId === 'string' && sessionId)) {
      throw new Error('Empty session id is not allowed');
    }
    if (typeof sessionId === 'string' && sessionId) {
      return impl(command, params, sessionId);
    }
    return impl(command, params);
  };
}

function createFakeCdp(options?: {
  responseBodies?: Record<string, { body: string; base64Encoded?: boolean }>;
  postData?: Record<string, string>;
  cookies?: Array<Record<string, unknown>>;
  storage?: { localStorage: Record<string, string>; sessionStorage: Record<string, string> };
  scriptSources?: Record<string, { scriptSource?: string; bytecode?: string }>;
  indexedDb?: Array<Record<string, unknown>>;
  cacheStorage?: Array<Record<string, unknown>>;
  environment?: { userAgent: string; language: string; timezone: string; screen: string };
  domHtml?: string;
  screenshotData?: string;
  /** 截图命令的可控异步结果，用于 stop 与在途截图竞态反例。 */
  screenshotDataPromise?: Promise<string>;
  /** debugger.attach 的可控异步门，用于 stop 与在途挂载竞态反例。 */
  attachPromise?: Promise<void>;
  frameTree?: Record<string, unknown>;
  /** 注入失败（模拟）：命令名精确匹配 → sendCommand 抛错。 */
  failingCommands?: string[];
  /** 仅指定 scriptId 的 getScriptSource 失败。 */
  failingScriptIds?: string[];
  /** 注入失败（模拟）：Runtime.evaluate 的 expression 含任一子串 → 抛错。 */
  failingEvaluates?: string[];
}): { cdp: CdpSession; emit: (method: string, params: Record<string, unknown>, sessionId?: string) => void; commands: string[] } {
  const listeners: Array<
    (event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void
  > = [];
  const commands: string[] = [];
  const cdp: CdpSession = {
    async attach() {
      await options?.attachPromise;
    },
    sendCommand: electronLikeSendCommand(async (command, params, sessionId) => {
      commands.push(sessionId ? `${command}@${sessionId}` : command);
      if (options?.failingCommands?.includes(command)) {
        throw new Error(`注入命令失败（模拟）：${command}`);
      }
      if (command === 'Runtime.evaluate') {
        const expression = String((params as { expression?: string })?.expression ?? '');
        if (options?.failingEvaluates?.some(fragment => expression.includes(fragment))) {
          throw new Error(`注入求值失败（模拟）：${expression.slice(0, 40)}`);
        }
      }
      if (command === 'Network.getResponseBody') {
        const requestId = String((params as { requestId?: string })?.requestId ?? '');
        return (
          options?.responseBodies?.[requestId] ?? {
            body: '{"ok":true}',
            base64Encoded: false,
          }
        );
      }
      if (command === 'Network.getRequestPostData') {
        const requestId = String((params as { requestId?: string })?.requestId ?? '');
        return { postData: options?.postData?.[requestId] ?? '' };
      }
      if (command === 'Network.getCookies') {
        return { cookies: options?.cookies ?? [] };
      }
      if (command === 'Debugger.getScriptSource') {
        const scriptId = String((params as { scriptId?: string })?.scriptId ?? '');
        if (options?.failingScriptIds?.includes(scriptId)) {
          throw new Error(`No script for id: ${scriptId}`);
        }
        return (
          options?.scriptSources?.[scriptId] ?? {
            scriptSource: `// source ${scriptId}`,
          }
        );
      }
      if (command === 'Page.captureScreenshot') {
        return {
          data: options?.screenshotDataPromise
            ? await options.screenshotDataPromise
            : options?.screenshotData ?? 'c2NyZWVuc2hvdA==',
        };
      }
      if (command === 'Page.getFrameTree') {
        return { frameTree: options?.frameTree ?? { frame: { id: 'frame-root', url: 'about:blank' } } };
      }
      if (command === 'Runtime.evaluate') {
        const expression = String((params as { expression?: string })?.expression ?? '');
        if (expression.includes('sessionStorage')) {
          return {
            result: {
              type: 'object',
              value: options?.storage ?? { localStorage: {}, sessionStorage: {} },
            },
          };
        }
        if (expression.includes('navigator.userAgent')) {
          return {
            result: { type: 'object', value: options?.environment ?? null },
          };
        }
        if (expression.includes('indexedDB')) {
          return { result: { type: 'object', value: options?.indexedDb ?? [] } };
        }
        if (expression.includes('caches')) {
          return { result: { type: 'object', value: options?.cacheStorage ?? [] } };
        }
        if (expression.includes('document.documentElement')) {
          return { result: { type: 'string', value: options?.domHtml ?? '<html><body></body></html>' } };
        }
        return {};
      }
      return {};
    }),
    on(event, listener) {
      if (event === 'message') listeners.push(listener);
    },
  };
  return {
    cdp,
    commands,
    emit(method, params, sessionId) {
      for (const listener of listeners) listener({}, method, params, sessionId);
    },
  };
}

describe('阶段 2 采集会话（CDP / HTTP / WS / WebCrypto / 脚本 / 浏览器状态）', () => {
  it('CDP journal 记录命令与事件，未知 params 字段原样保留', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-cdp',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-doc',
      type: 'Document',
      undocumentedFutureField: { keep: true },
      request: { method: 'GET', url: 'http://bmc.test/login', headers: {} },
    });
    await session.stop();

    const events = jsonl(await session.workspace.readArtifact('raw/cdp/events.jsonl'));
    const commands = jsonl(await session.workspace.readArtifact('raw/cdp/commands.jsonl'));
    expect(commands.some(row => row.method === 'Network.enable')).toBe(true);
    expect(commands.some(row => row.method === 'Target.setAutoAttach')).toBe(true);
    const requestEvent = events.find(row => row.method === 'Network.requestWillBeSent');
    expect(requestEvent).toMatchObject({
      seq: 1,
      timestamp: '2026-09-21T01:00:00.000Z',
      method: 'Network.requestWillBeSent',
      targetId: 'target-root',
    });
    expect((requestEvent?.params as { undocumentedFutureField?: unknown }).undocumentedFutureField).toEqual({
      keep: true,
    });
  });

  it('HTTP 全 hop 正文写入 BodyStore：不截断、不脱敏，redirect 拆 hop', async () => {
    const rootDir = await newRootDir();
    const largeBody = 'A'.repeat(2 * 1024 * 1024 + 17);
    const loginBody = 'user=operator&password=operator-passphrase&nonce=abc';
    const session = await startSession({
      jobId: 'job-collector-http',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      responseBodies: {
        'req-login': { body: largeBody, base64Encoded: false },
      },
      postData: { 'req-login': loginBody },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root', windowId: 'window-1' });

    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-redirect',
      type: 'Document',
      frameId: 'frame-1',
      initiator: { type: 'other' },
      request: {
        method: 'GET',
        url: 'http://bmc.test/old',
        headers: { Referer: 'http://bmc.test/' },
      },
    });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-redirect',
      type: 'Document',
      redirectHasExtraInfo: false,
      redirectResponse: { status: 302, headers: { location: 'http://bmc.test/new' } },
      request: { method: 'GET', url: 'http://bmc.test/new', headers: {} },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-redirect',
      hasExtraInfo: false,
      response: { status: 200, headers: { 'content-type': 'text/html' }, mimeType: 'text/html' },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-redirect', encodedDataLength: 4 });

    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-login',
      type: 'XHR',
      initiator: { type: 'script', url: 'http://bmc.test/login', lineNumber: 12 },
      request: {
        method: 'POST',
        url: 'http://bmc.test/api/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        hasPostData: true,
      },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-login',
      hasExtraInfo: false,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-encoding': 'identity' },
        mimeType: 'application/json',
      },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-login', encodedDataLength: largeBody.length });

    await session.stop();

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(3);
    const [hop0, hop1, login] = rows;
    expect(hop0).toMatchObject({
      id: 'req-redirect',
      status: 302,
      url: 'http://bmc.test/old',
      redirectToId: 'req-redirect::redirect-1',
    });
    expect(hop1).toMatchObject({
      id: 'req-redirect::redirect-1',
      status: 200,
      url: 'http://bmc.test/new',
      redirectFromId: 'req-redirect',
    });
    expect(login).toMatchObject({
      method: 'POST',
      url: 'http://bmc.test/api/login',
      status: 200,
      targetId: 'target-root',
      windowId: 'window-1',
    });
    const requestRef = login.requestBody as { sha256: string; bytes: number; path: string };
    const responseRef = login.responseBody as { sha256: string; bytes: number; path: string };
    expect(requestRef.bytes).toBe(Buffer.byteLength(loginBody));
    expect(requestRef.sha256).toBe(sha256Hex(loginBody));
    expect(requestRef.path).toBe(`raw/http/bodies/${requestRef.sha256}`);
    const storedLogin = await session.workspace.readArtifact(requestRef.path);
    expect(storedLogin.toString('utf8')).toBe(loginBody);
    expect(storedLogin.toString('utf8')).toContain('operator-passphrase');
    expect(responseRef.bytes).toBe(Buffer.byteLength(largeBody));
    expect(responseRef.sha256).toBe(sha256Hex(largeBody));
    const storedLarge = await session.workspace.readArtifact(responseRef.path);
    expect(storedLarge.byteLength).toBe(Buffer.byteLength(largeBody));
    expect(storedLarge.toString('utf8')).toBe(largeBody);
  });

  it('Worker 跨 session 完成事件经唯一 URL 匹配关联父请求', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-worker-alias-join',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      responseBodies: { 'req-worker-script': { body: 'self.workerBoot=1', base64Encoded: false } },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    // 入口脚本由页面 loader 发起：requestWillBeSent 落在根会话（无 sessionId）
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-worker-script',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/kvm-worker.js', headers: {} },
    });
    // Worker target 建立：target URL 与在途父请求 URL 唯一匹配
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-1',
      targetInfo: {
        targetId: 'worker-target-1',
        type: 'worker',
        url: 'http://bmc.test/assets/kvm-worker.js',
      },
    });
    // 完成事件改在 Worker session 上报（0.2.9 现场观察到的分裂形态）
    fake.emit(
      'Network.responseReceived',
      {
        requestId: 'req-worker-script',
        hasExtraInfo: false,
        response: {
          status: 200,
          headers: { 'content-type': 'application/javascript' },
          mimeType: 'application/javascript',
        },
      },
      'worker-session-1',
    );
    fake.emit(
      'Network.loadingFinished',
      { requestId: 'req-worker-script', encodedDataLength: 17 },
      'worker-session-1',
    );
    await session.stop();

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'req-worker-script',
      status: 200,
      url: 'http://bmc.test/assets/kvm-worker.js',
    });
    expect(rows[0].responseBody).toBeDefined();
    // 正文经 Worker session 补读（该会话上 Network.getResponseBody 才可见）
    expect(fake.commands).toContain('Network.getResponseBody@worker-session-1');
    expect(session.integrityEvidence().missingBodies).toEqual([]);
  });

  it('Worker URL 匹配到多个在途父请求 → 不建别名，事件显式记账丢弃，不误关联', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-worker-alias-ambiguous',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    for (const requestId of ['req-twin-a', 'req-twin-b']) {
      fake.emit('Network.requestWillBeSent', {
        requestId,
        type: 'Script',
        request: { method: 'GET', url: 'http://bmc.test/assets/twin-worker.js', headers: {} },
      });
    }
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-2',
      targetInfo: {
        targetId: 'worker-target-2',
        type: 'worker',
        url: 'http://bmc.test/assets/twin-worker.js',
      },
    });
    fake.emit(
      'Network.responseReceived',
      {
        requestId: 'req-twin-a',
        response: { status: 200, headers: {}, mimeType: 'application/javascript' },
      },
      'worker-session-2',
    );
    fake.emit('Network.loadingFinished', { requestId: 'req-twin-a' }, 'worker-session-2');
    await session.stop();

    // 两个父请求都不被误关联：行保持未完成（status null），不伪造正文
    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBeNull();
      expect(row.responseBody).toBeUndefined();
    }
    // 未关联的完成事件必须显式记账（不得静默吞掉）
    const dropped = session.evidence().diagnostics().droppedEventByMethod;
    expect(dropped['Network.responseReceived']).toBeGreaterThanOrEqual(1);
    expect(dropped['Network.loadingFinished']).toBeGreaterThanOrEqual(1);
  });

  it('Worker URL 迟到：完成事件已丢弃时 targetInfoChanged 补齐 URL 并经 Worker session 补读入口正文', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-worker-url-late-salvage',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      responseBodies: { 'req-late-worker': { body: 'self.lateBoot=1', base64Encoded: false } },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-late-worker',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/late-worker.js', headers: {} },
    });
    // attach 时 targetInfo.url 为空（CDP 已知形态：Worker URL 尚未解析）
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-late',
      targetInfo: { targetId: 'worker-target-late', type: 'worker', url: '' },
    });
    // 完成事件在 URL 到达前改在 Worker session 上报：URL 为空无法建别名，
    // 按未命中显式丢弃——这是不可重放的观察事实，必须能被补读路径挽回
    fake.emit(
      'Network.responseReceived',
      {
        requestId: 'req-late-worker',
        response: { status: 200, headers: {}, mimeType: 'application/javascript' },
      },
      'worker-session-late',
    );
    fake.emit(
      'Network.loadingFinished',
      { requestId: 'req-late-worker', encodedDataLength: 17 },
      'worker-session-late',
    );
    // URL 迟到：targetInfoChanged 补齐 workerSessions 并对已丢弃完成事件的
    // 入口脚本主动补读正文（0.2.10 salvageWorkerMainScript 的 0.3 重建）
    fake.emit('Target.targetInfoChanged', {
      targetInfo: {
        targetId: 'worker-target-late',
        type: 'worker',
        url: 'http://bmc.test/assets/late-worker.js',
      },
    });
    await session.stop();

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'req-late-worker',
      url: 'http://bmc.test/assets/late-worker.js',
    });
    // status 未经观察（responseReceived 已显式丢弃记账），正文必须补读落盘
    expect(rows[0].status).toBeNull();
    expect(rows[0].responseBody).toBeDefined();
    expect(fake.commands).toContain('Network.getResponseBody@worker-session-late');
    // 补读成功不得再记 missingBodies 缺口
    expect(
      session.integrityEvidence().missingBodies.filter(gap => gap.id === 'req-late-worker'),
    ).toEqual([]);
    // 丢弃的完成事件保持显式记账（规范 §3：补读挽回正文，不等于事件未发生）
    const dropped = session.evidence().diagnostics().droppedEventByMethod;
    expect(dropped['Network.responseReceived']).toBeGreaterThanOrEqual(1);
    expect(dropped['Network.loadingFinished']).toBeGreaterThanOrEqual(1);
  });

  it('Worker URL 迟到但完成事件未到：不预读，完成事件经别名正常落 status 与正文', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-worker-url-late-alias',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      responseBodies: { 'req-late-worker-2': { body: 'self.lateBoot=2', base64Encoded: false } },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-late-worker-2',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/late-worker-2.js', headers: {} },
    });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-late-2',
      targetInfo: { targetId: 'worker-target-late-2', type: 'worker', url: '' },
    });
    // URL 先于完成事件到达：没有已丢弃的完成事件，不得预读
    // （预读会抢先 commit，status/timing/头将无法落盘）
    fake.emit('Target.targetInfoChanged', {
      targetInfo: {
        targetId: 'worker-target-late-2',
        type: 'worker',
        url: 'http://bmc.test/assets/late-worker-2.js',
      },
    });
    fake.emit(
      'Network.responseReceived',
      {
        requestId: 'req-late-worker-2',
        response: { status: 200, headers: {}, mimeType: 'application/javascript' },
      },
      'worker-session-late-2',
    );
    fake.emit(
      'Network.loadingFinished',
      { requestId: 'req-late-worker-2', encodedDataLength: 17 },
      'worker-session-late-2',
    );
    await session.stop();

    // 补齐的 URL 让别名机制正常命中：status 与正文都落盘
    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'req-late-worker-2',
      status: 200,
      url: 'http://bmc.test/assets/late-worker-2.js',
    });
    expect(rows[0].responseBody).toBeDefined();
    expect(fake.commands).toContain('Network.getResponseBody@worker-session-late-2');
    expect(
      session.integrityEvidence().missingBodies.filter(gap => gap.id === 'req-late-worker-2'),
    ).toEqual([]);
  });

  it('Worker URL 迟到且匹配多候选父请求 → 不补读不误关联', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-worker-url-late-ambiguous',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      responseBodies: { 'req-twin-late-a': { body: 'twin-a', base64Encoded: false } },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    for (const requestId of ['req-twin-late-a', 'req-twin-late-b']) {
      fake.emit('Network.requestWillBeSent', {
        requestId,
        type: 'Script',
        request: { method: 'GET', url: 'http://bmc.test/assets/twin-late-worker.js', headers: {} },
      });
    }
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-late-3',
      targetInfo: { targetId: 'worker-target-late-3', type: 'worker', url: '' },
    });
    fake.emit(
      'Network.loadingFinished',
      { requestId: 'req-twin-late-a' },
      'worker-session-late-3',
    );
    fake.emit('Target.targetInfoChanged', {
      targetInfo: {
        targetId: 'worker-target-late-3',
        type: 'worker',
        url: 'http://bmc.test/assets/twin-late-worker.js',
      },
    });
    await session.stop();

    // 多候选：补读与别名都不建（宁可漏不可错），两行按未完成显式记缺口
    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBeNull();
      expect(row.responseBody).toBeUndefined();
    }
    expect(fake.commands).not.toContain('Network.getResponseBody@worker-session-late-3');
    const gaps = session.integrityEvidence().missingBodies;
    expect(gaps.filter(gap => gap.id === 'req-twin-late-a')).toHaveLength(1);
    expect(gaps.filter(gap => gap.id === 'req-twin-late-b')).toHaveLength(1);
  });

  it('Worker detach 强制收尾：缺正文显式记 missingBodies 缺口 + detach 原因记账（三轮 T5）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-worker-detach-finish',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-detach-worker',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/detach-worker.js', headers: {} },
    });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-3',
      targetInfo: {
        targetId: 'worker-target-3',
        type: 'worker',
        url: 'http://bmc.test/assets/detach-worker.js',
      },
    });
    fake.emit(
      'Network.responseReceived',
      {
        requestId: 'req-detach-worker',
        response: { status: 200, headers: {}, mimeType: 'application/javascript' },
      },
      'worker-session-3',
    );
    fake.emit('Target.detachedFromTarget', {
      sessionId: 'worker-session-3',
      targetId: 'worker-target-3',
    });
    await session.stop();

    // Worker 会话消失后正文不可再读：detach 强制收尾不是观察到的失败，
    // status=200 且无正文必须显式作证（missingBodies 缺口），
    // 不得伪装成「明确无正文语义」静默放行
    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'req-detach-worker', status: 200 });
    expect(rows[0].responseBody).toBeUndefined();
    const gaps = session.integrityEvidence().missingBodies.filter(
      gap => gap.id === 'req-detach-worker',
    );
    expect(gaps).toHaveLength(1);
    // detach 原因逐条显式记账（规范 §3）
    const dropped = session.evidence().diagnostics().droppedEventByMethod;
    expect(dropped['Target.detachedFromTarget']).toBeGreaterThanOrEqual(1);
  });

  it('drain 期 Worker 完成事件不新建别名：未证实的归属按未命中显式记账（三轮 T3）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-drain-worker-alias',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    // 在途父请求（未完成）：URL 与 Worker target 唯一匹配
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-live-w',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/w.js', headers: {} },
    });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-drain',
      targetInfo: {
        targetId: 'worker-target-drain',
        type: 'worker',
        url: 'http://bmc.test/assets/w.js',
      },
    });
    // drain 期：另一 requestId 的完成事件到达 Worker session——该请求的
    // requestWillBeSent 已在 drain 期丢弃，无法证明它属于 req-live-w，
    // 不得凭 URL 唯一性建别名把别的请求的事实写到 req-live-w 名下
    const stopPromise = session.stop();
    fake.emit(
      'Network.responseReceived',
      {
        requestId: 'req-drain-new-w',
        response: { status: 200, headers: {}, mimeType: 'application/javascript' },
      },
      'worker-session-drain',
    );
    fake.emit('Network.loadingFinished', { requestId: 'req-drain-new-w' }, 'worker-session-drain');
    await stopPromise;

    // req-live-w 不得被污染：行保持未完成（status null），无正文
    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'req-live-w' });
    expect(rows[0].status).toBeNull();
    expect(rows[0].responseBody).toBeUndefined();
    // 未命中的完成事件显式记账；req-live-w 按未完成记 missingBodies 缺口
    const dropped = session.evidence().diagnostics().droppedEventByMethod;
    expect(dropped['Network.responseReceived']).toBeGreaterThanOrEqual(1);
    expect(dropped['Network.loadingFinished']).toBeGreaterThanOrEqual(1);
    expect(
      session.integrityEvidence().missingBodies.some(gap => gap.id === 'req-live-w'),
    ).toBe(true);
  });

  it('已 commit 行的晚到正文不无痕写入：显式记缺口（三轮 T4）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-late-body-after-commit',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-late-body',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/late.js', headers: {} },
    });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-late',
      targetInfo: {
        targetId: 'worker-target-late',
        type: 'worker',
        url: 'http://bmc.test/assets/late.js',
      },
    });
    fake.emit(
      'Network.responseReceived',
      {
        requestId: 'req-late-body',
        response: { status: 200, headers: {}, mimeType: 'application/javascript' },
      },
      'worker-session-late',
    );
    // detach 强制收尾：行落盘（无正文，missingBodies 缺口已记）
    fake.emit('Target.detachedFromTarget', {
      sessionId: 'worker-session-late',
      targetId: 'worker-target-late',
    });
    // 晚到的 loadingFinished（父会话）：正文可取出，但行已 commit——
    // 正文不得无痕写进内存行（行已落盘），必须显式记账
    fake.emit('Network.loadingFinished', { requestId: 'req-late-body', encodedDataLength: 11 });
    await session.stop();

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'req-late-body', status: 200 });
    expect(rows[0].responseBody).toBeUndefined();
    const gaps = session.integrityEvidence().missingBodies.filter(
      gap => gap.id === 'req-late-body',
    );
    expect(gaps.some(gap => (gap.detail ?? '').includes('晚于 commit'))).toBe(true);
  });

  it('已 commit 行的晚到 redirectResponse 不无痕丢弃：状态/头/redirectToId 显式记账', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-late-redirect-after-commit',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-late-redirect',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/late-r.js', headers: {} },
    });
    // 显式失败收尾：行落盘（journal 只追加，此后晚到事实不得改写）
    fake.emit('Network.loadingFailed', {
      requestId: 'req-late-redirect',
      errorText: 'net::ERR_ABORTED',
      canceled: true,
    });
    // 晚到的 redirectResponse：302 状态/Location/redirectToId 无法落盘，
    // 不得无痕丢弃（无记账的静默丢弃等于编造「没有发生过」，规范 §3）
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-late-redirect',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/next-r.js', headers: {} },
      redirectResponse: {
        status: 302,
        headers: { location: 'http://bmc.test/assets/next-r.js' },
        url: 'http://bmc.test/assets/late-r.js',
      },
    });
    await session.stop();

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(2);
    // 已落盘行不得被晚到 redirectResponse 改写（status 不得变成 302）
    expect(rows[0]).toMatchObject({ id: 'req-late-redirect', status: null });
    expect(rows[0].redirectToId).toBeUndefined();
    // 下一跳照常开行
    expect(rows[1]).toMatchObject({ id: 'req-late-redirect::redirect-1' });
    // 晚到事实显式记账
    const dropped = session.evidence().diagnostics().droppedEventByMethod;
    expect(dropped['Network.requestWillBeSent']).toBeGreaterThanOrEqual(1);
  });

  it('204 完成事件的正文读取失败不记假缺口；缺正文由 commit 单点判定', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-nobody-read-fail',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({ failingCommands: ['Network.getResponseBody'] });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    for (const [requestId, status] of [
      ['req-nobody-204', 204],
      ['req-nobody-500', 500],
    ] as const) {
      fake.emit('Network.requestWillBeSent', {
        requestId,
        type: 'Script',
        request: { method: 'GET', url: `http://bmc.test/${requestId}.js`, headers: {} },
      });
      fake.emit('Network.responseReceived', {
        requestId,
        response: { status, headers: {}, mimeType: 'application/javascript' },
      });
      fake.emit('Network.loadingFinished', { requestId, encodedDataLength: 0 });
    }
    await session.stop();

    const evidence = session.integrityEvidence();
    // 204 是明确无正文语义：读取失败不是缺口（读失败的事实按 droppedEvent 记账）
    expect(evidence.missingBodies.filter(gap => gap.id === 'req-nobody-204')).toHaveLength(0);
    // 500 无正文语义豁免：恰好一条缺口，由 commit 记（detail 带 status=500）
    const gaps500 = evidence.missingBodies.filter(gap => gap.id === 'req-nobody-500');
    expect(gaps500).toHaveLength(1);
    expect(gaps500[0].detail).toContain('status=500');
    // 读失败本身显式记账，不静默吞
    const dropped = session.evidence().diagnostics().droppedEventByMethod;
    expect(dropped['Network.getResponseBody']).toBeGreaterThanOrEqual(2);
  });

  it('drain 期空链不解锁别名：先到的未知完成事件不是「已跟踪」证据', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-drain-empty-chain',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    // 在途父请求：URL 与 Worker target 唯一匹配
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-live-w3',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/assets/w3.js', headers: {} },
    });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-w3',
      targetInfo: {
        targetId: 'worker-target-w3',
        type: 'worker',
        url: 'http://bmc.test/assets/w3.js',
      },
    });
    const stopPromise = session.stop();
    // drain 期未知 requestId 的完成事件先到（requestWillBeSent 已被丢弃）：
    // 它只能建出「空链」，不构成该请求已被跟踪的证据
    fake.emit('Network.responseReceived', {
      requestId: 'req-empty-chain',
      response: { status: 200, headers: {}, mimeType: 'application/javascript' },
    });
    // 同一 requestId 的完成事件随后到达 Worker session：空链不得解锁
    // URL 回退别名，把未知请求的事实写到 req-live-w3 名下
    fake.emit(
      'Network.responseReceived',
      {
        requestId: 'req-empty-chain',
        response: { status: 200, headers: {}, mimeType: 'application/javascript' },
      },
      'worker-session-w3',
    );
    await stopPromise;

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'req-live-w3' });
    expect(rows[0].status).toBeNull();
    expect(rows[0].responseBody).toBeUndefined();
    // 未证实的归属按未命中显式记账
    const dropped = session.evidence().diagnostics().droppedEventByMethod;
    expect(dropped['Network.responseReceived']).toBeGreaterThanOrEqual(2);
  });

  it('drain 期间到达的 HTTP 完成事件照常处理：在途请求不丢正文', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-drain-completion',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      responseBodies: { 'req-slow': { body: 'slow-but-complete', base64Encoded: false } },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-slow',
      type: 'Script',
      request: { method: 'GET', url: 'http://bmc.test/slow.js', headers: {} },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-slow',
      response: { status: 200, headers: {}, mimeType: 'application/javascript' },
    });
    // stop() 同步进入 drain 相位后才到达的完成事件：在途请求的收尾事实不得丢弃
    const stopPromise = session.stop();
    fake.emit('Network.loadingFinished', { requestId: 'req-slow', encodedDataLength: 18 });
    await stopPromise;

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'req-slow', status: 200 });
    expect(rows[0].responseBody).toBeDefined();
    expect(session.integrityEvidence().missingBodies).toEqual([]);
  });

  it('drain 期不追踪新请求：requestWillBeSent 显式记账丢弃，不新增事务行', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-drain-new-request',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    // stop() 进入 drain 相位后到达的新请求：完成事件白名单放行、
    // requestWillBeSent 不放行（不追踪新请求），丢弃必须显式记账
    const stopPromise = session.stop();
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-drain-new',
      type: 'XHR',
      request: { method: 'GET', url: 'http://bmc.test/drain-new', headers: {} },
    });
    await stopPromise;

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(0);
    expect(
      session.evidence().diagnostics().droppedEventByMethod['Network.requestWillBeSent'],
    ).toBeGreaterThan(0);
  });

  it('收尾时从未收到完成事件的请求记 missingBodies 缺口 → INCOMPLETE_BODY_MISSING', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-unfinished-request',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-pending',
      type: 'XHR',
      request: { method: 'GET', url: 'http://bmc.test/api/pending', headers: {} },
    });
    await session.stop();

    // status=null（从未有完成事件）不构成「明确无正文语义」（规范 §14 条 3）：
    // 必须显式作证缺失，不得静默放行 COMPLETE
    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBeNull();
    const summary = session.integrityEvidence();
    expect(summary.missingBodies.some(gap => gap.id === 'req-pending')).toBe(true);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_BODY_MISSING');
    expect(derived.gates.find(gate => gate.id === 'http-bodies-complete')?.passed).toBe(false);
  });

  it('loadingFailed 终止的请求是显式失败语义：不产生 missingBodies 缺口', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-loading-failed',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-failed',
      type: 'XHR',
      request: { method: 'GET', url: 'http://bmc.test/api/failed', headers: {} },
    });
    fake.emit('Network.loadingFailed', {
      requestId: 'req-failed',
      errorText: 'net::ERR_ABORTED',
      canceled: true,
    });
    await session.stop();

    const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(rows).toHaveLength(1);
    expect(
      session.integrityEvidence().missingBodies.filter(gap => gap.id === 'req-failed'),
    ).toEqual([]);
  });

  it('Cookie 快照失败 → browserStateGaps 缺口 → INCOMPLETE_BROWSER_STATE', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-browser-state-cookies-fail',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({ failingCommands: ['Network.getCookies'] });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const summary = session.integrityEvidence();
    expect(summary.browserStateWritten).toBe(false);
    expect(summary.browserStateGaps.some(gap => gap.id === 'cookies')).toBe(true);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_BROWSER_STATE');
    expect(derived.gates.find(gate => gate.id === 'browser-state-written')?.passed).toBe(false);
  });

  it('Storage 求值失败 → browserStateGaps 缺口（不与其它步骤混淆）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-browser-state-storage-fail',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    // storage.key(i) 只出现在 STORAGE_DUMP_EXPRESSION（观察脚本与其它求值不含）
    const fake = createFakeCdp({ failingEvaluates: ['storage.key(i)'] });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const summary = session.integrityEvidence();
    expect(summary.browserStateWritten).toBe(false);
    expect(summary.browserStateGaps.map(gap => gap.id)).toEqual(['storage']);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_BROWSER_STATE');
  });

  it('FrameTree 采集失败 → browserStateGaps 缺口', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-browser-state-frametree-fail',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({ failingCommands: ['Page.getFrameTree'] });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const summary = session.integrityEvidence();
    expect(summary.browserStateWritten).toBe(false);
    expect(summary.browserStateGaps.some(gap => gap.id === 'frameTree')).toBe(true);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_BROWSER_STATE');
  });

  // CacheStorage 正文取出但落盘失败，cacheStorageOk 仍为
  // true = 伪装成「已写入」——步骤明细必须翻 false。
  it('CacheStorage 正文落盘失败 → cacheStorage 步骤翻 false → browserStateGaps 缺口', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-browser-state-cache-body-fail',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const responseB64 = Buffer.from('cached-viewer-shell').toString('base64');
    const fake = createFakeCdp({
      cacheStorage: [
        { origin: 'http://bmc.test', cacheName: 'shell', requestUrl: 'http://bmc.test/viewer', responseB64 },
      ],
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    // 正文目标路径预占为目录：storeCacheBody 写入必失败（模拟磁盘故障）
    const bodySha = createHash('sha256').update(Buffer.from(responseB64, 'base64')).digest('hex');
    const bodyDir = join(session.workspace.dir, 'raw', 'browser', 'bodies', bodySha);
    await mkdir(bodyDir, { recursive: true });
    await session.stop();

    const summary = session.integrityEvidence();
    expect(summary.browserStateWritten).toBe(false);
    expect(summary.browserStateGaps.some(gap => gap.id === 'cacheStorage')).toBe(true);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_BROWSER_STATE');
  });

  it('收尾截图失败 → browserStateGaps 缺口（截图也进步骤明细）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-browser-state-screenshot-fail',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({ failingCommands: ['Page.captureScreenshot'] });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const summary = session.integrityEvidence();
    expect(summary.browserStateWritten).toBe(false);
    expect(summary.browserStateGaps.map(gap => gap.id)).toEqual(['stopScreenshot']);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_BROWSER_STATE');
  });

  it('DOM 快照求值失败 → browserStateGaps 缺口（截图与 DOM 快照不是静默步骤）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-browser-state-dom-fail',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({ failingEvaluates: ['document.documentElement'] });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const summary = session.integrityEvidence();
    expect(summary.browserStateWritten).toBe(false);
    expect(summary.browserStateGaps.map(gap => gap.id)).toEqual(['domSnapshot']);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_BROWSER_STATE');
  });

  it('全部状态步骤成功 → browserStateWritten=true 且零缺口（正例）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-browser-state-ok',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      cookies: [{ name: 'session', value: 's1' }],
      storage: { localStorage: { theme: 'dark' }, sessionStorage: { tab: '1' } },
      indexedDb: [{ database: 'app', objectStore: 'kv', record: { key: 'k', value: 'v' } }],
      cacheStorage: [{ origin: 'http://bmc.test', cacheName: 'shell' }],
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const summary = session.integrityEvidence();
    expect(summary.browserStateWritten).toBe(true);
    expect(summary.browserStateGaps).toEqual([]);
    expect(summary.evidenceReferencesClosed).toBe(true);
    expect(summary.evidenceGraphFailures).toEqual([]);
  });

  it('证据图生成失败 → referencesClosed=false → INCOMPLETE_EVIDENCE_REFERENCE', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-evidence-graph-fail',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-login',
      type: 'XHR',
      request: { method: 'POST', url: 'http://bmc.test/api/login', headers: {} },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-login',
      response: { status: 200, headers: { 'set-cookie': 'session=abc' }, mimeType: 'text/plain' },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-login' });
    // ai/value-flow.json 写盘失败（磁盘故障注入）：证据图步骤整体失败
    const originalWrite = session.workspace.writeArtifact;
    vi.spyOn(session.workspace, 'writeArtifact').mockImplementation(async (path, content) => {
      if (path === 'ai/value-flow.json') throw new Error('磁盘写失败（模拟）');
      return originalWrite.call(session.workspace, path, content);
    });
    await session.stop();

    const summary = session.integrityEvidence();
    expect(summary.evidenceReferencesClosed).toBe(false);
    expect(summary.evidenceGraphFailures.length).toBeGreaterThan(0);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_EVIDENCE_REFERENCE');
    expect(derived.gates.find(gate => gate.id === 'evidence-references-closed')?.passed).toBe(false);
    // 收尾不被中断：后续步骤（relations 回填、capture-facts、finalize）照常
    const facts = JSON.parse(
      (await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'),
    ) as { stopped: boolean };
    expect(facts.stopped).toBe(true);
  });

  it('WebSocket 全部双向帧写入 frames.bin，超过旧 64 帧上限', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-ws',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.webSocketCreated', {
      requestId: 'ws-1',
      url: 'ws://bmc.test/kvm',
    });
    fake.emit('Network.webSocketWillSendHandshakeRequest', {
      requestId: 'ws-1',
      request: { headers: { 'Sec-WebSocket-Protocol': 'binary, base64' } },
    });
    fake.emit('Network.webSocketHandshakeResponseReceived', {
      requestId: 'ws-1',
      response: {
        status: 101,
        headers: { 'sec-websocket-protocol': 'binary', 'sec-websocket-extensions': 'permessage-deflate' },
      },
    });
    const payloads: Buffer[] = [];
    for (let index = 0; index < 80; index += 1) {
      const down = Buffer.from(`down-${index}`);
      const up = Buffer.from(`up-${index}`);
      payloads.push(down, up);
      fake.emit('Network.webSocketFrameReceived', {
        requestId: 'ws-1',
        response: { opcode: 2, payloadData: down.toString('base64') },
      });
      fake.emit('Network.webSocketFrameSent', {
        requestId: 'ws-1',
        response: { opcode: 1, payloadData: up.toString('utf8') },
      });
    }
    fake.emit('Network.webSocketClosed', { requestId: 'ws-1' });
    await session.stop();

    const metadata = JSON.parse(
      (await session.workspace.readArtifact('raw/websocket/ws-1/metadata.json')).toString('utf8'),
    );
    expect(metadata).toMatchObject({
      schemaVersion: '2.0.0',
      channelId: 'ws-1',
      url: 'ws://bmc.test/kvm',
      handshakeStatus: 101,
      acceptedSubProtocol: 'binary',
      requestedSubProtocols: ['binary', 'base64'],
      frameCounts: { up: 80, down: 80 },
      framesBinPath: 'raw/websocket/ws-1/frames.bin',
      closedAt: '2026-09-21T01:00:00.000Z',
    });
    const indexRows = jsonl(await session.workspace.readArtifact('raw/websocket/ws-1/frames.index.jsonl'));
    expect(indexRows).toHaveLength(160);
    const framesBin = await session.workspace.readArtifact('raw/websocket/ws-1/frames.bin');
    expect(framesBin.equals(Buffer.concat(payloads))).toBe(true);
    expect(indexRows[0]).toMatchObject({
      frameIndex: 0,
      direction: 'down',
      opcode: 'binary',
      fin: true,
      payloadOffset: 0,
      payloadLength: payloads[0].byteLength,
    });
  });

  it('Worker Target 自动附加：Network.enable 后才 runIfWaitingForDebugger', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-worker',
      rootDir,
      safetyMarginBytes: 1,
    });
    const order: string[] = [];
    const listeners: Array<
      (event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void
    > = [];
    const cdp: CdpSession = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async (command, _params, sessionId) => {
        order.push(sessionId ? `${command}@${sessionId}` : command);
        return {};
      }),
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    await session.attachCdp(cdp, { targetId: 'target-root' });
    for (const listener of listeners) {
      listener(
        {},
        'Target.attachedToTarget',
        {
          sessionId: 'worker-session',
          targetInfo: { type: 'worker', url: 'http://bmc.test/viewer-worker.js', targetId: 'target-worker' },
        },
      );
    }
    await session.stop();
    const workerEnable = order.indexOf('Network.enable@worker-session');
    const workerDebugger = order.indexOf('Debugger.enable@worker-session');
    const workerResume = order.indexOf('Runtime.runIfWaitingForDebugger@worker-session');
    expect(workerEnable).toBeGreaterThanOrEqual(0);
    expect(workerDebugger).toBeGreaterThan(workerEnable);
    expect(workerResume).toBeGreaterThan(workerDebugger);
  });

  it('WebCrypto 挂钩经 binding 写入 crypto.jsonl，输入输出进 BodyStore 且不脱敏', async () => {
    const rootDir = await newRootDir();
    const material = Buffer.from('operator-passphrase:abc');
    const digest = createHash('sha256').update(material).digest();
    const session = await startSession({
      jobId: 'job-collector-crypto',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'crypto',
        op: 'digest',
        algorithm: 'SHA-256',
        algorithmParams: { name: 'SHA-256' },
        inputB64: material.toString('base64'),
        outputB64: digest.toString('base64'),
        scriptUrl: 'http://bmc.test/login:12',
      }),
    });
    await session.stop();

    const rows = jsonl(await session.workspace.readArtifact('raw/runtime/crypto.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'crypto-0001',
      kind: 'digest',
      algorithm: 'SHA-256',
      targetId: 'target-root',
      scriptUrl: 'http://bmc.test/login:12',
    });
    const inputRef = rows[0].inputRef as { sha256: string; bytes: number; path: string };
    const outputRef = rows[0].outputRef as { sha256: string; bytes: number; path: string };
    const storedInput = await session.workspace.readArtifact(inputRef.path);
    const storedOutput = await session.workspace.readArtifact(outputRef.path);
    expect(storedInput.equals(material)).toBe(true);
    expect(storedInput.toString('utf8')).toContain('operator-passphrase');
    expect(storedOutput.equals(digest)).toBe(true);
    expect(inputRef.path).toBe(`raw/runtime/bodies/${inputRef.sha256}`);
  });

  it('Debugger.scriptParsed 拉取源码写入 scripts 索引，Worker 标 kind=worker', async () => {
    const rootDir = await newRootDir();
    const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const session = await startSession({
      jobId: 'job-collector-scripts',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      scriptSources: {
        'script-login': { scriptSource: 'crypto.subtle.digest("SHA-256", material)' },
        'script-worker': { scriptSource: 'self.onmessage = function () {}' },
        'script-wasm': { bytecode: wasmBytes.toString('base64') },
      },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Debugger.scriptParsed', {
      scriptId: 'script-login',
      url: '',
    });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: { type: 'worker', url: 'http://bmc.test/viewer-worker.js', targetId: 'target-worker' },
    });
    fake.emit(
      'Debugger.scriptParsed',
      { scriptId: 'script-worker', url: 'http://bmc.test/viewer-worker.js' },
      'worker-session',
    );
    fake.emit('Debugger.scriptParsed', {
      scriptId: 'script-wasm',
      url: 'http://bmc.test/viewer.wasm',
      scriptLanguage: 'WebAssembly',
    });
    await session.stop();

    const index = JSON.parse((await session.workspace.readArtifact('raw/scripts/index.json')).toString('utf8')) as {
      scripts: Array<Record<string, unknown>>;
    };
    expect(index.scripts).toHaveLength(3);
    const login = index.scripts.find(row => String(row.id).endsWith('script-login'));
    const worker = index.scripts.find(row => String(row.id).endsWith('script-worker'));
    const wasm = index.scripts.find(row => String(row.id).endsWith('script-wasm'));
    expect(login).toMatchObject({ kind: 'inline', targetId: 'target-root' });
    expect(worker).toMatchObject({ kind: 'worker', targetId: 'target-worker' });
    expect(wasm).toMatchObject({ kind: 'wasm' });
    const loginRef = login?.bodyRef as { path: string };
    const wasmRef = wasm?.bodyRef as { path: string };
    expect((await session.workspace.readArtifact(loginRef.path)).toString('utf8')).toContain('SHA-256');
    expect((await session.workspace.readArtifact(wasmRef.path)).equals(wasmBytes)).toBe(true);
  });

  it('采集器内部探针不进入目标脚本索引与源码完整度门禁', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-internal-script-excluded',
      rootDir,
      safetyMarginBytes: 1,
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Debugger.scriptParsed', {
      scriptId: 'internal-environment-probe',
      url: 'kvm-recon-internal://environment.js',
      length: 329,
      hash: 'internal-probe-hash',
    });
    await session.stop();

    const index = JSON.parse(
      (await session.workspace.readArtifact('raw/scripts/index.json')).toString('utf8'),
    ) as { scripts: Array<{ id: string }> };
    expect(index.scripts.some(script => script.id.includes('internal-environment-probe'))).toBe(false);
    expect(fake.commands.filter(command => command === 'Debugger.getScriptSource')).toHaveLength(0);
    expect(session.integrityEvidence().missingWorkerSources).toHaveLength(0);
  });

  it('inline / eval / network script 源码为空也产生缺口，不得只对 Worker/WASM 降级', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-script-empty-source-gap',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      scriptSources: {
        'script-empty-inline': { scriptSource: '' },
        'script-empty-eval': { scriptSource: '' },
        'script-empty-net': { scriptSource: '' },
      },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Debugger.scriptParsed', { scriptId: 'script-empty-inline', url: '' });
    fake.emit('Debugger.scriptParsed', { scriptId: 'script-empty-eval', url: 'eval:1' });
    fake.emit('Debugger.scriptParsed', {
      scriptId: 'script-empty-net',
      url: 'http://bmc.test/empty.js',
    });
    await session.stop();

    // 索引仍登记三条（无源码不等于没发生过），但空源码必须显式作证
    const index = JSON.parse((await session.workspace.readArtifact('raw/scripts/index.json')).toString('utf8')) as {
      scripts: Array<Record<string, unknown>>;
    };
    expect(index.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'inline' }),
        expect.objectContaining({ kind: 'eval' }),
        expect.objectContaining({ kind: 'network-script' }),
      ]),
    );
    const gaps = session.integrityEvidence().missingWorkerSources;
    expect(gaps.filter(gap => String(gap.id).endsWith('script-empty-inline'))).toHaveLength(1);
    expect(gaps.filter(gap => String(gap.id).endsWith('script-empty-eval'))).toHaveLength(1);
    expect(gaps.filter(gap => String(gap.id).endsWith('script-empty-net'))).toHaveLength(1);
    // 缺口映射完整度原因（§14 条 4 门禁 scripts-workers-wasm-complete）
    const derived = derivePackIntegrity(session.integrityEvidence());
    expect(derived.reasons).toContain('INCOMPLETE_WORKER_SOURCE');
  });

  it('getScriptSource 失败且无同 hash 已采副本：任何 kind 都不写假空正文并记缺口', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-script-fetch-failed-policy',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    // 模拟 Chromium 已回收脚本（导航/文档销毁竞态，现场 e2e 观察到的
    // "No script for id" 形态）：getScriptSource 对全部脚本抛错
    const fake = createFakeCdp({ failingCommands: ['Debugger.getScriptSource'] });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Debugger.scriptParsed', {
      scriptId: 'script-inline-gone',
      url: '',
      length: 36155,
      hash: 'hash-inline-gone',
    });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session-gone',
      targetInfo: { type: 'worker', url: 'http://bmc.test/gone-worker.js', targetId: 'target-gone-worker' },
    });
    fake.emit(
      'Debugger.scriptParsed',
      { scriptId: 'script-worker-gone', url: 'http://bmc.test/gone-worker.js', length: 128 },
      'worker-session-gone',
    );
    await session.stop();

    const index = JSON.parse((await session.workspace.readArtifact('raw/scripts/index.json')).toString('utf8')) as {
      scripts: Array<Record<string, unknown>>;
    };
    expect(index.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'inline' }),
        expect.objectContaining({ kind: 'worker' }),
      ]),
    );
    // 两次读失败都显式记账（§3：无记账的静默丢弃等于编造「没有发生过」）
    const dropped = session.evidence().diagnostics().droppedEventByMethod;
    expect(dropped['Debugger.getScriptSource']).toBeGreaterThanOrEqual(2);
    // 源码读失败不能用 0 字节 BodyRef 冒充已采；未找到相同 hash 的已采副本
    // 时任何脚本都影响 §8.3 完整度。
    const gaps = session.integrityEvidence().missingWorkerSources;
    expect(gaps.filter(gap => String(gap.id).endsWith('script-worker-gone'))).toHaveLength(1);
    expect(gaps.filter(gap => String(gap.id).endsWith('script-inline-gone'))).toHaveLength(1);
    for (const script of index.scripts) {
      expect(script).not.toHaveProperty('bodyRef');
    }
  });

  it('scriptParsed length=0 的空脚本：源码为空不记缺口（内容本就为空）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-script-empty-length-zero',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      scriptSources: { 'script-zero': { scriptSource: '' } },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Debugger.scriptParsed', { scriptId: 'script-zero', url: '', length: 0 });
    await session.stop();

    // 0 字节 bodyRef 即完整内容：不是缺口
    const gaps = session.integrityEvidence().missingWorkerSources;
    expect(gaps.filter(gap => String(gap.id).endsWith('script-zero'))).toHaveLength(0);
  });

  it('getScriptSource 失败仅能用相同 CDP hash 的已采正文补全', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-script-hash-reconcile',
      rootDir,
      safetyMarginBytes: 1,
    });
    const source = 'console.log("same source");';
    const fake = createFakeCdp({
      scriptSources: { 'script-kept': { scriptSource: source } },
      failingScriptIds: ['script-gone'],
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Debugger.scriptParsed', {
      scriptId: 'script-kept',
      url: 'http://bmc.test/app.js',
      length: source.length,
      hash: 'cdp-hash-same-source',
    });
    fake.emit('Debugger.scriptParsed', {
      scriptId: 'script-gone',
      url: '',
      length: source.length,
      hash: 'cdp-hash-same-source',
    });
    await session.stop();

    const index = JSON.parse(
      (await session.workspace.readArtifact('raw/scripts/index.json')).toString('utf8'),
    ) as { scripts: Array<{ id: string; bodyRef?: { path: string } }> };
    const kept = index.scripts.find(script => script.id.endsWith('script-kept'))!;
    const reconciled = index.scripts.find(script => script.id.endsWith('script-gone'))!;
    expect(kept.bodyRef?.path).toBeTruthy();
    expect(reconciled.bodyRef).toEqual(kept.bodyRef);
    expect(
      session.integrityEvidence().missingWorkerSources.some(gap =>
        String(gap.id).endsWith('script-gone'),
      ),
    ).toBe(false);
    expect(session.evidence().diagnostics().droppedEventByMethod['Debugger.getScriptSource']).toBe(1);
  });

  it('不同 Target 的相同 CDP scriptId 都写入索引', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-script-id',
      rootDir,
      safetyMarginBytes: 1,
    });
    const fake = createFakeCdp({
      scriptSources: {
        '1': { scriptSource: 'page-script' },
      },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Debugger.scriptParsed', { scriptId: '1', url: 'http://bmc.test/login.js' });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: { type: 'worker', url: 'http://bmc.test/viewer-worker.js', targetId: 'target-worker' },
    });
    fake.emit('Debugger.scriptParsed', { scriptId: '1', url: 'http://bmc.test/viewer-worker.js' }, 'worker-session');
    await session.stop();
    const index = JSON.parse((await session.workspace.readArtifact('raw/scripts/index.json')).toString('utf8')) as {
      scripts: Array<Record<string, unknown>>;
    };
    expect(index.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'network-script', url: 'http://bmc.test/login.js' }),
        expect.objectContaining({ kind: 'worker', url: 'http://bmc.test/viewer-worker.js' }),
      ]),
    );
  });

  it('多根窗口挂载：popup 根独立 debugger，targets 目录带 opener 血缘', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-multi-root',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const main = createFakeCdp();
    const popup = createFakeCdp({
      storage: {
        localStorage: { shared: 'popup-value' },
        sessionStorage: { viewerToken: 'popup-only-token' },
      },
    });
    await session.attachCdp(main.cdp, { targetId: 'target-window-1', windowId: '1', windowRole: 'main' });
    await session.attachCdp(popup.cdp, {
      targetId: 'target-window-2',
      windowId: '2',
      windowRole: 'popup',
      openerTargetId: 'target-window-1',
    });
    main.emit('Network.requestWillBeSent', {
      requestId: 'req-main',
      type: 'Document',
      request: { method: 'GET', url: 'http://bmc.test/login', headers: {} },
    });
    popup.emit('Network.requestWillBeSent', {
      requestId: 'req-popup',
      type: 'Document',
      request: { method: 'GET', url: 'http://bmc.test/popup', headers: {} },
    });
    await session.stop();

    const transactions = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(transactions.some(row => row.url === 'http://bmc.test/login')).toBe(true);
    expect(transactions.some(row => row.url === 'http://bmc.test/popup')).toBe(true);
    const targetsFile = JSON.parse(
      (await session.workspace.readArtifact('catalog/targets.json')).toString('utf8'),
    ) as { targets: Array<Record<string, unknown>> };
    const popupRow = targetsFile.targets.find(row => row.id === 'target-window-2');
    expect(popupRow).toMatchObject({
      type: 'popup',
      attached: true,
      openerTargetId: 'target-window-1',
    });
    const mainRow = targetsFile.targets.find(row => row.id === 'target-window-1');
    expect(mainRow).toMatchObject({ type: 'page', attached: true });
    const summary = session.integrityEvidence();
    expect(summary.collectorReadyBeforeFirstNavigation).toBe(true);
  });

  it('stop 等待已发起的根 target 挂载，迟到附件不会越过终态目录', async () => {
    const rootDir = await newRootDir();
    let releaseAttach!: () => void;
    const attachPromise = new Promise<void>(resolve => {
      releaseAttach = resolve;
    });
    const session = await startSession({
      jobId: 'job-collector-attach-stop-race',
      rootDir,
      safetyMarginBytes: 1,
    });
    const fake = createFakeCdp({ attachPromise });
    const attaching = session.attachCdp(fake.cdp, { targetId: 'target-late' });
    let stopped = false;
    const stopping = session.stop().then(() => {
      stopped = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);

    releaseAttach();
    await attaching;
    await stopping;
    expect(stopped).toBe(true);
    expect(session.workspace.state).toBe('finalized');
    const targetsFile = JSON.parse(
      (await session.workspace.readArtifact('catalog/targets.json')).toString('utf8'),
    ) as { targets: Array<{ id: string }> };
    expect(targetsFile.targets.some(target => target.id === 'target-late')).toBe(true);
  });

  it('收尾快照 Cookie/Storage，并记录 console 与导航时间线', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-browser',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      cookies: [{ name: 'sid', value: 'session-token-plain', domain: 'bmc.test', path: '/' }],
      storage: {
        localStorage: {},
        sessionStorage: { csrfKey: 'csrf-token-plain', viewerKey: 'viewer-token-plain' },
      },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Page.frameNavigated', {
      frame: { id: 'frame-1', url: 'http://bmc.test/login' },
    });
    fake.emit('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ type: 'string', value: 'kvm handshake retry' }],
    });
    await session.stop();

    const storage = JSON.parse((await session.workspace.readArtifact('raw/browser/storage.json')).toString('utf8'));
    expect(storage.cookies).toEqual([
      { name: 'sid', value: 'session-token-plain', domain: 'bmc.test', path: '/' },
    ]);
    expect(storage.sessionStorage).toEqual({
      csrfKey: 'csrf-token-plain',
      viewerKey: 'viewer-token-plain',
    });
    expect(storage.indexedDb).toEqual([]);
    expect(storage.cacheStorage).toEqual([]);
    const consoleRows = jsonl(await session.workspace.readArtifact('raw/browser/console.jsonl'));
    expect(consoleRows[0]).toMatchObject({
      level: 'warning',
      text: 'kvm handshake retry',
      targetId: 'target-root',
    });
    const timeline = jsonl(await session.workspace.readArtifact('raw/browser/timeline.jsonl'));
    expect(timeline[0]).toMatchObject({
      kind: 'navigation',
      url: 'http://bmc.test/login',
    });
  });

  it('观察脚本 action 路由写入 actions.jsonl；垃圾 payload 显式记账不落行', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-actions',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'action',
        actionKind: 'click',
        elementSummary: 'button#login-submit text:"登录"',
        url: 'http://bmc.test/login',
      }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: 'not-json',
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({ kind: 'unknown-kind' }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: 'someone-elses-binding',
      payload: '{}',
    });
    await session.stop();

    const actions = jsonl(await session.workspace.readArtifact('raw/browser/actions.jsonl'));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: 'action-0001',
      kind: 'click',
      targetId: 'target-root',
      elementSummary: 'button#login-submit text:"登录"',
      url: 'http://bmc.test/login',
    });
    const cryptoRows = jsonl(await session.workspace.readArtifact('raw/runtime/crypto.jsonl'));
    expect(cryptoRows).toHaveLength(0);
    const diagnostics = session.evidence().diagnostics();
    expect(diagnostics.droppedEventByMethod['Runtime.bindingCalled']).toBe(2);
  });

  it('观察脚本 render-surface 路由写入 render-surfaces.jsonl；未知 surface 显式记账不落行', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-render-surfaces',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'render-surface',
        surface: 'canvas-context',
        detail: '2d',
      }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'render-surface',
        surface: 'worker',
        detail: 'http://bmc.test/viewer-worker.js',
      }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'render-surface',
        surface: 'holographic-display',
        detail: null,
      }),
    });
    await session.stop();

    const surfaces = jsonl(await session.workspace.readArtifact('raw/browser/render-surfaces.jsonl'));
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0]).toMatchObject({
      id: 'render-0001',
      targetId: 'target-root',
      surface: 'canvas-context',
      detail: '2d',
    });
    expect(surfaces[1]).toMatchObject({
      id: 'render-0002',
      targetId: 'target-root',
      surface: 'worker',
      detail: 'http://bmc.test/viewer-worker.js',
    });
    const diagnostics = session.evidence().diagnostics();
    expect(diagnostics.droppedEventByMethod['Runtime.bindingCalled']).toBe(1);
    // 派生事实快照暴露渲染表面行（§7.3 第 2 组事实进 WorkflowFacts）
    expect(session.workflowFacts().renderSurfaces).toHaveLength(2);
  });

  it('观察脚本钩子安装失败（observer-hook-failed）必须显式记 droppedEvent，不得静默', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-hook-failure',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'observer-hook-failed',
        hook: 'crypto',
        stage: 'install',
        detail: 'subtle is not extensible',
      }),
    });
    await session.stop();

    const diagnostics = session.evidence().diagnostics();
    expect(diagnostics.droppedEventByMethod['observer-hook-failed']).toBe(1);
    // 阶段 3：明细（hook/stage）保留在 diagnostics，供派生折扣与表面条件映射
    expect(diagnostics.observerHookFailures).toEqual([
      { hook: 'crypto', stage: 'install', detail: 'subtle is not extensible' },
    ]);
    // 反例：crypto 钩子失败无对应实时通道观察面 → 不映射 channelGaps（无使用的面不记缺口）
    const summary = session.integrityEvidence();
    expect(summary.channelGaps.some(gap => String(gap.id).startsWith('observer-hook:'))).toBe(false);
    // droppedEvent 记账必须随 capture-facts 落盘进包（进程内计数在导出包里可见）；
    // 快照在收尾序列末尾写入，也包含收尾期的丢带（如 fake CDP 无截图域）
    const facts = JSON.parse(
      (await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'),
    ) as { stopped: boolean; droppedEventByMethod: Record<string, number> | null };
    expect(facts.stopped).toBe(true);
    expect(facts.droppedEventByMethod?.['observer-hook-failed']).toBe(1);
  });

  it('观察脚本 webrtc 钩子失败 + webrtc 通道在场 → channelGaps 表面条件缺口', async () => {
    const rootDir = await newRootDir();
    let clockMs = Date.parse('2026-09-21T01:00:00.000Z');
    const session = await startSession({
      jobId: 'job-collector-hook-surface',
      rootDir,
      safetyMarginBytes: 1,
      now: () => new Date(clockMs).toISOString(),
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    // webrtc 通道在场（观察面真实存在）
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({ kind: 'webrtc', pcId: 'pc-1', eventKind: 'peer-connection-created' }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'observer-hook-failed',
        hook: 'webrtc',
        stage: 'install',
        detail: 'RTCPeerConnection is not extensible',
      }),
    });
    await session.stop();

    // 表面条件映射：webrtc 通道在场 → 钩子失败构成 channelGaps 缺口
    const summary = session.integrityEvidence();
    expect(summary.channelGaps.some(gap => gap.id === 'observer-hook:webrtc/install')).toBe(true);
    // webrtc 钩子失败折扣：webrtc 通道不算双向证据，不派生 KVM_REACHED
    expect(summary.workflowStatus).toBe('TARGET_OPENED');
  });

  it('workflowStatus 派生：Set-Cookie 登录传播（POST + 正文 + 复用）→ LOGIN_REACHED', async () => {
    const rootDir = await newRootDir();
    let clockMs = Date.parse('2026-09-21T01:00:00.000Z');
    const session = await startSession({
      jobId: 'job-collector-login-derive',
      rootDir,
      safetyMarginBytes: 1,
      now: () => new Date(clockMs).toISOString(),
    });
    const fake = createFakeCdp({ postData: { 'req-login': 'user=operator&password=passphrase' } });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-login',
      type: 'XHR',
      request: {
        method: 'POST',
        url: 'http://bmc.test/api/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        hasPostData: true,
      },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-login',
      response: { status: 200, headers: { 'set-cookie': 'sid=abc123; Path=/' } },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-login', encodedDataLength: 4 });
    clockMs += 1000;
    // 之后的请求逐字节携带 Set-Cookie 签发的 name=value（观察到的传播）
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-next',
      type: 'Document',
      request: { method: 'GET', url: 'http://bmc.test/console', headers: { cookie: 'other=1; sid=abc123' } },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-next',
      response: { status: 200, headers: {} },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-next', encodedDataLength: 4 });
    await session.stop();

    const facts = JSON.parse(
      (await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'),
    ) as { workflowStatus: string; evidenceSummary: { workflowStatus: string } };
    expect(facts.workflowStatus).toBe('LOGIN_REACHED');
    expect(facts.evidenceSummary.workflowStatus).toBe('LOGIN_REACHED');
    expect(session.integrityEvidence().workflowStatus).toBe('LOGIN_REACHED');
  });

  it('workflowStatus 派生：fetch 登录的 Set-Cookie 只在 responseReceivedExtraInfo 可见（合并后 LOGIN_REACHED）', async () => {
    const rootDir = await newRootDir();
    let clockMs = Date.parse('2026-09-21T01:00:00.000Z');
    const session = await startSession({
      jobId: 'job-collector-login-extra-info',
      rootDir,
      safetyMarginBytes: 1,
      now: () => new Date(clockMs).toISOString(),
    });
    const fake = createFakeCdp({ postData: { 'req-login': 'user=operator&password=passphrase' } });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-login',
      type: 'Fetch',
      request: {
        method: 'POST',
        url: 'http://bmc.test/api/login',
        headers: { 'content-type': 'application/json' },
        hasPostData: true,
      },
    });
    // Chromium 对 fetch/XHR：responseReceived.headers 不带 Set-Cookie
    fake.emit('Network.responseReceived', {
      requestId: 'req-login',
      hasExtraInfo: true,
      response: { status: 200, headers: { 'content-type': 'application/json' } },
    });
    // Set-Cookie 只在 responseReceivedExtraInfo 里
    fake.emit('Network.responseReceivedExtraInfo', {
      requestId: 'req-login',
      statusCode: 200,
      headers: { 'set-cookie': 'sid=abc123; Path=/' },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-login', encodedDataLength: 4 });
    clockMs += 1000;
    // 后续导航请求的 Cookie 头也只在 requestWillBeSentExtraInfo 里完整可见
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-next',
      type: 'Document',
      request: { method: 'GET', url: 'http://bmc.test/console', headers: {} },
    });
    fake.emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'req-next',
      headers: { cookie: 'sid=abc123' },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-next',
      response: { status: 200, headers: {} },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-next', encodedDataLength: 4 });
    await session.stop();

    const facts = JSON.parse(
      (await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'),
    ) as { workflowStatus: string };
    expect(facts.workflowStatus).toBe('LOGIN_REACHED');
  });

  it('真实 Chromium 事件序：responseReceivedExtraInfo 先于 responseReceived，Set-Cookie 必须存活到提交行', async () => {
    const rootDir = await newRootDir();
    let clockMs = Date.parse('2026-09-21T01:00:00.000Z');
    const session = await startSession({
      jobId: 'job-collector-real-chromium-order',
      rootDir,
      safetyMarginBytes: 1,
      now: () => new Date(clockMs).toISOString(),
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    // 真实 Chromium 对 fetch 的真实事件序（e2e journal 实测）：
    // requestWillBeSent → requestWillBeSentExtraInfo → responseReceivedExtraInfo
    // → responseReceived → dataReceived → loadingFinished
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-login',
      type: 'Fetch',
      request: {
        method: 'POST',
        url: 'http://bmc.test/api/login',
        headers: { 'content-type': 'application/json' },
      },
    });
    fake.emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'req-login',
      headers: { 'user-agent': 'UA' },
    });
    // Set-Cookie 只在 extraInfo 里；responseReceived.headers 不带
    fake.emit('Network.responseReceivedExtraInfo', {
      requestId: 'req-login',
      statusCode: 200,
      headers: { 'set-cookie': 'sid=abc123; Path=/', 'content-type': 'application/json' },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-login',
      response: { status: 200, headers: { 'content-type': 'application/json' } },
    });
    fake.emit('Network.dataReceived', { requestId: 'req-login', dataLength: 4 });
    fake.emit('Network.loadingFinished', { requestId: 'req-login', encodedDataLength: 4 });
    await session.stop();

    // 提交行（磁盘 transactions.jsonl）必须保留 extraInfo 合并的 Set-Cookie
    const diskRows = (await session.workspace.readArtifact('raw/http/transactions.jsonl'))
      .toString('utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { url: string; responseHeaders: Record<string, string> });
    const diskLogin = diskRows.find(row => row.url.includes('/api/login'));
    expect(diskLogin?.responseHeaders['set-cookie']).toBe('sid=abc123; Path=/');
    // 会话事实快照同样可见（value-flow 派生的输入）
    const factsLogin = session
      .workflowFacts()
      .transactions.find(row => row.url.includes('/api/login'));
    expect(factsLogin?.responseHeaders['set-cookie']).toBe('sid=abc123; Path=/');
  });

  it('workflowStatus 派生：点击 + 主框架导航 + 渲染表面 + WS 双向帧 → KVM_REACHED；缺表面（后台告警 WS）→ TARGET_OPENED', async () => {
    const rootDir = await newRootDir();
    let clockMs = Date.parse('2026-09-21T01:00:00.000Z');
    const session = await startSession({
      jobId: 'job-collector-kvm-derive',
      rootDir,
      safetyMarginBytes: 1,
      now: () => new Date(clockMs).toISOString(),
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'action',
        actionKind: 'click',
        elementSummary: 'button#console-open',
        url: 'http://bmc.test/console',
      }),
    });
    clockMs += 1000;
    fake.emit('Page.frameNavigated', { frame: { id: 'frame-root', url: 'http://bmc.test/viewer' } });
    clockMs += 1000;
    fake.emit('Network.webSocketCreated', { requestId: 'ws-1', url: 'ws://bmc.test/stream' });
    fake.emit('Network.webSocketFrameSent', {
      requestId: 'ws-1',
      response: { opcode: 1, payloadData: 'hello' },
    });
    fake.emit('Network.webSocketFrameReceived', {
      requestId: 'ws-1',
      response: { opcode: 1, payloadData: 'frame' },
    });

    // 反例：无渲染/执行表面——登录后 Dashboard 后台告警 WS 不是 KVM
    await session.stop();
    const withoutSurface = JSON.parse(
      (await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'),
    ) as { workflowStatus: string; evidenceSummary: { workflowStatus: string } };
    expect(withoutSurface.workflowStatus).toBe('TARGET_OPENED');
    expect(withoutSurface.evidenceSummary.workflowStatus).toBe('TARGET_OPENED');
    expect(session.integrityEvidence().workflowStatus).toBe('TARGET_OPENED');
  });

  it('workflowStatus 派生正控制：点击 + 导航 + canvas-context 表面 + WS 双向帧 → KVM_REACHED', async () => {
    const rootDir = await newRootDir();
    let clockMs = Date.parse('2026-09-21T01:00:00.000Z');
    const session = await startSession({
      jobId: 'job-collector-kvm-derive-surface',
      rootDir,
      safetyMarginBytes: 1,
      now: () => new Date(clockMs).toISOString(),
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'action',
        actionKind: 'click',
        elementSummary: 'button#console-open',
        url: 'http://bmc.test/console',
      }),
    });
    clockMs += 1000;
    fake.emit('Page.frameNavigated', { frame: { id: 'frame-root', url: 'http://bmc.test/viewer' } });
    clockMs += 1000;
    // §7.3 第 2 组事实：导航后的 Viewer 页面新建渲染表面
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'render-surface',
        surface: 'canvas-context',
        detail: '2d',
      }),
    });
    clockMs += 1000;
    fake.emit('Network.webSocketCreated', { requestId: 'ws-1', url: 'ws://bmc.test/stream' });
    fake.emit('Network.webSocketFrameSent', {
      requestId: 'ws-1',
      response: { opcode: 1, payloadData: 'hello' },
    });
    fake.emit('Network.webSocketFrameReceived', {
      requestId: 'ws-1',
      response: { opcode: 1, payloadData: 'frame' },
    });
    await session.stop();

    const facts = JSON.parse(
      (await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'),
    ) as { workflowStatus: string; evidenceSummary: { workflowStatus: string } };
    expect(facts.workflowStatus).toBe('KVM_REACHED');
    expect(facts.evidenceSummary.workflowStatus).toBe('KVM_REACHED');
    expect(session.integrityEvidence().workflowStatus).toBe('KVM_REACHED');
  });

  // （规范 §7.4「非持续响应正文全部落盘」）：自动收尾看门狗
  // 等待在途非持续请求完成——会话层暴露只读视图。
  it('在途非持续请求视图（§7.4）：未完成在列，EventSource 与已完成不在列', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-pending-non-streaming',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-pending',
      type: 'XHR',
      request: { method: 'GET', url: 'http://bmc.test/api/session', headers: {} },
    });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-es',
      type: 'EventSource',
      request: { method: 'GET', url: 'http://bmc.test/events', headers: {} },
    });
    // 事件链异步串行：等两个 requestWillBeSent 都进事实（输入就绪），
    // 再断言在途视图（被测的分类逻辑）
    await until(async () => {
      try {
        return session.workflowFacts().transactions.some(t => t.id === 'req-es');
      } catch {
        return false;
      }
    });
    expect(session.pendingNonStreamingRequests()).toEqual([
      { id: 'req-pending', url: 'http://bmc.test/api/session' },
    ]);

    // 完成事件到达（loadingFinished → commit 落盘）→ 从在途视图移除
    fake.emit('Network.loadingFinished', { requestId: 'req-pending', encodedDataLength: 2 });
    await until(async () => {
      try {
        const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
        return rows.some(row => row.id === 'req-pending');
      } catch {
        return false;
      }
    });
    expect(session.pendingNonStreamingRequests()).toEqual([]);
    await session.stop();
  });

  // （规范 §7.4「至少完成 Viewer 初始与稳定阶段截图」）：检测到
  // Viewer 活动时对 viewer target 补 viewer-initial 阶段截图（看门狗调用）。
  it('captureViewerInitialScreenshot：viewer target 阶段截图落盘；未知 target 显式记账返回 false', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-viewer-initial',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });

    const ok = await session.captureViewerInitialScreenshot('target-root');
    expect(ok).toBe(true);
    const timeline = jsonl(await session.workspace.readArtifact('raw/browser/timeline.jsonl'));
    const shot = timeline.find(row => row.kind === 'screenshot-saved');
    expect(shot).toMatchObject({ targetId: 'target-root' });
    expect(String(shot?.detail)).toMatch(/-viewer-initial\.png$/);
    await session.workspace
      .readArtifact(String(shot?.detail))
      .then(buffer => expect(buffer.length).toBeGreaterThan(0));

    // 未知根 target：显式记账（droppedEvent），不得静默返回成功
    const missed = await session.captureViewerInitialScreenshot('target-unknown');
    expect(missed).toBe(false);
    const diagnostics = session.evidence().diagnostics();
    expect(diagnostics.droppedEventByMethod['viewer-initial-screenshot']).toBe(1);
    await session.stop();
  });

  it('OOPIF Viewer 用所属根窗口截初始画面，并保留直接父 target 血缘', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-oopif-viewer-initial',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'oopif-session',
      targetInfo: { type: 'iframe', url: 'http://bmc.test/viewer-frame', targetId: 'target-oopif' },
    });
    await until(() => session.workflowFacts().targets.some(target => target.id === 'target-oopif'));

    expect(await session.captureViewerInitialScreenshot('target-oopif')).toBe(true);
    expect(session.integrityEvidence().browserStateGaps).toEqual([]);
    await session.stop();

    const targetsFile = JSON.parse(
      (await session.workspace.readArtifact('catalog/targets.json')).toString('utf8'),
    ) as { targets: Array<Record<string, unknown>> };
    expect(targetsFile.targets.find(target => target.id === 'target-oopif')).toMatchObject({
      type: 'iframe',
      parentTargetId: 'target-root',
    });
    const timeline = jsonl(await session.workspace.readArtifact('raw/browser/timeline.jsonl'));
    expect(
      timeline.some(
        row => row.kind === 'screenshot-saved' && String(row.detail).endsWith('-viewer-initial.png'),
      ),
    ).toBe(true);
  });

  it('手动 stop 等待已发起的 viewer-initial 截图落定后再收尾', async () => {
    const rootDir = await newRootDir();
    let releaseScreenshot!: (value: string) => void;
    const screenshotDataPromise = new Promise<string>(resolve => {
      releaseScreenshot = resolve;
    });
    const session = await startSession({
      jobId: 'job-collector-viewer-initial-stop-race',
      rootDir,
      safetyMarginBytes: 1,
    });
    const fake = createFakeCdp({ screenshotDataPromise });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    const capture = session.captureViewerInitialScreenshot('target-root');
    await until(() => fake.commands.includes('Page.captureScreenshot'));
    let stopped = false;
    const stopping = session.stop().then(() => {
      stopped = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);

    releaseScreenshot('c2NyZWVuc2hvdA==');
    await expect(capture).resolves.toBe(true);
    await stopping;
    expect(stopped).toBe(true);
    const timeline = jsonl(await session.workspace.readArtifact('raw/browser/timeline.jsonl'));
    expect(
      timeline.some(
        row => row.kind === 'screenshot-saved' && String(row.detail).endsWith('-viewer-initial.png'),
      ),
    ).toBe(true);
  });

  // popup Viewer 的最终状态（stop 截图 / DOM 快照）必须从 popup
  // 根采集，不得只采主窗口。
  it('popup 根收尾：stop 截图与 DOM 快照也来自 popup 根（targetId 归属 popup）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-popup-final',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const main = createFakeCdp();
    const popup = createFakeCdp({
      storage: {
        localStorage: { shared: 'popup-value' },
        sessionStorage: { viewerToken: 'popup-only-token' },
      },
    });
    await session.attachCdp(main.cdp, { targetId: 'target-window-1', windowId: '1', windowRole: 'main' });
    await session.attachCdp(popup.cdp, {
      targetId: 'target-window-2',
      windowId: '2',
      windowRole: 'popup',
      openerTargetId: 'target-window-1',
    });
    await session.stop();

    const timeline = jsonl(await session.workspace.readArtifact('raw/browser/timeline.jsonl'));
    const popupShots = timeline.filter(
      row => row.kind === 'screenshot-saved' && row.targetId === 'target-window-2',
    );
    expect(popupShots.length).toBeGreaterThanOrEqual(1);
    expect(String(popupShots[0]?.detail)).toMatch(/-stop\.png$/);
    const popupDom = timeline.filter(
      row => row.kind === 'dom-snapshot-saved' && row.targetId === 'target-window-2',
    );
    expect(popupDom.length).toBeGreaterThanOrEqual(1);
    expect(String(popupDom[0]?.detail)).toMatch(/-stop\.html$/);
    const storage = JSON.parse(
      (await session.workspace.readArtifact('raw/browser/storage.json')).toString('utf8'),
    ) as { additionalContexts?: Array<Record<string, unknown>> };
    expect(storage.additionalContexts).toEqual([
      expect.objectContaining({
        targetId: 'target-window-2',
        sessionStorage: { viewerToken: 'popup-only-token' },
      }),
    ]);
  });

  it('证据图派生：value-flow 边 + relations 结构关系行落盘', async () => {
    const rootDir = await newRootDir();
    let clockMs = Date.parse('2026-09-21T01:00:00.000Z');
    const session = await startSession({
      jobId: 'job-collector-evidence-graph',
      rootDir,
      safetyMarginBytes: 1,
      now: () => new Date(clockMs).toISOString(),
    });
    const material = Buffer.from('operator-passphrase:nonce-0123456789');
    const digest = createHash('sha256').update(material).digest();
    const fake = createFakeCdp({
      postData: { 'req-login': `credential=${digest.toString('hex')}` },
      responseBodies: {
        'req-launch': { body: '{"token":"viewer-token-0123456789"}', base64Encoded: false },
      },
      cookies: [{ name: 'sid', value: 'abc123' }],
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    // 摘要先于登录提交（真实顺序：页面先计算凭据再提交表单）
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'crypto',
        op: 'digest',
        algorithm: 'SHA-256',
        algorithmParams: { name: 'SHA-256' },
        inputB64: material.toString('base64'),
        outputB64: digest.toString('base64'),
        scriptUrl: 'http://bmc.test/login:12',
      }),
    });
    clockMs += 1000;
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-login',
      type: 'XHR',
      request: {
        method: 'POST',
        url: 'http://bmc.test/api/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        hasPostData: true,
      },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-login',
      response: { status: 200, headers: { 'set-cookie': 'sid=abc123; Path=/' } },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-login', encodedDataLength: 4 });
    clockMs += 1000;
    fake.emit('Network.requestWillBeSent', {
      requestId: 'req-launch',
      type: 'XHR',
      request: { method: 'GET', url: 'http://bmc.test/api/launch', headers: { cookie: 'sid=abc123' } },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'req-launch',
      response: { status: 200, headers: { 'content-type': 'application/json' } },
    });
    fake.emit('Network.loadingFinished', { requestId: 'req-launch', encodedDataLength: 4 });
    clockMs += 1000;
    fake.emit('Network.webSocketCreated', {
      requestId: 'ws-1',
      url: 'ws://bmc.test/stream?t=viewer-token-0123456789',
    });
    fake.emit('Network.webSocketWillSendHandshakeRequest', {
      requestId: 'ws-1',
      request: { headers: { cookie: 'sid=abc123' } },
    });
    fake.emit('Network.webSocketHandshakeResponseReceived', {
      requestId: 'ws-1',
      response: { status: 101, headers: {} },
    });
    fake.emit('Network.webSocketFrameSent', {
      requestId: 'ws-1',
      response: { opcode: 1, payloadData: 'hello' },
    });
    fake.emit('Network.webSocketFrameReceived', {
      requestId: 'ws-1',
      response: { opcode: 1, payloadData: 'frame' },
    });
    fake.emit('Network.webSocketClosed', { requestId: 'ws-1' });
    await session.stop();

    const transactions = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    expect(transactions).toHaveLength(2);
    const loginTxId = String(transactions.find(row => row.method === 'POST')?.id);
    const launchTxId = String(transactions.find(row => row.url === 'http://bmc.test/api/launch')?.id);

    // value-flow：cookie 链（Set-Cookie → storage → 请求/WS 握手 Cookie 头）、
    // crypto 链（摘要输出 hex ⊆ 登录正文）、WS 查询参数链全部成边
    const valueFlow = JSON.parse(
      (await session.workspace.readArtifact('ai/value-flow.json')).toString('utf8'),
    ) as {
      nodes: Array<{ id: string; kind: string; evidenceId?: string }>;
      edges: Array<{ from: string; to: string; relation: string; replaySubstitution?: boolean }>;
    };
    const nodesById = new Map(valueFlow.nodes.map(node => [node.id, node]));
    const cookieNode = valueFlow.nodes.find(node => node.kind === 'cookie');
    expect(cookieNode).toBeDefined();
    const headerNodes = valueFlow.nodes.filter(node => node.kind === 'header');
    expect(headerNodes).toHaveLength(2);
    const txHeader = headerNodes.find(node => node.evidenceId === launchTxId);
    const wsHeader = headerNodes.find(node => node.evidenceId === 'ws-1');
    expect(txHeader).toBeDefined();
    expect(wsHeader).toBeDefined();
    for (const header of [txHeader, wsHeader]) {
      const edge = valueFlow.edges.find(candidate => candidate.to === header?.id);
      expect(edge?.relation).toBe('propagated-to');
      expect(edge?.replaySubstitution).toBe(true);
      expect(nodesById.get(edge?.from ?? '')?.kind).toBe('cookie');
    }
    const setCookieNode = valueFlow.nodes.find(node => node.kind === 'http-response' && node.evidenceId === loginTxId);
    expect(setCookieNode).toBeDefined();
    expect(
      valueFlow.edges.some(
        edge => edge.from === setCookieNode?.id && edge.to === cookieNode?.id && edge.relation === 'propagated-to',
      ),
    ).toBe(true);
    const cryptoNode = valueFlow.nodes.find(node => node.kind === 'crypto-output');
    const requestBodyNode = valueFlow.nodes.find(node => node.kind === 'http-request-body' && node.evidenceId === loginTxId);
    expect(cryptoNode).toBeDefined();
    expect(requestBodyNode).toBeDefined();
    expect(
      valueFlow.edges.some(
        edge => edge.from === cryptoNode?.id && edge.to === requestBodyNode?.id && edge.relation === 'used-in',
      ),
    ).toBe(true);
    expect(
      valueFlow.edges.some(
        edge => edge.from === requestBodyNode?.id && edge.to === cryptoNode?.id && edge.relation === 'derived-from',
      ),
    ).toBe(true);
    const urlParamNode = valueFlow.nodes.find(node => node.kind === 'url-param');
    const responseNode = valueFlow.nodes.find(node => node.kind === 'http-response' && node.evidenceId === launchTxId);
    expect(urlParamNode).toBeDefined();
    expect(responseNode).toBeDefined();
    expect(
      valueFlow.edges.some(
        edge => edge.from === responseNode?.id && edge.to === urlParamNode?.id && edge.relation === 'propagated-to',
      ),
    ).toBe(true);

    // relations：initiated（target → 事务）/ opened（target → 通道）/
    // value-flow（与 ai/value-flow.json 的边平行）
    const relations = jsonl(await session.workspace.readArtifact('catalog/relations.jsonl'));
    const initiated = relations.filter(row => row.relation === 'initiated');
    expect(initiated).toHaveLength(2);
    for (const row of initiated) {
      expect(row.from).toBe('target-root');
      expect([loginTxId, launchTxId]).toContain(row.to);
    }
    const opened = relations.filter(row => row.relation === 'opened');
    expect(opened).toEqual([
      { from: 'target-root', to: 'ws-1', relation: 'opened', occurredAt: relations.find(r => r.relation === 'opened')?.occurredAt, evidencePath: 'catalog/channels.json' },
    ]);
    const valueFlowRows = relations.filter(row => row.relation === 'value-flow');
    expect(valueFlowRows).toHaveLength(valueFlow.edges.length);
    for (const row of valueFlowRows) {
      expect(valueFlow.nodes.some(node => node.id === row.from)).toBe(true);
      expect(valueFlow.nodes.some(node => node.id === row.to)).toBe(true);
    }
  });

  it('WS FIN 后视推导（不伪造）：continuation 首帧 fin=false；close 后到达帧记缺口', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-ws-fin',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.webSocketCreated', { requestId: 'ws-fin', url: 'ws://bmc.test/kvm' });
    fake.emit('Network.webSocketFrameReceived', {
      requestId: 'ws-fin',
      response: { opcode: 2, payloadData: Buffer.from('hello').toString('base64') },
    });
    fake.emit('Network.webSocketFrameReceived', {
      requestId: 'ws-fin',
      response: { opcode: 0, payloadData: Buffer.from('-fragment').toString('base64') },
    });
    fake.emit('Network.webSocketFrameSent', {
      requestId: 'ws-fin',
      response: { opcode: 1, payloadData: 'next-message' },
    });
    fake.emit('Network.webSocketClosed', { requestId: 'ws-fin' });
    // 反例：关闭后到达的帧必须显式记账，不能悄悄追加
    fake.emit('Network.webSocketFrameReceived', {
      requestId: 'ws-fin',
      response: { opcode: 2, payloadData: Buffer.from('late').toString('base64') },
    });
    await session.stop();

    const indexRows = jsonl(await session.workspace.readArtifact('raw/websocket/ws-fin/frames.index.jsonl'));
    expect(indexRows).toHaveLength(3);
    expect(indexRows.map(row => row.fin)).toEqual([false, true, true]);
    const framesBin = await session.workspace.readArtifact('raw/websocket/ws-fin/frames.bin');
    expect(framesBin.equals(Buffer.concat([Buffer.from('hello'), Buffer.from('-fragment'), Buffer.from('next-message')]))).toBe(true);
    const summary = session.integrityEvidence();
    expect(summary.channelGaps.some(gap => gap.id === 'ws-fin')).toBe(true);
  });

  it('WebRTC / WebTransport / SSE / 下载：行落盘 + 消息进 BodyStore + 不可观测通道显式缺口', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-realtime',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    const message = Buffer.from('kvm-frame-payload');
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({ kind: 'webrtc', pcId: 'pc-1', eventKind: 'peer-connection-created' }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'webrtc',
        pcId: 'pc-1',
        eventKind: 'datachannel-message',
        direction: 'down',
        dataChannelId: 'control',
        messageIndex: 0,
        fin: true,
        messageB64: message.toString('base64'),
      }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({ kind: 'webtransport', wtId: 'wt-1', eventKind: 'created', url: 'https://bmc.test/wt' }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({ kind: 'sse', sseId: 'sse-1', eventKind: 'connected', url: 'http://bmc.test/events' }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({
        kind: 'sse',
        sseId: 'sse-1',
        eventKind: 'event',
        serverEventId: '42',
        dataB64: Buffer.from('data: field value').toString('base64'),
      }),
    });
    fake.emit('Browser.downloadWillBegin', {
      guid: 'dl-1',
      url: 'http://bmc.test/firmware.bin',
      suggestedFilename: 'firmware.bin',
    });
    fake.emit('Browser.downloadProgress', { guid: 'dl-1', state: 'Completed' });
    await session.stop();

    const webrtc = jsonl(await session.workspace.readArtifact('raw/realtime/webrtc.jsonl'));
    expect(webrtc).toHaveLength(2);
    expect(webrtc[1]).toMatchObject({
      peerConnectionId: 'pc-1',
      kind: 'datachannel-message',
      direction: 'down',
      dataChannelId: 'control',
      messageIndex: 0,
      fin: true,
    });
    const messageRef = webrtc[1].messageRef as { sha256: string; bytes: number; path: string };
    expect(messageRef.path).toBe(`raw/realtime/bodies/${messageRef.sha256}`);
    expect((await session.workspace.readArtifact(messageRef.path)).equals(message)).toBe(true);

    const webtransport = jsonl(await session.workspace.readArtifact('raw/realtime/webtransport.jsonl'));
    expect(webtransport).toHaveLength(1);
    expect(webtransport[0]).toMatchObject({ transportId: 'wt-1', kind: 'created' });

    const sse = jsonl(await session.workspace.readArtifact('raw/realtime/sse.jsonl'));
    expect(sse).toHaveLength(2);
    expect(sse[1]).toMatchObject({ id: 'sse-1', kind: 'event', serverEventId: '42' });
    const dataRef = sse[1].dataRef as { sha256: string; path: string };
    expect((await session.workspace.readArtifact(dataRef.path)).toString('utf8')).toBe('data: field value');

    const downloads = jsonl(await session.workspace.readArtifact('raw/realtime/downloads.jsonl'));
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).toMatchObject({ id: 'dl-1', completed: true, suggestedFileName: 'firmware.bin' });

    const channels = JSON.parse(
      (await session.workspace.readArtifact('catalog/channels.json')).toString('utf8'),
    ) as { channels: Array<Record<string, unknown>> };
    const byId = new Map(channels.channels.map(row => [String(row.id), row]));
    expect(byId.get('pc-1')).toMatchObject({ kind: 'webrtc', frameCounts: { up: 0, down: 1 } });
    expect(byId.get('wt-1')).toMatchObject({ kind: 'webtransport', frameCounts: null });
    expect(byId.get('sse-1')).toMatchObject({ kind: 'sse', frameCounts: { up: 0, down: 1 } });
    expect(byId.get('dl-1')).toMatchObject({ kind: 'download' });

    // 反例：不可观测通道必须显式记账，不能假装已采集
    const summary = session.integrityEvidence();
    expect(summary.unsupportedChannels.some(gap => gap.id === 'wt-1')).toBe(true);
    expect(summary.unsupportedChannels.some(gap => gap.id === 'dl-1')).toBe(true);
  });

  it('NetLog 源流式包装进包，constants 原样透传', async () => {
    const rootDir = await newRootDir();
    const sourcePath = join(rootDir, 'netlog-src.json');
    await writeFile(
      sourcePath,
      JSON.stringify({
        constants: { logEventTypes: { 1: 'TYPE_A', 2: 'TYPE_B' }, unknownFutureField: { keep: true } },
        events: [
          { time: '1', type: 1, phase: 1 },
          { time: '2', type: 2, phase: 1 },
          { time: '3', type: 1, phase: 2, params: { url: 'http://bmc.test/login' } },
        ],
      }),
    );
    const session = await startSession({
      jobId: 'job-collector-netlog',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
      netlog: {
        start: async () => {},
        stop: async () => ({ sourcePath, captureMode: 'include-sensitive' }),
      },
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const netlog = JSON.parse((await session.workspace.readArtifact('raw/netlog/netlog.json')).toString('utf8'));
    expect(netlog.schemaVersion).toBe('2.0.0');
    expect(netlog.captureMode).toBe('include-sensitive');
    expect(netlog.events).toHaveLength(3);
    expect(netlog.events[2]).toMatchObject({ time: '3', type: 1, phase: 2 });
    expect(netlog.constants).toEqual({
      logEventTypes: { 1: 'TYPE_A', 2: 'TYPE_B' },
      unknownFutureField: { keep: true },
    });
  });

  it('NetLog 残缺源（截断 JSON）不输出静默截断副本：落兜底文件并记账', async () => {
    const rootDir = await newRootDir();
    const sourcePath = join(rootDir, 'netlog-broken.json');
    await writeFile(sourcePath, '{"constants": {"a": 1}, "events": [{ "time": 1,');
    const session = await startSession({
      jobId: 'job-collector-netlog-broken',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
      netlog: {
        start: async () => {},
        stop: async () => ({ sourcePath, captureMode: 'include-sensitive' }),
      },
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const netlog = JSON.parse((await session.workspace.readArtifact('raw/netlog/netlog.json')).toString('utf8'));
    expect(netlog).toMatchObject({ schemaVersion: '2.0.0', captureMode: 'capture-failed', events: [] });
    expect(session.evidence().diagnostics().droppedEventByMethod['netlog-wrap']).toBe(1);
  });

  it('HAR 互操作副本：文本正文内嵌，二进制正文记 size + bodyRef 注释', async () => {
    const rootDir = await newRootDir();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const session = await startSession({
      jobId: 'job-collector-har',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp({
      responseBodies: {
        'req-binary': { body: pngBytes.toString('base64'), base64Encoded: true },
        'req-text': { body: '{"rows":[1,2,3]}', base64Encoded: false },
      },
      postData: { 'req-text': 'user=operator&password=operator-passphrase' },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    for (const [requestId, url, resourceType, contentType] of [
      ['req-binary', 'http://bmc.test/logo.png', 'Image', 'image/png'],
      ['req-text', 'http://bmc.test/api/login', 'XHR', 'application/json'],
    ] as const) {
      fake.emit('Network.requestWillBeSent', {
        requestId,
        type: resourceType,
        request: {
          method: requestId === 'req-text' ? 'POST' : 'GET',
          url,
          headers: {
            ...(requestId === 'req-text' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          },
          hasPostData: requestId === 'req-text',
        },
      });
      fake.emit('Network.responseReceived', {
        requestId,
        response: { status: 200, headers: { 'content-type': contentType } },
      });
      fake.emit('Network.loadingFinished', { requestId });
    }
    await session.stop();

    const har = JSON.parse((await session.workspace.readArtifact('raw/http/session.har')).toString('utf8')) as {
      log: {
        version: string;
        entries: Array<{
          request: { url: string; postData?: { text: string } };
          response: { content: { size: number; mimeType: string; text?: string; comment?: string } };
        }>;
      };
    };
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(2);
    const [binary, text] = har.log.entries;
    expect(binary.response.content.comment).toContain('raw/http/bodies/');
    expect(binary.response.content.size).toBe(pngBytes.byteLength);
    expect(binary.response.content.mimeType).toBe('image/png');
    expect(binary.response.content.text).toBe('');
    expect(text.request.postData?.text).toBe('user=operator&password=operator-passphrase');
    expect(text.response.content.text).toBe('{"rows":[1,2,3]}');
  });

  it('targets 目录：attach/detach/destroy 生命周期与 popup 血缘', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-collector-targets',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Target.attachedToTarget', {
      sessionId: 'worker-session',
      targetInfo: { type: 'worker', url: 'http://bmc.test/viewer-worker.js', targetId: 'target-worker' },
    });
    fake.emit('Target.targetCreated', {
      targetInfo: { targetId: 't-popup', type: 'page', url: 'http://bmc.test/popup', openerId: 'target-root' },
    });
    fake.emit('Target.detachedFromTarget', { sessionId: 'worker-session', targetId: 'target-worker' });
    fake.emit('Target.targetDestroyed', { targetId: 't-popup' });
    await session.stop();

    const targetsFile = JSON.parse(
      (await session.workspace.readArtifact('catalog/targets.json')).toString('utf8'),
    ) as { targets: Array<Record<string, unknown>> };
    const byId = new Map(targetsFile.targets.map(row => [String(row.id), row]));
    expect(byId.get('target-root')).toMatchObject({ type: 'page', attached: true });
    expect(byId.get('target-worker')).toMatchObject({ type: 'worker', attached: false, detachReason: 'detached' });
    expect(byId.get('t-popup')).toMatchObject({
      type: 'popup',
      attached: false,
      detachReason: 'destroyed',
      openerTargetId: 'target-root',
    });
    const rawTargets = JSON.parse(
      (await session.workspace.readArtifact('raw/browser/targets.json')).toString('utf8'),
    ) as { targets: Array<Record<string, unknown>> };
    expect(rawTargets.targets).toHaveLength(targetsFile.targets.length);
  });

  it('主框架导航点截图 + DOM 快照落盘；环境合并页面侧与主进程侧', async () => {
    const rootDir = await newRootDir();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const session = await startSession({
      jobId: 'job-collector-screenshot',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
      mainEnvironment: { chromium: '140.0.0', electron: '44.0.0', os: 'darwin 25.6.0' },
    });
    const fake = createFakeCdp({
      screenshotData: pngBytes.toString('base64'),
      domHtml: '<html><body>viewer-stable</body></html>',
      environment: { userAgent: 'Mozilla/5.0 KVM-Recon-Test', language: 'zh-CN', timezone: 'Asia/Shanghai', screen: '1024x768x24' },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Page.frameNavigated', {
      frame: { id: 'frame-1', url: 'http://bmc.test/viewer' },
    });
    await session.stop();

    const paths = await session.workspace.artifactPaths();
    const screenshotPaths = paths.filter(path => path.startsWith('raw/browser/screenshots/'));
    expect(screenshotPaths).toHaveLength(2);
    const domPaths = paths.filter(path => path.startsWith('raw/browser/dom-snapshots/'));
    expect(domPaths).toHaveLength(2);
    expect((await session.workspace.readArtifact(domPaths[0])).toString('utf8')).toContain('viewer-stable');
    const timeline = jsonl(await session.workspace.readArtifact('raw/browser/timeline.jsonl'));
    expect(timeline.some(row => row.kind === 'screenshot-saved' && String(row.detail).startsWith('raw/browser/screenshots/'))).toBe(true);
    expect(timeline.some(row => row.kind === 'dom-snapshot-saved' && String(row.detail).startsWith('raw/browser/dom-snapshots/'))).toBe(true);
    expect(session.environment()).toEqual({
      chromium: '140.0.0',
      electron: '44.0.0',
      os: 'darwin 25.6.0',
      userAgent: 'Mozilla/5.0 KVM-Recon-Test',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
      screen: '1024x768x24',
    });
  });

  it('capture-facts：挂载后即落 v1（target / 环境），stop 覆写终态（证据摘要 + stopped）', async () => {
    const rootDir = await newRootDir();
    const fake = createFakeCdp({
      environment: { userAgent: 'Mozilla/5.0 KVM-Recon-Facts', language: 'zh-CN', timezone: 'Asia/Shanghai', screen: '1024x768x24' },
    });
    const session = await startSession({
      jobId: 'job-collector-facts',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
      deviceLabel: '测试 BMC / 未知厂商',
      mainEnvironment: { chromium: '152.0.7977.76', electron: '44.3.0', os: 'darwin 25.6.0' },
    });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });

    // v1：未收尾（stopped=false、无证据摘要），但 target 与真实环境已在盘——
    // 硬崩溃后恢复导出仍能装配 manifest，不需要内存态。
    const v1 = JSON.parse((await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'));
    expect(v1.stopped).toBe(false);
    expect(v1.evidenceSummary).toBeNull();
    expect(v1.target).toEqual({ host: '10.10.8.111', port: 8443, scheme: 'https' });
    expect(v1.environment).toEqual({
      chromium: '152.0.7977.76',
      electron: '44.3.0',
      os: 'darwin 25.6.0',
      userAgent: 'Mozilla/5.0 KVM-Recon-Facts',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
      screen: '1024x768x24',
    });
    expect(v1.workflowStatus).toBe('TARGET_OPENED');

    await session.stop();
    const final = JSON.parse((await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'));
    expect(final.stopped).toBe(true);
    expect(typeof final.endedAt).toBe('string');
    expect(final.evidenceSummary.collectorReadyBeforeFirstNavigation).toBe(true);
    expect(final.evidenceSummary.rawJournalsClosed).toBe(true);
    expect(final.evidenceSummary.browserStateWritten).toBe(true);
    expect(final.evidenceSummary.evidenceReferencesClosed).toBe(true);
    expect(final.evidenceSummary.workflowStatus).toBe('TARGET_OPENED');
    expect(session.environment()?.userAgent).toBe('Mozilla/5.0 KVM-Recon-Facts');
  });

  it('stop() 幂等：重复收尾不重放，netlog 不被 capture-failed 兜底覆盖', async () => {
    // 反例：首次收尾成功后重入 stop()，会把已写好的 netlog.json
    // 覆盖成 capture-failed 兜底（electronNetlogSource 第二次 stop 返回 null）。
    const makeNetlog = (sourcePath: string) => {
      let stops = 0;
      return {
        stopCalls: () => stops,
        source: {
          start: async () => {},
          stop: async (): Promise<{ sourcePath: string; captureMode: string } | null> => {
            stops += 1;
            return stops === 1 ? { sourcePath, captureMode: 'include-sensitive' } : null;
          },
        },
      };
    };
    const sharedRoot = await newRootDir();
    await writeFile(
      join(sharedRoot, 'netlog-src.json'),
      JSON.stringify({ constants: { a: 1 }, events: [{ time: '1', type: 1 }] }),
    );

    // 顺序重入
    const sequential = await startSession({
      jobId: 'job-stop-idempotent',
      rootDir: sharedRoot,
      safetyMarginBytes: 1,
      netlog: makeNetlog(join(sharedRoot, 'netlog-src.json')).source,
    });
    const fake = createFakeCdp();
    await sequential.attachCdp(fake.cdp, { targetId: 'target-root' });
    await sequential.stop();
    const firstNetlog = (await sequential.workspace.readArtifact('raw/netlog/netlog.json')).toString('utf8');
    await sequential.stop();
    const secondNetlog = (await sequential.workspace.readArtifact('raw/netlog/netlog.json')).toString('utf8');
    expect(JSON.parse(secondNetlog).captureMode).toBe('include-sensitive');
    expect(secondNetlog).toBe(firstNetlog);

    // 并发重入：共享同一次收尾（独立 rootDir，避免上一作业未导出拦截）
    const concurrentNetlog = makeNetlog(join(sharedRoot, 'netlog-src.json'));
    const concurrent = await startSession({
      jobId: 'job-stop-concurrent',
      rootDir: await newRootDir(),
      safetyMarginBytes: 1,
      netlog: concurrentNetlog.source,
    });
    await concurrent.attachCdp(createFakeCdp().cdp, { targetId: 'target-root' });
    await Promise.all([concurrent.stop(), concurrent.stop()]);
    const netlog = JSON.parse(
      (await concurrent.workspace.readArtifact('raw/netlog/netlog.json')).toString('utf8'),
    );
    expect(netlog.captureMode).toBe('include-sensitive');
    expect(netlog.events).toHaveLength(1);
    expect(concurrentNetlog.stopCalls()).toBe(1);
  });

  it('全部根挂载失败：仍落诚实 storage.json 兜底，收尾不被中止', async () => {
    // 反例：primary 为 null 时 snapshotBrowserState 被跳过，
    // raw/browser/storage.json 从未写入 → 导出门禁 REQUIRED_FILE_MISSING。
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-stop-no-attach',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    await session.stop();

    const storage = JSON.parse(
      (await session.workspace.readArtifact('raw/browser/storage.json')).toString('utf8'),
    );
    expect(storage).toMatchObject({
      schemaVersion: '2.0.0',
      cookies: [],
      localStorage: {},
      sessionStorage: {},
      indexedDb: [],
      cacheStorage: [],
    });
    // 收尾其余必需工件不受影响
    const targets = JSON.parse(
      (await session.workspace.readArtifact('catalog/targets.json')).toString('utf8'),
    );
    expect(targets.targets).toEqual([]);
    expect(JSON.parse((await session.workspace.readArtifact('catalog/channels.json')).toString('utf8')).channels).toEqual([]);
    const facts = JSON.parse(
      (await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'),
    );
    expect(facts.stopped).toBe(true);
    expect(facts.evidenceSummary.browserStateWritten).toBe(false);
  });

  it('attach 失败清理：移除 message 监听并 detach，不留活监听器', async () => {
    // 反例：Network.enable 失败抛出后，message 监听器仍挂着，
    // 事件继续进孤儿队列，debugger 不 detach。
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-attach-cleanup',
      rootDir,
      safetyMarginBytes: 1,
    });
    const calls: string[] = [];
    const listeners: unknown[] = [];
    const cdp: CdpSession = {
      async attach() {
        calls.push('attach');
      },
      sendCommand(command: string) {
        if (command === 'Network.enable') {
          return Promise.reject(new Error('Network.enable timed out'));
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') {
          calls.push('on');
          listeners.push(listener);
        }
      },
      off(event) {
        if (event === 'message') {
          calls.push('off');
          listeners.length = 0;
        }
      },
      async detach() {
        calls.push('detach');
      },
    };
    await expect(session.attachCdp(cdp, { targetId: 'target-root' })).rejects.toThrow('Network.enable');
    expect(calls).toContain('off');
    expect(calls).toContain('detach');
    expect(listeners).toHaveLength(0);
  });

  it('挂载中途失败：已记录事务的根 target 必须补 attached=false 行，relations 不得引用未知 ID', async () => {
    // 反例（e2e close-before-assert 实测）：弹窗 attach 的 enable 序列中途失败，
    // 但 message 监听在序列前已注册，POST 事务已进共享 collector 且
    // targetId=target-window-3；target 行只在序列末尾 upsert——失败即丢弃，
    // catalog/targets.json 缺行 → relations.jsonl 引用未知 ID → 导出被拒。
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-attach-midfail-salvage',
      rootDir,
      safetyMarginBytes: 1,
    });
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const cdp: CdpSession = {
      async attach() {},
      sendCommand(command: string) {
        // Network.enable 成功（事务能记录），后续 enable 中途失败
        if (command === 'Page.enable') {
          return Promise.reject(new Error('Page.enable timed out'));
        }
        return {};
      },
      on(event, listener) {
        if (event === 'message') listeners.push(listener as typeof listeners[number]);
      },
      off() {},
      async detach() {},
    };
    const pending = session.attachCdp(cdp, {
      targetId: 'target-window-3',
      windowId: '3',
      windowRole: 'popup',
      openerTargetId: 'target-root',
    });
    // 监听在 attach 序列前已注册：事件在序列失败前即可进入共享 collector
    for (const listener of [...listeners]) {
      listener({}, 'Network.requestWillBeSent', {
        requestId: 'r1',
        request: { method: 'POST', url: 'https://bmc.test/form-target', headers: {} },
      });
    }
    await expect(pending).rejects.toThrow('Page.enable');
    // 失败附件不在 attachments 里，事件链自行落盘：等事务行出现
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const rows = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
        if (rows.some(row => row.targetId === 'target-window-3')) break;
      } catch {
        // 尚未落盘
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await session.stop();

    const targets = JSON.parse(
      (await session.workspace.readArtifact('catalog/targets.json')).toString('utf8'),
    ) as { targets: Array<{ id: string; attached: boolean; detachReason?: string }> };
    const salvaged = targets.targets.find(row => row.id === 'target-window-3');
    expect(salvaged).toMatchObject({
      attached: false,
      detachReason: 'attach-failed',
    });
    // relations 的 from 必须全部落在已知 target 上（UNKNOWN_EVIDENCE_ID 门禁的会话内等价断言）
    const relations = jsonl(await session.workspace.readArtifact('catalog/relations.jsonl'));
    const initiated = relations.filter(row => row.relation === 'initiated');
    expect(initiated.some(row => row.from === 'target-window-3')).toBe(true);
    for (const row of initiated) {
      expect(targets.targets.some(target => target.id === row.from)).toBe(true);
    }
  });

  it('HAR 构建失败：落显式兜底 HAR（空 entries + 失败注释）并记账，后续收尾不中止', async () => {
    // 反例：HAR 构建抛错时 stop() 直接中止，targets/channels/facts 全没写。
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-har-fallback',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { method: 'GET', url: 'https://bmc.test/login', headers: {} },
    });
    fake.emit('Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, headers: {}, timing: {} },
    });
    fake.emit('Network.loadingFinished', { requestId: 'r1' });
    await session.drain();
    // 直接写一行残缺事务行，让 HAR 构建在流式读入时抛错
    await session.workspace.appendJsonl('raw/http/transactions.jsonl', { broken: true });
    await session.stop();

    const har = JSON.parse((await session.workspace.readArtifact('raw/http/session.har')).toString('utf8'));
    expect(har.log.entries).toEqual([]);
    expect(String(har.log.comment)).toContain('HAR 构建失败');
    expect(session.evidence().diagnostics().droppedEventByMethod['har-build']).toBe(1);
    // 后续收尾步骤不被中止：目录与终态 facts 仍在
    expect(
      JSON.parse((await session.workspace.readArtifact('catalog/targets.json')).toString('utf8')).targets.length,
    ).toBeGreaterThan(0);
    const facts = JSON.parse(
      (await session.workspace.readArtifact('catalog/capture-facts.json')).toString('utf8'),
    );
    expect(facts.stopped).toBe(true);
    expect(facts.evidenceSummary.rawJournalsClosed).toBe(true);
  });

  it('SSE 未知 eventKind：丢弃并记账，不伪造成 closed', async () => {
    // 反例：页面可任意调用 binding，未知 kind 被映射为 closed，
    // 通道在目录里被误关闭。
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-sse-unknown-kind',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({ kind: 'sse', sseId: 'sse-9', eventKind: 'totally-bogus', url: 'https://bmc.test/sse' }),
    });
    fake.emit('Runtime.bindingCalled', {
      name: '__kvmReconObserver',
      payload: JSON.stringify({ kind: 'sse', sseId: 'sse-9', eventKind: 'connected', url: 'https://bmc.test/sse' }),
    });
    await session.stop();

    const sse = jsonl(await session.workspace.readArtifact('raw/realtime/sse.jsonl'));
    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({ id: 'sse-9', kind: 'connected' });
    expect(session.evidence().diagnostics().droppedEventByMethod['sse-observer']).toBe(1);
    const channels = JSON.parse(
      (await session.workspace.readArtifact('catalog/channels.json')).toString('utf8'),
    ) as { channels: Array<Record<string, unknown>> };
    const sseChannel = channels.channels.find(row => row.id === 'sse-9');
    expect(sseChannel).toMatchObject({ kind: 'sse', closedAt: null });
  });

  it('WS 目录名碰撞：不同 channelId 各自目录，不互相覆盖', async () => {
    // 反例：'a b' 与 'a_b' 清洗后同名，第二个 open 覆盖第一个 socket。
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-ws-dir-collision',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    for (const requestId of ['a b', 'a_b']) {
      fake.emit('Network.webSocketCreated', { requestId, url: `ws://bmc.test/${requestId}` });
      // opcode 1 = 文本帧：CDP 以明文传 payloadData（base64 只用于二进制帧）
      fake.emit('Network.webSocketFrameReceived', {
        requestId,
        response: { opcode: 1, payloadData: `frame-${requestId}` },
      });
      fake.emit('Network.webSocketClosed', { requestId });
    }
    await session.stop();

    const channels = JSON.parse(
      (await session.workspace.readArtifact('catalog/channels.json')).toString('utf8'),
    ) as { channels: Array<Record<string, unknown>> };
    const wsChannels = channels.channels.filter(row => row.kind === 'websocket');
    expect(wsChannels).toHaveLength(2);
    const paths = wsChannels.map(row => row.payloadPath);
    expect(new Set(paths).size).toBe(2);
    for (const channel of wsChannels) {
      const framesBin = await session.workspace.readArtifact(String(channel.payloadPath));
      const expected = Buffer.from(`frame-${String(channel.id)}`);
      expect(framesBin.equals(expected)).toBe(true);
      expect((channel.frameCounts as { down: number }).down).toBe(1);
    }
  });

  it('closed 阶段事件丢弃显式记账（不静默）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-closed-drop-accounting',
      rootDir,
      safetyMarginBytes: 1,
    });
    const fake = createFakeCdp();
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();
    fake.emit('Network.webSocketCreated', { requestId: 'ws-late', url: 'ws://bmc.test/late' });
    expect(session.evidence().diagnostics().droppedEventByMethod['Network.webSocketCreated']).toBe(1);
  });

  it('drain 阶段事件丢弃显式记账（Promise 门控，不靠 sleep）', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-drain-drop-accounting',
      rootDir,
      safetyMarginBytes: 1,
    });
    let releaseBody!: (value: { body: string; base64Encoded?: boolean }) => void;
    const bodyGate = new Promise<{ body: string; base64Encoded?: boolean }>(resolve => {
      releaseBody = resolve;
    });
    const listeners: Array<(event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const cdp: CdpSession = {
      async attach() {},
      sendCommand: electronLikeSendCommand(async (command: string) => {
        if (command === 'Network.getResponseBody') return bodyGate;
        return {};
      }),
      on(event, listener) {
        if (event === 'message') listeners.push(listener);
      },
    };
    const emit = (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params, undefined);
    };
    await session.attachCdp(cdp, { targetId: 'target-root' });
    emit('Network.requestWillBeSent', {
      requestId: 'r-gated',
      request: { method: 'GET', url: 'https://bmc.test/gated', headers: {} },
    });
    emit('Network.responseReceived', {
      requestId: 'r-gated',
      response: { status: 200, headers: {}, timing: {} },
    });
    emit('Network.loadingFinished', { requestId: 'r-gated' });
    // 等事件链跑到 getResponseBody 的门上（事件队列挂起）
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const stopping = session.stop();
    await new Promise(resolve => setImmediate(resolve));
    // 此刻 stopAccepting 已执行（drain 阶段）：晚到的非 drain 事件被丢弃并记账
    emit('Network.webSocketCreated', { requestId: 'ws-drain-late', url: 'ws://bmc.test/drain-late' });
    expect(session.evidence().diagnostics().droppedEventByMethod['Network.webSocketCreated']).toBe(1);
    releaseBody({ body: '{"ok":true}', base64Encoded: false });
    await stopping;
  });

  it('快照命令无响应时有界收尾：stop() 不被 getCookies / storage 求值挂起', async () => {
    // 反例：Network.getCookies 与 storage Runtime.evaluate 直 await 无超时，
    // 渲染进程挂死时 stop() 永久挂起，INCOMPLETE 包无法导出。
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    vi.useFakeTimers();
    try {
      const rootDir = await newRootDir();
      const session = await startSession({
        jobId: 'job-snapshot-timeout',
        rootDir,
        safetyMarginBytes: 1,
      });
      const base = createFakeCdp();
      const never = new Promise<never>(() => {});
      const forward = (command: string, params?: Record<string, unknown>, sessionId?: string) =>
        sessionId === undefined
          ? base.cdp.sendCommand(command, params)
          : base.cdp.sendCommand(command, params, sessionId);
      const cdp: CdpSession = {
        async attach() {},
        sendCommand: electronLikeSendCommand((command, params, sessionId) => {
          if (command === 'Network.getCookies') return never as unknown as Promise<unknown>;
          if (
            command === 'Runtime.evaluate' &&
            String((params as { expression?: unknown })?.expression ?? '').includes('sessionStorage')
          ) {
            return never as unknown as Promise<unknown>;
          }
          return forward(command, params, sessionId);
        }),
        on(event, listener) {
          base.cdp.on(event, listener);
        },
      };
      await session.attachCdp(cdp, { targetId: 'target-root' });
      const stopping = session.stop();
      // 小步推进假时钟（每步让出事件循环，真实 fs IO 得以推进）；
      // 后注册的 30s 超时定时器在后续推进中触发
      let done = false;
      stopping.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      // 两条挂起命令各 30s 假时钟超时，推进预算 150s（每轮让出真实 macrotask
      // 供 stop 链的 fs 回调运行）
      for (let round = 0; round < 1500 && !done; round += 1) {
        await vi.advanceTimersByTimeAsync(100);
        // 真实 macrotask 让步：事件循环 poll 阶段处理 stop 链里的真实 fs 回调
        await new Promise<void>(resolve => {
          realSetTimeout(resolve, 0);
        });
      }
      // 挂起防护（真实时间门）：实现无超时时快速失败，不拖垮同文件后续用例
      await Promise.race([
        stopping,
        new Promise<never>((_, reject) => {
          realSetTimeout(() => reject(new Error('stop() 挂起：快照命令无响应且无超时')), 4_000);
        }),
      ]);
      const dropped = session.evidence().diagnostics().droppedEventByMethod;
      expect(dropped['Network.getCookies']).toBe(1);
      expect(dropped['storage-dump']).toBe(1);
      const storage = JSON.parse(
        (await session.workspace.readArtifact('raw/browser/storage.json')).toString('utf8'),
      );
      expect(storage.cookies).toEqual([]);
      expect(storage.localStorage).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('收尾保存 Frame Tree（规范 §8.4）：Page.getFrameTree 原样落盘', async () => {
    // 反例：spec §8.4 要求保存 Frame Tree，快照链路从不调用 Page.getFrameTree。
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-frame-tree',
      rootDir,
      safetyMarginBytes: 1,
      now: () => '2026-09-21T01:00:00.000Z',
    });
    const frameTree = {
      frame: { id: 'frame-root', url: 'https://bmc.test/console' },
      childFrames: [{ frame: { id: 'frame-1', url: 'https://bmc.test/kvm' } }],
    };
    const fake = createFakeCdp({ frameTree });
    await session.attachCdp(fake.cdp, { targetId: 'target-root' });
    await session.stop();

    const saved = JSON.parse(
      (await session.workspace.readArtifact('raw/browser/frame-tree.json')).toString('utf8'),
    );
    expect(saved).toMatchObject({
      schemaVersion: '2.0.0',
      targetId: 'target-root',
      capturedAt: '2026-09-21T01:00:00.000Z',
      frameTree,
    });
  });

  it('Frame Tree 获取失败显式记账，不阻断收尾', async () => {
    const rootDir = await newRootDir();
    const session = await startSession({
      jobId: 'job-frame-tree-failed',
      rootDir,
      safetyMarginBytes: 1,
    });
    const base = createFakeCdp();
    const forward = (command: string, params?: Record<string, unknown>, sessionId?: string) =>
      sessionId === undefined
        ? base.cdp.sendCommand(command, params)
        : base.cdp.sendCommand(command, params, sessionId);
    const cdp: CdpSession = {
      async attach() {},
      sendCommand: electronLikeSendCommand((command, params, sessionId) => {
        if (command === 'Page.getFrameTree') throw new Error('Page 域不可用');
        return forward(command, params, sessionId);
      }),
      on(event, listener) {
        base.cdp.on(event, listener);
      },
    };
    await session.attachCdp(cdp, { targetId: 'target-root' });
    await session.stop();

    expect(session.evidence().diagnostics().droppedEventByMethod['Page.getFrameTree']).toBe(1);
    // 后续快照步骤不受影响
    const storage = JSON.parse(
      (await session.workspace.readArtifact('raw/browser/storage.json')).toString('utf8'),
    );
    expect(storage.schemaVersion).toBe('2.0.0');
  });
});
