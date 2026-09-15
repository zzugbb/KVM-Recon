import { app, BrowserWindow } from 'electron';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCapturePackZip } from '../../core/capture-pack/buildCapturePackZip';
import { summarizeCapturePackZip } from '../../core/capture-pack/summarizeCapturePack';
import { assembleCapturePackForExport } from '../../core/delivery/assembleCapturePackForExport';
import { createCaptureBrowserController } from './createCaptureBrowserController';
import { createElectronCaptureBrowserAdapter } from './createElectronCaptureBrowserAdapter';
import { PRODUCTION_CAPTURE_E2E_PASSED } from './evaluateProductionCaptureE2eExit';

const VIEWER_JS_MARKER = 'kvm-recon-e2e-viewer-js';
const POPUP_HTML_MARKER = 'kvm-recon-e2e-popup-html';
const POST_TOKEN = 'e2e-secret-token';

export function isE2eCaptureControllerLaunch() {
  return process.argv.includes('--e2e-capture-controller') || process.env.KVM_RECON_E2E_CAPTURE === '1';
}

export function isE2eCaptureCloseBeforeAssert() {
  return (
    process.argv.includes('--e2e-capture-close-before-assert') ||
    process.env.KVM_RECON_E2E_CLOSE_BEFORE_ASSERT === '1'
  );
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
  process.exit(1);
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
      res.end(`window.__viewerAppLoaded = true; // ${VIEWER_JS_MARKER}`);
      return;
    }
    if (url.startsWith('/popup')) {
      popupGets.received = true;
      popupGets.referer = referer;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body>
        <!-- ${POPUP_HTML_MARKER} -->
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
        <input type="hidden" name="viewer" value="html5">
        <input type="hidden" name="token" value="${POST_TOKEN}">
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
  const startedAt = new Date().toISOString();
  const controller = createCaptureBrowserController({
    jobId: 'e2e-capture-controller',
    target: { host: '127.0.0.1', port, scheme: 'http' },
    adapter: createElectronCaptureBrowserAdapter({ screenshotDir }),
  });

  const startClock = Date.now();
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
  const startElapsedMs = Date.now() - startClock;
  if (startElapsedMs >= startTimeoutMs) {
    fail(`controller.start() 耗时 ${startElapsedMs}ms`);
  }

  if (isE2eCaptureCloseBeforeAssert()) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
    await sleep(300);
    fail('断言前采集窗口已关闭');
  }

  let lastDump = '';
  let popupDocument;
  let popupScript;
  let postRequest;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const network = controller.network();
    lastDump = network.httpRequests
      .map(
        item =>
          `${item.method} ${item.url} captured=${item.responseBodyCaptured} skip=${item.responseBodySkippedReason || ''} opener=${item.openerCaptureWindowId || ''}`,
      )
      .join('\n');
    popupDocument = network.httpRequests.find(item => item.url.includes('/popup.html'));
    popupScript = network.httpRequests.find(item => item.url.includes('/viewer-app.js'));
    postRequest = network.httpRequests.find(
      item => item.method.toUpperCase() === 'POST' && item.url.includes('/form-target'),
    );
    if (popupDocument && popupScript && posted.received && postRequest) {
      break;
    }
    await sleep(100);
  }

  try {
    await controller.waitForNetworkIdle();
    await controller.ingestLiveEvents();
  } catch (error) {
    // 捕获等待网络静默失败：E2E 仍用当前快照断言，避免 idle 超时掩盖正文问题
    void error;
  }

  const network = controller.network();
  const timeline = controller.timeline();
  const sourceFiles = controller.sourceFiles();
  popupDocument = network.httpRequests.find(item => item.url.includes('/popup.html'));
  popupScript = network.httpRequests.find(item => item.url.includes('/viewer-app.js'));
  postRequest = network.httpRequests.find(
    item => item.method.toUpperCase() === 'POST' && item.url.includes('/form-target'),
  );
  const mainDocument = network.httpRequests.find(
    item =>
      item.windowRole === 'main' &&
      /document/i.test(item.resourceType || '') &&
      item.url.startsWith(origin) &&
      !item.url.includes('/popup') &&
      !item.url.includes('/form') &&
      !item.url.includes('/viewer-app.js'),
  );
  const popupEvent = timeline.events.find(event => event.type === 'popup');
  const popupReferer = headerValue(popupDocument?.requestHeaders, 'referer');
  const postReferer = headerValue(postRequest?.requestHeaders, 'referer') || posted.referer;
  const postSample = JSON.stringify(postRequest?.requestBodySummary.sample || '');
  const failures = [
    !mainDocument ? '缺少主窗口 Document' : '',
    !popupDocument ? '缺少弹窗 Document' : '',
    popupDocument?.responseBodyCaptured !== true ? `弹窗 HTML 未采到正文 skip=${popupDocument?.responseBodySkippedReason || ''}` : '',
    popupDocument?.responseBodySkippedReason ? `弹窗 HTML skipped=${popupDocument.responseBodySkippedReason}` : '',
    !String(popupDocument?.responseBodySummary.sample || '').includes(POPUP_HTML_MARKER) &&
    !sourceFiles.some(file => file.url.includes('/popup.html') && file.text.includes(POPUP_HTML_MARKER))
      ? '弹窗 HTML marker 缺失'
      : '',
    !popupScript ? '缺少弹窗脚本' : '',
    popupScript?.responseBodyCaptured !== true ? `弹窗脚本未采到正文 skip=${popupScript?.responseBodySkippedReason || ''}` : '',
    popupScript?.responseBodySkippedReason ? `弹窗脚本 skipped=${popupScript.responseBodySkippedReason}` : '',
    !sourceFiles.some(file => file.kind === 'html' && file.text.includes(POPUP_HTML_MARKER))
      ? `sourceFiles 缺少 Viewer HTML: ${sourceFiles.map(file => file.url).join(', ') || '(empty)'}`
      : '',
    !sourceFiles.some(file => file.kind === 'javascript' && file.text.includes(VIEWER_JS_MARKER))
      ? 'sourceFiles 缺少 Viewer JS marker'
      : '',
    !(
      Boolean(popupEvent?.openerCaptureWindowId) &&
      Array.isArray(popupEvent?.ancestorCaptureWindowIds) &&
      (popupEvent?.ancestorCaptureWindowIds as unknown[]).length > 0
    )
      ? 'timeline 缺少 opener/ancestor 血缘'
      : '',
    !popupDocument?.openerCaptureWindowId || !popupDocument.ancestorCaptureWindowIds?.length
      ? '弹窗 HTTP 缺少 opener/ancestor 血缘'
      : '',
    !posted.received ? 'target=_blank POST 未到达服务端' : '',
    !postRequest ? '缺少 POST 网络记录' : '',
    !(popupReferer.includes(origin) || popupGets.referer.includes(origin)) ? '弹窗 referrer 丢失' : '',
    !postReferer.includes(origin) ? 'POST referrer 丢失' : '',
    !postSample.includes('html5') ? `POST 摘要缺少非敏感 viewer 字段: ${postSample}` : '',
    !postRequest?.requestBodySummary.redactedFields.some(field => /token/i.test(field))
      ? `POST token 未脱敏: ${JSON.stringify(postRequest?.requestBodySummary.redactedFields || [])}`
      : '',
    JSON.stringify(postRequest || {}).includes(POST_TOKEN) ? 'POST 明文 token 残留' : '',
  ].filter(Boolean);

  if (failures.length) {
    fail(
      [
        '生产采集链路 E2E 正文/血缘断言失败',
        ...failures,
        lastDump || '(no http requests)',
      ].join('\n'),
    );
  }

  const assembled = assembleCapturePackForExport({
    jobId: 'e2e-capture-controller',
    startedAt,
    endedAt: new Date().toISOString(),
    target: { host: '127.0.0.1', port, scheme: 'http' },
    probe: {
      basic: {
        host: '127.0.0.1',
        port,
        scheme: 'http',
        vendor: '',
        product: '',
        firmwareVersion: '',
      },
      paths: {},
      familySignatures: {
        primary: 'unknown-h5',
        confidence: 0,
        candidates: [],
      },
      tls: {
        reachable: true,
        authorized: true,
        authorizationError: '',
        protocol: '',
        cipher: null,
        certificate: null,
      },
    },
    page: controller.timeline(),
    network: controller.network(),
    sourceFiles: controller.sourceFiles(),
    networkIdle: controller.networkCaptureStatus(),
  });
  const zip = await buildCapturePackZip(assembled.pack);
  const summary = await summarizeCapturePackZip(zip);
  if (summary.schemaErrors.length) {
    fail(`导出 zip 自校验失败: ${summary.schemaErrors.join('; ')}`);
  }

  try {
    await controller.stop();
  } catch (error) {
    // 捕获 E2E 关窗失败：断言已通过
    // 策略：仍退出 0，避免清理失败掩盖生产链路已通过
    void error;
  }
  server.close();
  await rm(screenshotDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`${PRODUCTION_CAPTURE_E2E_PASSED} in ${startElapsedMs}ms`);
  app.exit(0);
}
