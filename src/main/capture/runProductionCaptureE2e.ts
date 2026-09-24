/**
 * 生产采集链路 E2E：createProductionCapture → stop →
 * exportPack → 直接断言 ZIP 内容。
 *
 * 不脱敏断言：POST token 必须原样在请求正文文件里逐字节可见。
 * 血缘断言：popup 根 target 带 windowRole=popup + openerTargetId=target-root。
 * 包一致性：verifyPackV2Zip 重开逐条目校验 + INCOMPLETE + capture-facts 终态。
 */

import { app, BrowserWindow } from 'electron';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseChecksumsManifest, sha256OfContent } from '../../core/export/checksumsManifest';
import { PACK_V2_CHECKSUMS_PATH, verifyPackV2Zip } from '../../core/export/exportPackV2Zip';
import { readZipEntries } from '../../core/export/readZipEntries';
import type { ProbeBmcTargetResult } from '../../core/probe/probeBmcTarget';
import { createProductionCapture } from './productionCaptureController';
import { createElectronNetlogSource } from './electronNetlogSource';
import { PRODUCTION_CAPTURE_E2E_PASSED } from './evaluateProductionCaptureE2eExit';

const VIEWER_JS_MARKER = 'kvm-recon-e2e-viewer-js';
const POPUP_HTML_MARKER = 'kvm-recon-e2e-popup-html';
const POST_TOKEN = 'e2e-secret-token';

export const FIELD_HAR_REPLAY_E2E_PASSED = 'field har replay e2e passed';

export function isE2eCaptureControllerLaunch() {
  return process.argv.includes('--e2e-capture-controller') || process.env.KVM_RECON_E2E_CAPTURE === '1';
}

export function isE2eCaptureCloseBeforeAssert() {
  return (
    process.argv.includes('--e2e-capture-close-before-assert') ||
    process.env.KVM_RECON_E2E_CLOSE_BEFORE_ASSERT === '1'
  );
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fail(message: string): never {
  console.error(message);
  app.exit(1);
  process.exit(1);
}

export { readZipEntries };

export async function runProductionCaptureE2e() {
  const workspacesRoot = await mkdtemp(join(tmpdir(), 'kvm-recon-e2e-ws-'));
  const zipDir = await mkdtemp(join(tmpdir(), 'kvm-recon-e2e-zip-'));
  const posted = { received: false };
  const popupLoaded = { received: false };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = String(req.url || '/');
    if (url.startsWith('/viewer-app.js')) {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.end(`window.__viewerAppLoaded = true; // ${VIEWER_JS_MARKER}`);
      return;
    }
    if (url.startsWith('/popup')) {
      popupLoaded.received = true;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body>
        <!-- ${POPUP_HTML_MARKER} -->
        <script src="/viewer-app.js"></script>
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
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><body>posted</body></html>');
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

  // probe 用确定性桩（E2E 断言采集链路，probe 正确性另有单测）；
  // 调用计数供并发 stop 幂等断言（start 匿名 1 次 + stop 认证 1 次）
  let e2eProbeCalls = 0;
  const e2eProbe = async (): Promise<ProbeBmcTargetResult> => {
    e2eProbeCalls += 1;
    return {
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
    };
  };

  const controller = await createProductionCapture({
    jobId: 'e2e-capture-controller',
    workspacesRootDir: workspacesRoot,
    target: { host: '127.0.0.1', port, scheme: 'http', originalInput: `http://127.0.0.1:${port}/` },
    tool: { version: '0.3.0-dev', buildId: 'e2e' },
    probeRunner: e2eProbe,
    netlog: createElectronNetlogSource(),
  });

  const startTimeoutMs = 15000;
  const startClock = Date.now();
  try {
    await Promise.race([
      controller.start(),
      sleep(startTimeoutMs).then(() => {
        throw new Error(`controller.start() ${startTimeoutMs}ms 未返回`);
      }),
    ]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    server.close();
    await rm(workspacesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(zipDir, { recursive: true, force: true }).catch(() => undefined);
    app.exit(1);
    return;
  }
  const startElapsedMs = Date.now() - startClock;

  // 等待页面链路走完（弹窗 + POST 到达服务端 + 事务落盘）
  let transactionsText = '';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      transactionsText = (await controller.session.workspace.readArtifact('raw/http/transactions.jsonl')).toString('utf8');
    } catch {
      transactionsText = '';
    }
    if (posted.received && popupLoaded.received && transactionsText.includes('/form-target') && transactionsText.includes('/viewer-app.js')) {
      break;
    }
    await sleep(250);
  }

  // 断言前关窗变体：窗口全部销毁后 stop/export 仍必须收尾出包（INCOMPLETE）
  if (isE2eCaptureCloseBeforeAssert()) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
    await sleep(300);
  }

  // 并发 stop 必须共享同一次收尾——重入各跑一遍收尾序列会
  // 重复执行认证 probe（两次带会话 Cookie 的网络探测）
  await Promise.all([controller.stop(), controller.stop()]);
  const exportResult = await controller.exportPack(zipDir);

  const zipEntries = await readZipEntries(exportResult.zipPath);

  const transactions = zipEntries.get('raw/http/transactions.jsonl') ?? '';
  const transactionRows = transactions
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { url: string; method: string; requestBody?: { path: string; sha256: string } });
  const postRequest = transactionRows.find(
    row => row.method.toUpperCase() === 'POST' && row.url.includes('/form-target'),
  );
  const popupDocument = transactionRows.find(row => row.url.includes('/popup'));
  const viewerScript = transactionRows.find(row => row.url.includes('/viewer-app.js'));

  const targetsFile = JSON.parse(zipEntries.get('raw/browser/targets.json') ?? '{"targets":[]}') as {
    targets: Array<{ id: string; type: string; openerTargetId?: string }>;
  };
  const captureFacts = JSON.parse(zipEntries.get('catalog/capture-facts.json') ?? 'null') as {
    stopped: boolean;
    evidenceSummary: unknown;
    environment: unknown;
  } | null;
  const manifest = JSON.parse(zipEntries.get('manifest.json') ?? 'null') as {
    workflowStatus?: string;
    security?: { dataHandling?: string };
    environment?: { userAgent?: string };
  } | null;
  const netlog = JSON.parse(zipEntries.get('raw/netlog/netlog.json') ?? 'null') as {
    captureMode?: string;
  } | null;
  const diagnosticsRows = (zipEntries.get('raw/controller/diagnostics.jsonl') ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { kind?: string });
  const closeBeforeAssert = isE2eCaptureCloseBeforeAssert();

  const failures = [
    !posted.received ? 'target=_blank POST 未到达服务端' : '',
    e2eProbeCalls !== 2
      ? `并发 stop 收尾序列重复执行（probe 跑了 ${e2eProbeCalls} 次，应为 start 1 次 + stop 1 次）`
      : '',
    !popupLoaded.received ? '弹窗未加载' : '',
    !postRequest ? `缺少 POST 事务记录（transactions: ${transactions.slice(0, 400) || '(empty)'}）` : '',
    !popupDocument ? '缺少弹窗 Document 事务' : '',
    !viewerScript ? '缺少弹窗脚本事务' : '',
    // 不脱敏断言（规范 §13）：POST token 必须原样在场，禁止任何脱敏残留
    !postRequest?.requestBody ? 'POST 缺少请求正文引用' : '',
    postRequest?.requestBody && !(zipEntries.get(postRequest.requestBody.path) ?? '').includes(POST_TOKEN)
      ? `POST token 未原样保留（正文文件 ${postRequest.requestBody.path}）`
      : '',
    zipEntries.get(postRequest?.requestBody?.path ?? '')?.includes('viewer=html5') ? '' : 'POST 正文缺少 viewer=html5 字段',
    !targetsFile.targets.some(
      target => target.type === 'popup' && target.openerTargetId === 'target-root',
    )
      ? `popup 根 target 缺少血缘（targets: ${JSON.stringify(targetsFile.targets.map(t => [t.id, t.type, t.openerTargetId]))}）`
      : '',
    !captureFacts?.stopped ? 'capture-facts 缺少 stopped 终态' : '',
    !captureFacts?.evidenceSummary ? 'capture-facts 缺少证据摘要' : '',
    !captureFacts?.environment ? 'capture-facts 缺少采集环境' : '',
    manifest?.workflowStatus !== 'TARGET_OPENED' ? `manifest workflowStatus 异常：${manifest?.workflowStatus}` : '',
    manifest?.security?.dataHandling !== 'UNREDACTED' ? `manifest dataHandling 异常：${manifest?.security?.dataHandling}` : '',
    !manifest?.environment?.userAgent ? 'manifest 缺少页面环境（userAgent）' : '',
    netlog?.captureMode !== 'include-sensitive' ? `netlog captureMode 异常：${netlog?.captureMode ?? '(missing)'}` : '',
    !diagnosticsRows.some(row => row.kind === 'window-created')
      ? 'Controller 诊断缺少 window-created 事实（规范 §8.4）'
      : '',
    !diagnosticsRows.some(row => row.kind === 'popup-created')
      ? 'Controller 诊断缺少 popup-created 事实（规范 §8.4）'
      : '',
    // 关窗变体里窗口已销毁、Page.getFrameTree 必然失败并记账，只对常规变体断言
    !closeBeforeAssert && !zipEntries.get('raw/browser/frame-tree.json')
      ? '缺少 Frame Tree 快照（规范 §8.4）'
      : '',
    exportResult.status.captureIntegrity !== 'INCOMPLETE' ? `包完整度应为 INCOMPLETE：${exportResult.status.captureIntegrity}` : '',
    !exportResult.derived.reasons.includes('INCOMPLETE_WORKFLOW_NOT_REACHED')
      ? 'INCOMPLETE 包缺少 INCOMPLETE_WORKFLOW_NOT_REACHED 原因'
      : '',
  ].filter(Boolean);

  // 弹窗正文 marker：事务引用的响应正文文件必须包含 marker
  const resourcesText = zipEntries.get('catalog/resources.jsonl') ?? '';
  const resourceRows = resourcesText
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { url: string; responseBody?: { path: string } });
  const popupResource = resourceRows.find(row => row.url.includes('/popup'));
  const viewerResource = resourceRows.find(row => row.url.includes('/viewer-app.js'));
  if (!popupResource?.responseBody) {
    failures.push('catalog/resources 缺少弹窗 HTML 正文引用');
  } else if (!(zipEntries.get(popupResource.responseBody.path) ?? '').includes(POPUP_HTML_MARKER)) {
    failures.push(`弹窗 HTML 正文缺 marker（${popupResource.responseBody.path}）`);
  }
  if (!viewerResource?.responseBody) {
    failures.push('catalog/resources 缺少弹窗脚本正文引用');
  } else if (!(zipEntries.get(viewerResource.responseBody.path) ?? '').includes(VIEWER_JS_MARKER)) {
    failures.push(`弹窗脚本正文缺 marker（${viewerResource.responseBody.path}）`);
  }

  if (failures.length) {
    fail(['生产采集链路 E2E（0.3.0 新链路）断言失败', ...failures].join('\n'));
  }

  // 包一致性：checksums 清单 + 自身哈希 → 重开逐条目校验
  const checksums = zipEntries.get(PACK_V2_CHECKSUMS_PATH);
  if (!checksums) {
    fail('ZIP 缺少 checksums.sha256');
  }
  const expected = parseChecksumsManifest(checksums!);
  expected.set(PACK_V2_CHECKSUMS_PATH, sha256OfContent(checksums!));
  try {
    await verifyPackV2Zip(exportResult.zipPath, expected);
  } catch (error) {
    fail(`ZIP 重开校验失败：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await controller.closeWindows();
  } catch (error) {
    // 捕获 E2E 关窗失败：断言已通过
    // 策略：仍退出 0，避免清理失败掩盖生产链路已通过
    void error;
  }
  server.close();
  await rm(workspacesRoot, { recursive: true, force: true }).catch(() => undefined);
  console.log(`${PRODUCTION_CAPTURE_E2E_PASSED} in ${startElapsedMs}ms zip=${exportResult.zipPath}`);
  app.exit(0);
}
