import { app } from 'electron';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCaptureBrowserController } from './createCaptureBrowserController';
import { createElectronCaptureBrowserAdapter } from './createElectronCaptureBrowserAdapter';

export function isE2eCaptureControllerLaunch() {
  return process.argv.includes('--e2e-capture-controller') || process.env.KVM_RECON_E2E_CAPTURE === '1';
}

function headerValue(headers: Record<string, string> | undefined, name: string) {
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? String(found[1] || '') : '';
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fail(message: string): never {
  console.error(message);
  app.exit(1);
  throw new Error(message);
}

export async function runProductionCaptureE2e() {
  const screenshotDir = await mkdtemp(join(tmpdir(), 'kvm-recon-e2e-capture-'));
  const posted = { received: false, referer: '' };
  const popupGets = { received: false, referer: '' };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = String(req.url || '/');
    const referer = String(req.headers.referer || req.headers.referrer || '');
    if (url.startsWith('/viewer-app.js')) {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.end('window.__viewerAppLoaded = true;');
      return;
    }
    if (url.startsWith('/popup')) {
      popupGets.received = true;
      popupGets.referer = referer;
      res.setHeader('content-type', 'text/html; charset=utf-8');
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
      posted.received = true;
      posted.referer = referer;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body>
        <script>window.__posted = true;</script>
        posted
      </body></html>`);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body>
      <script>
        window.__opened = window.open('/popup.html', 'kvmViewer', 'width=640,height=480');
        setTimeout(() => {
          document.getElementById('kvm').submit();
        }, 400);
      </script>
      <form id="kvm" method="post" action="/form-target" target="_blank">
        <input type="hidden" name="token" value="once">
      </form>
      opener
    </body></html>`);
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  const controller = createCaptureBrowserController({
    jobId: 'e2e-capture-controller',
    target: { host: '127.0.0.1', port, scheme: 'http' },
    adapter: createElectronCaptureBrowserAdapter({ screenshotDir }),
  });

  const startedAt = Date.now();
  const startTimeoutMs = 8000;
  try {
    await Promise.race([
      controller.start(),
      sleep(startTimeoutMs).then(() => {
        throw new Error(`controller.start() ${startTimeoutMs}ms 未返回`);
      }),
    ]);
  } catch (error) {
    // 捕获生产采集 Controller 启动失败：空窗口 Network.enable 卡死或页面加载拒绝
    // 策略：以非零退出让 E2E 失败，避免烟测通过却无法开始采集
    console.error(error instanceof Error ? error.message : String(error));
    server.close();
    await rm(screenshotDir, { recursive: true, force: true }).catch(() => undefined);
    app.exit(1);
    return;
  }
  const startElapsedMs = Date.now() - startedAt;
  if (startElapsedMs >= startTimeoutMs) {
    fail(`controller.start() 耗时 ${startElapsedMs}ms`);
  }

  let lastDump = '';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const network = controller.network();
    const timeline = controller.timeline();
    const urls = network.httpRequests.map(item => `${item.method} ${item.url} role=${item.windowRole || ''}`);
    lastDump = urls.join('\n');
    const mainDocument = network.httpRequests.find(
      item =>
        item.windowRole === 'main' &&
        /document/i.test(item.resourceType || '') &&
        item.url.startsWith(origin) &&
        !item.url.includes('/popup') &&
        !item.url.includes('/form') &&
        !item.url.includes('/viewer-app.js'),
    );
    const popupDocument = network.httpRequests.find(item => item.url.includes('/popup.html'));
    const popupScript = network.httpRequests.find(item => item.url.includes('/viewer-app.js'));
    const popupEvent = timeline.events.find(event => event.type === 'popup');
    const popupLineage =
      Boolean(popupEvent?.openerCaptureWindowId) &&
      Array.isArray(popupEvent?.ancestorCaptureWindowIds) &&
      (popupEvent?.ancestorCaptureWindowIds as unknown[]).length > 0;
    const postRequest = network.httpRequests.find(
      item => item.method.toUpperCase() === 'POST' && item.url.includes('/form-target'),
    );
    const popupReferer = headerValue(popupDocument?.requestHeaders, 'referer');
    const postReferer = headerValue(postRequest?.requestHeaders, 'referer') || posted.referer;
    if (
      mainDocument &&
      popupDocument &&
      popupScript &&
      popupLineage &&
      posted.received &&
      postRequest &&
      (popupReferer.includes(origin) || popupGets.referer.includes(origin)) &&
      postReferer.includes(origin)
    ) {
      try {
        await controller.stop();
      } catch (error) {
        // 捕获 E2E 关窗失败：断言已通过
        // 策略：仍退出 0，避免清理失败掩盖生产链路已通过
        void error;
      }
      server.close();
      await rm(screenshotDir, { recursive: true, force: true }).catch(() => undefined);
      console.log(`production capture controller e2e passed in ${startElapsedMs}ms`);
      app.exit(0);
      return;
    }
    await sleep(100);
  }

  fail(
    [
      '生产采集链路 E2E 未在时限内采到全部证据',
      `server POST=${posted.received} popupGET=${popupGets.received} popupReferer=${popupGets.referer} postReferer=${posted.referer}`,
      lastDump || '(no http requests)',
    ].join('\n'),
  );
}
