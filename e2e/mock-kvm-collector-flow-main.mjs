/**
 * 阶段 2：真实浏览器 Mock KVM + 协议无关采集会话落盘对照。
 * 断言来自工作区文件与 Mock 服务端观察到的请求/帧，不经 0.2.x recorder。
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';

import { startCaptureSession } from './capture-session.mjs';
import { createMockKvmServer } from './mock-kvm-server.mjs';
import { createElectronNetlogSource } from './electron-netlog-source.mjs';
import { exportJobWorkspaceZip } from './export-job-zip.mjs';
import {
  createViewerAutoStopWatchdog,
  VIEWER_POLL_INTERVAL_MS,
  VIEWER_STABLE_WINDOW_MS,
} from './viewer-autostop-watchdog.mjs';
import { detectViewerActivity } from './viewer-activity.mjs';

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
      // environment() 要求 mainEnvironment（进程级环境事实）在场；导出断言用
      mainEnvironment: {
        chromium: process.versions.chrome ?? '',
        electron: process.versions.electron ?? '',
        os: `${platform()} ${release()}`,
      },
      // 与生产链路同源的真实 NetLog（include-sensitive）：导出门禁要求
      // 包内有 HTTP 事务时 netlog journal 非空
      netlog: createElectronNetlogSource(),
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

    // 阶段 3 第 3 刀：真实看门狗驱动会话级自动收尾（§7.4：只 stop，不导出）
    const autoStopState = { stopped: false };
    const watchdog = createViewerAutoStopWatchdog({
      getFacts: () => session.workflowFacts(),
      now: () => Date.now(),
      recordDiagnostic: (kind, detail) => {
        console.log(`[mock-kvm-collector-flow] viewer-watchdog ${kind}: ${detail}`);
      },
      autoStop: async () => {
        autoStopState.stopped = true;
        await session.stop();
      },
    });
    watchdog.start();

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
    // 双向通道事实：页面的 worker 回声链会发出上行帧（服务端观察到的 up），
    // 派生 KVM_REACHED 需要 WS 双向帧观察
    await waitFor(
      'Viewer 页经 worker 回声发出上行帧',
      async () => handle.capturedFrames().filter(frame => frame.direction === 'up').length >= 1,
    );

    // 阶段 3 第 3 刀：Viewer 活动信号（§7.3）必须从会话事实识别出来。
    // 服务端先看到上行帧、会话通道事实稍后落齐，按会话事实等待（不按服务端观察）
    let signals = [];
    await waitFor('Viewer 活动信号识别（点击 → 导航/popup → WS 双向帧）', async () => {
      signals = detectViewerActivity(session.workflowFacts());
      return signals.length > 0;
    });
    if (signals[0].channelKind !== 'websocket') {
      throw new Error(`Viewer 活动信号通道异常：${JSON.stringify(signals[0])}`);
    }

    // 稳定窗口静默通过 → 看门狗自动收尾（fingerprint 稳定后 15s + 轮询粒度）
    await waitFor(
      'Viewer 稳定窗口静默通过，看门狗自动收尾',
      () => autoStopState.stopped,
      VIEWER_STABLE_WINDOW_MS + VIEWER_POLL_INTERVAL_MS * 4 + 5_000,
    );
    watchdog.stop();

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

    // NetLog 与生产链路同源（include-sensitive）：非空事件流是导出门禁
    // 的前提（包内有 HTTP 事务时 not-captured 兜底会被 RAW_JOURNAL_EMPTY 拒绝）
    const netlog = JSON.parse(await readFile(join(dir, 'raw/netlog/netlog.json'), 'utf8'));
    if (netlog?.captureMode !== 'include-sensitive') {
      throw new Error(`netlog.json captureMode 异常：${netlog?.captureMode ?? '(缺失)'}`);
    }

    // 阶段 3：workflowStatus 必须由引擎从观察事实派生出 KVM_REACHED
    // （点击 → 主框架导航 → WS 双向帧 + Set-Cookie cookie 传播），不得手工指定
    const summary = session.integrityEvidence();
    if (summary.workflowStatus !== 'KVM_REACHED') {
      const facts = session.workflowFacts();
      console.error('[mock-kvm-collector-flow] 派生诊断：', JSON.stringify({
        workflowStatus: summary.workflowStatus,
        actions: facts.actions.map(a => [a.id, a.kind, a.occurredAt, a.elementSummary]),
        navigations: facts.navigations,
        channels: facts.channels.map(c => [c.id, c.kind, c.createdAt, c.frameCounts]),
        setCookieTx: facts.transactions
          .filter(t => t.method.toUpperCase() === 'POST' && JSON.stringify(t.responseHeaders).toLowerCase().includes('set-cookie'))
          .map(t => [t.id, t.startedAt, t.status, t.responseHeaders['set-cookie'] ?? t.responseHeaders['Set-Cookie']]),
        cookieReplay: facts.transactions.filter(t => Object.keys(t.requestHeaders).some(k => k.toLowerCase() === 'cookie')).map(t => [t.id, t.startedAt, t.requestHeaders.cookie ?? t.requestHeaders.Cookie]),
      }));
      throw new Error(`workflowStatus 派生异常：${summary.workflowStatus}（期望 KVM_REACHED）`);
    }
    if (summary.collectorReadyBeforeFirstNavigation !== true) {
      throw new Error('采集器未在首次导航前就绪');
    }

    // 阶段 3 第 2 刀：证据图必须从真实观察派生——value-flow 节点/边
    // （Set-Cookie → storage cookie → 后续 Cookie 头；摘要输出 ⊆ 登录正文；
    // viewerToken 响应 → WS 握手查询参数）与 relations 结构关系行（initiated /
    // created / opened / value-flow），空图即为派生失败
    const valueFlow = JSON.parse(await readFile(join(dir, 'ai/value-flow.json'), 'utf8'));
    const flowNodes = Array.isArray(valueFlow?.nodes) ? valueFlow.nodes : [];
    const flowEdges = Array.isArray(valueFlow?.edges) ? valueFlow.edges : [];
    const dumpValueFlowDiagnostics = () => {
      const storageDiag = JSON.parse(readFileSync(join(dir, 'raw/browser/storage.json'), 'utf8'));
      const txRows = jsonl(readFileSync(join(dir, 'raw/http/transactions.jsonl'), 'utf8'));
      console.error('[mock-kvm-collector-flow] value-flow 诊断：', JSON.stringify({
        nodes: flowNodes,
        edges: flowEdges,
        storageCookies: (storageDiag?.cookies || []).map(c => [c.name, c.value]),
        setCookieTx: txRows
          .filter(t => Object.keys(t.responseHeaders || {}).some(k => k.toLowerCase() === 'set-cookie'))
          .map(t => [t.id, t.responseHeaders['set-cookie'] ?? t.responseHeaders['Set-Cookie']]),
        cookieHeaderTx: txRows
          .filter(t => Object.keys(t.requestHeaders || {}).some(k => k.toLowerCase() === 'cookie'))
          .map(t => [t.id, t.requestHeaders.cookie ?? t.requestHeaders.Cookie]),
        factsSetCookieTx: session.workflowFacts().transactions
          .filter(t => Object.keys(t.responseHeaders || {}).some(k => k.toLowerCase() === 'set-cookie'))
          .map(t => [t.id, t.responseHeaders['set-cookie'] ?? t.responseHeaders['Set-Cookie']]),
        dropped: session.evidence().diagnostics().droppedEventByMethod,
      }));
    };
    if (flowNodes.length === 0 || flowEdges.length === 0) {
      dumpValueFlowDiagnostics();
      throw new Error('ai/value-flow.json 缺少派生的值传播节点/边（空图 = 派生失败）');
    }
    const nodeById = new Map(flowNodes.map(node => [node.id, node]));
    if (!flowNodes.some(node => node.kind === 'cookie')) {
      dumpValueFlowDiagnostics();
      throw new Error('value-flow 缺少 storage cookie 节点（Set-Cookie → storage 传播未成边）');
    }
    const cookieEdges = flowEdges.filter(
      edge => nodeById.get(edge.to)?.kind === 'header' && nodeById.get(edge.from)?.kind === 'cookie',
    );
    if (cookieEdges.length === 0) {
      dumpValueFlowDiagnostics();
      throw new Error('value-flow 缺少 cookie → 请求/WS 握手 Cookie 头的传播边');
    }
    if (!flowEdges.some(edge => edge.relation === 'used-in' && nodeById.get(edge.from)?.kind === 'crypto-output')) {
      dumpValueFlowDiagnostics();
      throw new Error('value-flow 缺少摘要输出 used-in 登录正文的边');
    }
    const urlParamEdge = flowEdges.find(
      edge => nodeById.get(edge.to)?.kind === 'url-param' && nodeById.get(edge.from)?.kind === 'http-response',
    );
    if (!urlParamEdge) {
      dumpValueFlowDiagnostics();
      throw new Error('value-flow 缺少 viewerToken 响应 → WS 握手查询参数的传播边');
    }
    for (const edge of flowEdges) {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) {
        throw new Error(`value-flow 边引用未知节点：${edge.from} → ${edge.to}`);
      }
    }

    const relations = jsonl(await readFile(join(dir, 'catalog/relations.jsonl'), 'utf8'));
    if (!relations.some(row => row.relation === 'initiated')) {
      throw new Error('relations.jsonl 缺少 target → 事务 initiated 行');
    }
    if (!relations.some(row => row.relation === 'opened')) {
      throw new Error('relations.jsonl 缺少 target → 通道 opened 行');
    }
    const relationValueFlowRows = relations.filter(row => row.relation === 'value-flow');
    if (relationValueFlowRows.length !== flowEdges.length) {
      throw new Error(
        `relations.jsonl 的 value-flow 行数 ${relationValueFlowRows.length} != value-flow 边数 ${flowEdges.length}`,
      );
    }

    // 第 11 轮审核测试缺口：§20 验收场景 1 端到端闭环——完整会话经
    // exportJobWorkspaceZip（含包一致性门禁与流式校验）导出后，
    // 必须得到 COMPLETE + KVM_REACHED（样例包的 COMPLETE 是手工装配，
    // 不构成该场景的证据）
    const environment = session.environment();
    if (!environment) {
      throw new Error('页面环境缺失（无根窗口挂载），拒绝装配导出');
    }
    const loginUrl = new URL(handle.urls.loginPage);
    const zipDir = await mkdtemp(join(tmpdir(), 'kvm-recon-collector-e2e-zip-'));
    const exportResult = await exportJobWorkspaceZip({
      workspace: session.workspace,
      zipDir,
      assembly: {
        tool: { version: '0.0.0-e2e', buildId: 'mock-collector-e2e' },
        environment,
        evidenceSummary: session.integrityEvidence(),
        target: {
          host: loginUrl.hostname,
          port: loginUrl.port
            ? Number(loginUrl.port)
            : loginUrl.protocol === 'https:'
              ? 443
              : 80,
          scheme: loginUrl.protocol === 'https:' ? 'https' : 'http',
          originalInput: loginUrl.host,
        },
        job: { endedAt: new Date().toISOString(), deviceLabel: session.workspace.deviceLabel },
      },
    });
    if (exportResult.status.captureIntegrity !== 'COMPLETE') {
      console.error('[mock-kvm-collector-flow] 完整度诊断：', JSON.stringify({
        reasons: exportResult.derived.reasons,
        gates: (exportResult.derived.gates || []).map(gate => `${gate.id}:${gate.passed ? 'pass' : 'FAIL'}`),
        workflowStatus: exportResult.status.workflowStatus,
      }));
      throw new Error(
        `导出包完整度 ${exportResult.status.captureIntegrity}（期望 COMPLETE）：${(exportResult.derived.reasons || []).join(', ')}`,
      );
    }
    if (exportResult.status.workflowStatus !== 'KVM_REACHED') {
      throw new Error(`导出包 workflowStatus ${exportResult.status.workflowStatus}（期望 KVM_REACHED）`);
    }
    if (!existsSync(exportResult.export.zipPath)) {
      throw new Error('导出 ZIP 未落盘：' + exportResult.export.zipPath);
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
