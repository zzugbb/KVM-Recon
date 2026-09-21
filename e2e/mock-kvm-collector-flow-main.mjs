/**
 * 阶段 2：真实浏览器 Mock KVM + 协议无关采集会话落盘对照。
 * 断言来自工作区文件与 Mock 服务端观察到的请求/帧，不经 0.2.x recorder。
 */

import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';

import { startCaptureSession } from './capture-session.mjs';
import { createMockKvmServer } from './mock-kvm-server.mjs';

const successMarker = 'mock kvm collector e2e passed';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function wrapDebugger(dbg) {
  return {
    attach(version) {
      return dbg.attach(version);
    },
    isAttached() {
      return dbg.isAttached();
    },
    sendCommand(command, params, sessionId) {
      if (arguments.length >= 3 && !(typeof sessionId === 'string' && sessionId)) {
        throw new Error('Empty session id is not allowed');
      }
      if (typeof sessionId === 'string' && sessionId) {
        return dbg.sendCommand(command, params, sessionId);
      }
      return dbg.sendCommand(command, params);
    },
    on(event, listener) {
      if (event === 'message') dbg.on('message', listener);
    },
  };
}

function jsonl(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function run() {
  const handle = await createMockKvmServer({ seed: 'mock-kvm-collector-e2e' });
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kvm-recon-collector-e2e-'));
  let win = null;
  let session = null;
  try {
    session = await startCaptureSession({
      jobId: 'job-collector-e2e',
      rootDir: workspaceRoot,
      targetUrl: handle.urls.loginPage,
      safetyMarginBytes: 1,
    });

    win = new BrowserWindow({
      width: 1024,
      height: 768,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;
    await wc.loadURL('about:blank');
    await session.attachCdp(wrapDebugger(wc.debugger), { targetId: 'target-root', windowId: String(wc.id) });

    const queryScript = (selector, expression) =>
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; ${expression} })()`;

    async function elementCenter(selector) {
      const rect = await wc.executeJavaScript(
        queryScript(
          selector,
          'const r = el.getBoundingClientRect(); return { x: Math.floor(r.x + r.width / 2), y: Math.floor(r.y + r.height / 2), w: r.width, h: r.height };',
        ),
      );
      if (!rect || !rect.w || !rect.h) {
        throw new Error(`元素不存在或不可点击：${selector}`);
      }
      return { x: rect.x, y: rect.y };
    }

    async function clickAt(selector) {
      const { x, y } = await elementCenter(selector);
      wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', clickCount: 0 });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }

    async function typeInto(selector, text) {
      const isTargetFocused = () =>
        wc.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && document.activeElement === el; })()`,
        );
      const typeOnce = async () => {
        wc.focus();
        await wc.executeJavaScript(queryScript(selector, 'el.focus();'));
        await waitFor(`输入框获得焦点：${selector}`, isTargetFocused, 5000);
        for (const char of text) {
          wc.sendInputEvent({ type: 'char', keyCode: char });
          await sleep(15);
        }
      };
      await clickAt(selector);
      await typeOnce();
      if ((await inputValue(selector)) !== text) {
        await wc.executeJavaScript(queryScript(selector, 'el.value = ""; el.focus();'));
        await typeOnce();
      }
      await waitFor(
        `键盘输入生效：${selector}`,
        async () => (await inputValue(selector)) === text,
        5000,
      );
    }

    async function inputValue(selector) {
      return wc.executeJavaScript(queryScript(selector, 'return el.value;'));
    }

    async function waitFor(label, condition, timeoutMs = 15000) {
      const startedAt = Date.now();
      for (;;) {
        const ok = await condition();
        if (ok) return;
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`等待超时：${label}`);
        }
        await sleep(100);
      }
    }

    await wc.loadURL(handle.urls.loginPage);
    const userField = '#login-form input:not([type=hidden]):not([type=password])';
    const passField = '#login-form input[type=password]';
    await typeInto(userField, 'operator');
    await typeInto(passField, 'operator-passphrase');
    await clickAt('#login-submit');
    await waitFor('登录成功后跳转控制台入口', async () =>
      wc.getURL().includes(handle.paths.consoleEntry),
    );
    await clickAt('#console-open');
    await waitFor('点击按钮后进入 Viewer 页', async () =>
      wc.getURL().includes(handle.paths.viewerPage),
    );
    await waitFor('Viewer 页创建 Worker', async () =>
      handle.capturedRequests().some(request => request.url.split('?')[0] === handle.paths.viewerWorker),
    );
    await waitFor(
      'Viewer 页建立 WebSocket 并收到初始下行帧',
      async () => handle.capturedFrames().filter(frame => frame.direction === 'down').length >= 3,
    );

    await session.stop();
    const dir = session.workspace.dir;
    const events = jsonl(await readFile(join(dir, 'raw/cdp/events.jsonl'), 'utf8'));
    const transactions = jsonl(await readFile(join(dir, 'raw/http/transactions.jsonl'), 'utf8'));

    const loginTx = transactions.find(
      row => row.method === 'POST' && String(row.url).includes(handle.paths.loginApi),
    );
    if (!loginTx?.requestBody?.path) {
      throw new Error('工作区缺少登录 POST 正文');
    }
    const loginBody = await readFile(join(dir, loginTx.requestBody.path), 'utf8');
    if (!loginBody.includes('operator')) {
      throw new Error('登录正文未保留用户名（可能被脱敏或截断）');
    }
    const serverLogin = handle.capturedRequests().find(request => request.url === handle.paths.loginApi);
    if (!serverLogin?.body) {
      throw new Error('Mock 服务端未记录登录请求');
    }

    const launchTx = transactions.find(row => String(row.url).includes(handle.paths.kvmLaunch));
    const csrfHeader = Object.entries(launchTx?.requestHeaders || {}).find(
      ([key]) => key.toLowerCase() === handle.csrfHeaderName.toLowerCase(),
    );
    if (!launchTx || !csrfHeader?.[1]) {
      throw new Error('工作区缺少带 CSRF 头的 KVM 启动请求');
    }

    if (!transactions.some(row => String(row.url).includes(handle.paths.viewerWorker))) {
      throw new Error('工作区缺少 Viewer Worker 脚本请求');
    }

    const wsDirs = (await readdir(join(dir, 'raw/websocket'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    if (wsDirs.length === 0) {
      throw new Error('工作区没有 WebSocket 通道目录');
    }
    const framesBin = await readFile(join(dir, 'raw/websocket', wsDirs[0], 'frames.bin'));
    const downFrames = handle.capturedFrames().filter(frame => frame.direction === 'down');
    for (const frame of downFrames.slice(0, 3)) {
      if (!framesBin.includes(Buffer.from(frame.payload))) {
        throw new Error('frames.bin 未包含 Mock 服务端下行帧 payload');
      }
    }
    if (!events.some(row => String(row.method).startsWith('Network.webSocket'))) {
      throw new Error('CDP journal 缺少 WebSocket 事件');
    }

    const cryptoRows = jsonl(await readFile(join(dir, 'raw/runtime/crypto.jsonl'), 'utf8'));
    const digestCall = cryptoRows.find(row => row.kind === 'digest' && String(row.algorithm).toUpperCase() === 'SHA-256');
    if (!digestCall?.inputRef?.path || !digestCall?.outputRef?.path) {
      throw new Error('工作区缺少 WebCrypto SHA-256 digest 调用（登录摘要链未捕获）');
    }
    const cryptoInput = await readFile(join(dir, digestCall.inputRef.path));
    const cryptoOutput = await readFile(join(dir, digestCall.outputRef.path));
    if (!cryptoInput.includes(Buffer.from('operator-passphrase:'))) {
      throw new Error('crypto 输入未保留登录口令材料（可能未挂钩或被脱敏）');
    }
    const expectedDigest = createHash('sha256').update(cryptoInput).digest();
    if (!cryptoOutput.equals(expectedDigest)) {
      throw new Error('crypto 输出与输入 SHA-256 不一致');
    }

    const storage = JSON.parse(await readFile(join(dir, 'raw/browser/storage.json'), 'utf8'));
    const csrfStored = storage?.sessionStorage?.[handle.csrfStorageKey];
    if (!csrfStored) {
      throw new Error(`sessionStorage 缺少 CSRF 键 ${handle.csrfStorageKey}`);
    }
    const viewerStored = storage?.sessionStorage?.[handle.viewerTokenStorageKey];
    if (!viewerStored) {
      throw new Error(`sessionStorage 缺少 viewerToken 键 ${handle.viewerTokenStorageKey}`);
    }

    const scriptIndex = JSON.parse(await readFile(join(dir, 'raw/scripts/index.json'), 'utf8'));
    const scripts = Array.isArray(scriptIndex?.scripts) ? scriptIndex.scripts : [];
    if (scripts.length === 0) {
      throw new Error('工作区 scripts/index.json 为空');
    }
    const workerPath = handle.paths.viewerWorker;
    const hasWorkerScript = scripts.some(
      row =>
        row.kind === 'worker' ||
        row.kind === 'shared-worker' ||
        String(row.url || '').includes(workerPath),
    );
    if (!hasWorkerScript) {
      const attached = events
        .filter(row => row.method === 'Target.attachedToTarget')
        .map(row => {
          const info = row.params?.targetInfo || {};
          return `${info.type || '?'}:${info.url || ''}`;
        });
      const commands = jsonl(await readFile(join(dir, 'raw/cdp/commands.jsonl'), 'utf8'));
      const debuggerCmds = commands
        .filter(row => String(row.method).startsWith('Debugger') || String(row.sessionId || '').length > 0 && String(row.method) === 'Runtime.enable')
        .map(row => `${row.method}@${row.sessionId || 'root'}${row.error ? `!${row.error}` : ''}`)
        .slice(0, 40)
        .join(', ');
      const scriptSummary = scripts.map(row => `${row.kind}:${row.url || ''}`).join(' | ');
      throw new Error(
        `工作区缺少 Viewer Worker 脚本源码（path=${workerPath}; attached=[${attached.join(', ')}]; debugger=[${debuggerCmds}]; scripts=${scriptSummary}）`,
      );
    }

    // —— 第 2 刀 / 第 3 刀新增工件的对照断言 ——

    const timeline = jsonl(await readFile(join(dir, 'raw/browser/timeline.jsonl'), 'utf8'));
    const navigations = timeline.filter(row => row.kind === 'navigation').map(row => String(row.url));
    if (!navigations.some(url => url.startsWith(handle.urls.loginPage))) {
      throw new Error('timeline 缺少登录页导航行');
    }
    if (!navigations.some(url => url.includes(handle.paths.viewerPage))) {
      throw new Error('timeline 缺少 Viewer 页导航行');
    }

    const actions = jsonl(await readFile(join(dir, 'raw/browser/actions.jsonl'), 'utf8'));
    const clickSummary = row => `${row.elementSummary || ''}`;
    if (!actions.some(row => row.kind === 'click' && clickSummary(row).includes('login-submit'))) {
      throw new Error('actions.jsonl 缺少登录按钮点击行（观察脚本未挂钩）');
    }
    if (!actions.some(row => row.kind === 'click' && clickSummary(row).includes('console-open'))) {
      throw new Error('actions.jsonl 缺少控制台按钮点击行');
    }
    for (const row of actions) {
      if (row.kind === 'form-submit' && String(row.elementSummary || '').includes('password')) {
        throw new Error('actions 元素摘要泄漏了密码输入内容');
      }
    }

    const domSnapshots = (await readdir(join(dir, 'raw/browser/dom-snapshots')))
      .filter(name => name.endsWith('.html'))
      .sort();
    if (domSnapshots.length === 0) {
      throw new Error('工作区缺少 DOM 快照');
    }
    const lastDom = await readFile(join(dir, 'raw/browser/dom-snapshots', domSnapshots[domSnapshots.length - 1]), 'utf8');
    if (!lastDom.includes('<')) {
      throw new Error('DOM 快照内容为空');
    }
    // 截图在隐藏窗口下可能失败（droppedEvent 记账）；存在则必须是合法 PNG
    const screenshotDir = join(dir, 'raw/browser/screenshots');
    for (const name of await readdir(screenshotDir).catch(() => [])) {
      const png = await readFile(join(screenshotDir, name));
      if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        throw new Error(`截图不是合法 PNG：${name}`);
      }
    }

    const targetsFile = JSON.parse(await readFile(join(dir, 'catalog/targets.json'), 'utf8'));
    const targetRows = Array.isArray(targetsFile?.targets) ? targetsFile.targets : [];
    if (!targetRows.some(row => row.type === 'page' && row.attached === true)) {
      throw new Error('catalog/targets.json 缺少已附加的根页面 target');
    }
    if (!targetRows.some(row => String(row.type || '').includes('worker'))) {
      throw new Error('catalog/targets.json 缺少 Viewer Worker target');
    }

    const channelsFile = JSON.parse(await readFile(join(dir, 'catalog/channels.json'), 'utf8'));
    const channelRows = Array.isArray(channelsFile?.channels) ? channelsFile.channels : [];
    const wsChannel = channelRows.find(row => row.kind === 'websocket');
    if (!wsChannel || !wsChannel.url || !wsChannel.payloadPath) {
      throw new Error('catalog/channels.json 缺少 WebSocket 通道行');
    }
    if (!wsChannel.frameCounts || !(wsChannel.frameCounts.down >= 3)) {
      throw new Error('channels 目录的 WebSocket 帧计数缺失或过小');
    }

    const har = JSON.parse(await readFile(join(dir, 'raw/http/session.har'), 'utf8'));
    if (har?.log?.version !== '1.2' || !Array.isArray(har?.log?.entries)) {
      throw new Error('session.har 不是合法 HAR 1.2');
    }
    const harLogin = har.log.entries.find(
      entry => String(entry.request?.url || '').includes(handle.paths.loginApi),
    );
    if (!harLogin || !String(harLogin.request?.postData?.text || '').includes('operator')) {
      throw new Error('session.har 缺少登录 POST 正文（互操作副本不完整）');
    }

    // E2E 未接 netlog 源：必须落「not-captured」兜底文件，而不是静默缺失
    const netlog = JSON.parse(await readFile(join(dir, 'raw/netlog/netlog.json'), 'utf8'));
    if (netlog?.schemaVersion !== '2.0.0' || netlog?.captureMode !== 'not-captured') {
      throw new Error('netlog.json 缺少 not-captured 兜底声明');
    }

    const summary = session.integrityEvidence('KVM_REACHED');
    if (summary.collectorReadyBeforeFirstNavigation !== true) {
      throw new Error('采集器未在首次导航前就绪');
    }

    console.log(successMarker);
    return 0;
  } catch (error) {
    console.error('[mock-kvm-collector-flow] 失败：', (error && error.message) || error);
    if (win) {
      console.error('[mock-kvm-collector-flow] 当前 URL：', win.webContents.getURL());
    }
    return 1;
  } finally {
    if (session) {
      await session.workspace.close().catch(() => {});
    }
    if (win) {
      win.destroy();
    }
    await handle.close().catch(() => {});
  }
}

process.on('unhandledRejection', error => {
  console.error('[mock-kvm-collector-flow] 未处理异常：', error);
  app.exit(1);
});

app.whenReady().then(
  async () => {
    const code = await run();
    app.exit(code);
  },
  error => {
    console.error('[mock-kvm-collector-flow] 启动失败：', error);
    app.exit(1);
  },
);
