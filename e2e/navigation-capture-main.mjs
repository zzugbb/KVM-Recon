import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { startCaptureSession } from './capture-session.mjs';
import { createElectronRequestObserver } from './request-observer.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonl = buffer => buffer.toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
const cancelMode = process.argv.includes('--cancel-on-navigation');
const xhrMode = process.argv.includes('--xhr');
const popupMode = process.argv.includes('--popup');
const lateDurableMode = process.argv.includes('--late-durable');
const navigateAfterResponse = (path, next) => xhrMode
  ? `const xhr = new XMLHttpRequest(); xhr.open('GET', '${path}'); xhr.onload = () => { location.href = '${next}'; }; xhr.send();`
  : `fetch('${path}').then(r=>r.text()).then(()=>location.replace('${next}'));`;
const content = {
  '/': '<html><body>initial-document<script src="/index.js"></script></body></html>',
  '/index.js': navigateAfterResponse('/summary', '/login'),
  '/summary': '{"initialResponse":true}',
  '/login': '<html><body>login-document<script src="/login.js"></script></body></html>',
  '/login.js': `setTimeout(() => { ${navigateAfterResponse('/privileges', '/dashboard')} },150);`,
  '/privileges': '{"loginResponse":true}',
  '/dashboard': '<html><body>final-document</body></html>',
};
if (cancelMode) content['/login.js'] = `const orphan = new XMLHttpRequest(); orphan.open('GET', '/cancelled'); orphan.send(); setTimeout(() => { ${navigateAfterResponse('/privileges', '/dashboard')} }, 25);`;
if (popupMode) content['/popup'] = '<html><body>native-popup-document' + 'x'.repeat(10000) + '</body></html>';

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'kvm-navigation-workspace-'));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/cancelled') { await delay(1500); res.end('too late'); return; }
    if (path === '/popup') await delay(60);
    res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' :
      ['/summary','/privileges'].includes(path) ? 'application/json' : 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/popup' && lateDurableMode) {
      res.setHeader('Content-Length', Buffer.byteLength(content[path]));
      res.flushHeaders();
      await delay(300);
    }
    res.end(content[path] ?? '');
  });
  let win;
  let session;
  let observer;
  const children = [];
  let popupAttached;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    session = await startCaptureSession({ jobId: 'navigation-e2e', rootDir: root, targetUrl: origin, safetyMarginBytes: 1 });
    win = new BrowserWindow({ width: 800, height: 600, show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const wc = win.webContents;
    observer = createElectronRequestObserver(wc.session, session, id =>
      id === wc.id ? 'target-root' : children.some(child => child.webContents.id === id) ? 'target-popup' : undefined);
    wc.session.webRequest.onBeforeRequest((details, callback) => { observer.beforeRequest(details); callback({}); });
    wc.setWindowOpenHandler(() => ({ action: 'allow' }));
    wc.on('did-create-window', child => {
      children.push(child);
      const dbg = child.webContents.debugger;
      let received;
      const responseReceived = new Promise(resolve => { received = resolve; });
      dbg.on('message', (_event, method) => { if (method === 'Network.responseReceived') received(); });
      popupAttached = session.attachCdp({
        attach: version => dbg.attach(version), isAttached: () => dbg.isAttached(),
        on: (event, fn) => dbg.on(event, fn), off: (event, fn) => dbg.off(event, fn),
        sendCommand: async (method, params, sessionId) => {
          if (lateDurableMode && method === 'Network.configureDurableMessages') await responseReceived;
          return sessionId ? dbg.sendCommand(method, params, sessionId) : dbg.sendCommand(method, params);
        },
      }, {
        targetId: 'target-popup', windowRole: 'popup', openerTargetId: 'target-root',
      });
    });
    await wc.loadURL('about:blank');
    const dbg = wc.debugger;
    await session.attachCdp({
      attach: version => dbg.attach(version), isAttached: () => dbg.isAttached(),
      on: (event, fn) => dbg.on(event, fn), off: (event, fn) => dbg.off(event, fn),
      sendCommand: async (method, params, sessionId) => {
        const result = await (sessionId ? dbg.sendCommand(method, params, sessionId) : dbg.sendCommand(method, params));
        // 可重复模拟现场慢截图：浏览器导航继续发生，采集器不能等待截图后才读正文。
        if (method === 'Page.captureScreenshot') await delay(750);
        return result;
      },
    }, { targetId: 'target-root' });
    await wc.loadURL(origin).catch(error => { if (error.code !== 'ERR_ABORTED') throw error; });
    const deadline = Date.now() + 15000;
    while (!wc.getURL().endsWith('/dashboard') || wc.isLoading()) {
      if (Date.now() > deadline) throw new Error('fixture did not reach dashboard');
      await delay(25);
    }
    if (popupMode) {
      await wc.executeJavaScript("void window.open('/popup', 'viewer', 'width=640,height=480')");
      while (!popupAttached) await delay(10);
      await popupAttached;
      while (children[0].webContents.isLoading()) await delay(10);
    }
    await delay(100);
    if (cancelMode) {
      const deadline = Date.now() + 5000;
      while (session.pendingNonStreamingRequests().some(r => r.url.endsWith('/cancelled'))) {
        assert(Date.now() < deadline, 'cancelled request still blocks automatic stop');
        await delay(25);
      }
    }
    await session.stop();
    const transactions = jsonl(await session.workspace.readArtifact('raw/http/transactions.jsonl'));
    const scripts = JSON.parse((await session.workspace.readArtifact('raw/scripts/index.json')).toString()).scripts;
    for (const [path, expected] of Object.entries(content)) {
      const tx = transactions.find(tx => tx.url === origin + path && tx.status === 200);
      assert(tx?.responseBody, `missing response: ${path}`);
      assert.equal((await session.workspace.readArtifact(tx.responseBody.path)).toString(), expected, path);
      if (path.endsWith('.js')) {
        const script = scripts.find(script => script.url === origin + path);
        assert(script?.bodyRef, `missing parsed source: ${path}`);
        assert.equal((await session.workspace.readArtifact(script.bodyRef.path)).toString(), expected, path);
      }
    }
    if (cancelMode) {
      const tx = transactions.find(tx => tx.url === origin + '/cancelled');
      assert(tx, 'cancelled request must remain in the capture');
      assert.equal(tx.status, null);
      assert.equal(tx.responseBody, undefined);
      const events = jsonl(await session.workspace.readArtifact('raw/browser/network-events.jsonl'));
      assert(events.some(e => e.targetId === 'target-root' && e.observation.kind === 'navigation-cancellation' &&
        e.observation.httpId === tx.id && e.observation.error === 'net::ERR_ABORTED'), 'missing native cancellation evidence');
    }
    assert.deepEqual(session.integrityEvidence().missingBodies, []);
    assert.deepEqual(session.integrityEvidence().missingWorkerSources, []);
    console.log(`navigation capture e2e passed (${xhrMode ? 'XHR' : 'fetch'}${popupMode ? ', native popup' : ''}): all HTTP bodies and both navigation scripts preserved`);
  } finally {
    observer?.dispose();
    win?.webContents.session.webRequest.onBeforeRequest(null);
    if (session) { await session.stop(); await session.workspace.close(); }
    win?.destroy();
    for (const child of children) if (!child.isDestroyed()) child.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
