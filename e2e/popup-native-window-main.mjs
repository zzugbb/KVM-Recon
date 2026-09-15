import { app, BrowserWindow } from 'electron';
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
  if (url.startsWith('/popup')) {
    res.end(`<!doctype html><html><body>
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

  let created = null;
  win.webContents.setWindowOpenHandler(() => nativePopupWindowOpenHandler(partition));
  win.webContents.on('did-create-window', (child, details) => {
    created = { child, details };
  });

  await win.loadURL(`${origin}/`);
  await new Promise(resolve => setTimeout(resolve, 800));
  if (!created) {
    fail('did-create-window 未触发，window.open 可能被 deny');
    return;
  }
  const openerResult = await win.webContents.executeJavaScript(
    `({ hasHandle: Boolean(window.__opened), name: window.__opened && window.__opened.name })`,
  );
  const popupResult = await created.child.webContents.executeJavaScript(
    `({ hasOpener: window.__hasOpener === true, name: window.__name })`,
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
  let formCreated = null;
  formWin.webContents.setWindowOpenHandler(details => {
    formCreated = { details };
    return nativePopupWindowOpenHandler(partition);
  });
  formWin.webContents.on('did-create-window', (child, details) => {
    formCreated = { child, details: details || formCreated?.details };
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
  const postBody = formCreated.details?.postBody;
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
  if (!postBody && !posted) {
    fail('target=_blank POST 丢失：既没有 postBody，服务端也未收到表单正文');
    return;
  }

  server.close();
  app.exit(0);
}).catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});
