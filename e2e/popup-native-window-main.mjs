import { app, BrowserWindow, session, webContents } from 'electron';
import { createServer } from 'node:http';

function nativePopupWindowOpenHandler(partition) {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 1280,
      height: 860,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: false,
      },
    },
  };
}

const server = createServer((req, res) => {
  const url = String(req.url || '/');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.startsWith('/viewer-app.js')) {
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.end('window.__viewerAppLoaded = true;');
    return;
  }
  if (url.startsWith('/popup')) {
    res.end(`<!doctype html><html><body>
      <script src="/viewer-app.js"></script>
      <script>
        window.__hasOpener = Boolean(window.opener);
        window.__name = window.name;
      </script>
      popup
    </body></html>`);
    return;
  }
  if (url.startsWith('/form-target')) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('POST required');
      return;
    }
    res.end(`<!doctype html><html><body>
      <script>
        window.__hasOpener = Boolean(window.opener);
        window.__posted = true;
      </script>
      posted
    </body></html>`);
    return;
  }
  if (url.startsWith('/form')) {
    res.end(`<!doctype html><html><body>
      <form id="kvm" method="post" action="/form-target" target="_blank">
        <input type="hidden" name="token" value="once">
      </form>
    </body></html>`);
    return;
  }
  res.end(`<!doctype html><html><body>
    <script>
      window.__opened = window.open('/popup.html', 'kvmViewer', 'width=640,height=480');
    </script>
    opener
  </body></html>`);
});

function fail(message) {
  console.error(message);
  app.exit(1);
}

app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  const partition = 'kvm-recon-popup-e2e';
  const captureSession = session.fromPartition(partition);
  const capturedByWindow = new Map();
  const cdpStarted = new Set();

  function ensureCdp(contents) {
    if (cdpStarted.has(contents.id)) return;
    cdpStarted.add(contents.id);
    const captured = [];
    capturedByWindow.set(contents.id, captured);
    const dbg = contents.debugger;
    dbg.on('message', (_event, method, params) => {
      if (method === 'Network.requestWillBeSent' && params?.request?.url) {
        captured.push(String(params.request.url));
      }
    });
    if (!dbg.isAttached()) dbg.attach('1.3');
    void dbg.sendCommand('Network.enable');
  }

  captureSession.webRequest.onBeforeRequest((details, callback) => {
    const contents =
      typeof details.webContentsId === 'number' ? webContents.fromId(details.webContentsId) : null;
    if (contents && contents.session === captureSession && contents.getType() === 'window') {
      ensureCdp(contents);
    }
    callback({});
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  ensureCdp(win.webContents);

  let created = null;
  win.webContents.setWindowOpenHandler(() => nativePopupWindowOpenHandler(partition));
  win.webContents.on('did-create-window', (child, details) => {
    created = { child, details };
    ensureCdp(child.webContents);
  });

  await win.loadURL(`${origin}/`);
  for (let i = 0; i < 40 && !created?.child; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!created?.child) {
    fail('did-create-window 未触发，window.open 可能被 deny');
    return;
  }
  const popupCaptured = capturedByWindow.get(created.child.webContents.id) || [];
  for (let i = 0; i < 40 && popupCaptured.length < 2; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const openerResult = await win.webContents.executeJavaScript(
    `({ hasHandle: Boolean(window.__opened), name: window.__opened && window.__opened.name })`,
  );
  const popupResult = await created.child.webContents.executeJavaScript(
    `({ hasOpener: window.__hasOpener === true, name: window.__name, app: window.__viewerAppLoaded === true })`,
  );
  if (!openerResult.hasHandle) {
    fail('window.open 没有返回 Window 句柄');
    return;
  }
  if (openerResult.name !== 'kvmViewer' || popupResult.name !== 'kvmViewer') {
    fail(`frameName 丢失: opener=${openerResult.name} popup=${popupResult.name}`);
    return;
  }
  if (!popupResult.hasOpener) {
    fail('弹窗缺少 window.opener');
    return;
  }
  if (!popupCaptured.some(url => url.includes('/popup.html'))) {
    fail(`CDP 未捕获弹窗首个 Document: ${popupCaptured.join(', ') || '(empty)'}`);
    return;
  }
  if (!popupCaptured.some(url => url.includes('/viewer-app.js'))) {
    fail(`CDP 未捕获弹窗首个脚本: ${popupCaptured.join(', ') || '(empty)'}`);
    return;
  }

  const formWin = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  ensureCdp(formWin.webContents);
  let formCreated = null;
  let formHandlerDetails = null;
  formWin.webContents.setWindowOpenHandler(details => {
    formHandlerDetails = details;
    formCreated = { details };
    return nativePopupWindowOpenHandler(partition);
  });
  formWin.webContents.on('did-create-window', (child, details) => {
    formCreated = {
      child,
      details: { ...formHandlerDetails, ...details },
    };
    ensureCdp(child.webContents);
  });
  await formWin.loadURL(`${origin}/form`);
  await formWin.webContents.executeJavaScript(`document.getElementById('kvm').submit(); true`);
  for (let i = 0; i < 20 && !formCreated?.child; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!formCreated?.child) {
    fail('target=_blank 表单没有打开原生弹窗');
    return;
  }
  const postBody = formCreated.details?.postBody || formHandlerDetails?.postBody;
  let posted = false;
  for (let i = 0; i < 20; i += 1) {
    try {
      posted = await formCreated.child.webContents.executeJavaScript('window.__posted === true');
    } catch (_error) {
      posted = false;
    }
    if (posted) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!posted) {
    fail('target=_blank POST 未到达服务端');
    return;
  }
  if (!postBody) {
    fail('target=_blank POST 的 postBody 丢失');
    return;
  }

  server.close();
  app.exit(0);
}).catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});
