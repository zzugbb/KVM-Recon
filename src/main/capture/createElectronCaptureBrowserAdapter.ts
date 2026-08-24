import { BrowserWindow, session } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CaptureBrowserAdapter,
  CaptureBrowserAdapterOptions,
  CaptureBrowserWindowHandle,
} from './createCaptureBrowserController';
import type { CdpDebuggerLike } from './attachCdpNetworkCapture';

interface CreateElectronCaptureBrowserAdapterOptions {
  screenshotDir: string;
}

function sanitizeLabel(label: string) {
  return label.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'page';
}

const selectorScript = `
(() => {
  const items = [];
  const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
  for (const node of nodes) {
    const text = (node.innerText || node.value || node.getAttribute('aria-label') || '').trim();
    const id = node.id ? '#' + CSS.escape(node.id) : '';
    const testId = node.getAttribute('data-testid');
    const selector = testId ? '[data-testid="' + CSS.escape(testId) + '"]' : id || node.tagName.toLowerCase();
    const lower = text.toLowerCase();
    if (/kvm|console|remote|html5|远程|控制台/i.test(text)) {
      items.push({
        role: lower.includes('login') ? 'login' : 'kvm-entry',
        selector,
        confidence: 0.7
      });
    }
  }
  return items.slice(0, 20);
})()
`;

export function createElectronCaptureBrowserAdapter(
  adapterOptions: CreateElectronCaptureBrowserAdapterOptions,
): CaptureBrowserAdapter {
  return {
    async createWindow(options: CaptureBrowserAdapterOptions): Promise<CaptureBrowserWindowHandle> {
      const captureSession = session.fromPartition(options.partition);
      captureSession.setCertificateVerifyProc((request, callback) => {
        callback(options.allowCertificateError(`https://${request.hostname}/`) ? 0 : -3);
      });

      const window = new BrowserWindow({
        width: 1280,
        height: 860,
        title: `KVM-Recon Capture - ${options.targetHost}`,
        webPreferences: {
          partition: options.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });

      window.webContents.on('did-navigate', (_event, url) => {
        options.onNavigation(url);
      });
      window.webContents.on('did-navigate-in-page', (_event, url) => {
        options.onHashChange(url);
      });
      window.webContents.setWindowOpenHandler(details => {
        options.onPopup({
          url: details.url,
          disposition: details.disposition,
        });
        // 阶段 8.1：popup 目前只记录 URL 并允许同 partition 打开，未挂 CDP。
        // KVM viewer 若在新窗口建连，HTTP/WS 不会进入当前作业，直到为 popup webContents 调用 onNetworkDebugger。
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              partition: options.partition,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
            },
          },
        };
      });
      await options.onNetworkDebugger(window.webContents.debugger as unknown as CdpDebuggerLike);

      return {
        async loadURL(url) {
          await window.loadURL(url);
        },
        async collectStorageKeys() {
          return window.webContents.executeJavaScript(
            `({
              localStorageKeys: Object.keys(window.localStorage || {}),
              sessionStorageKeys: Object.keys(window.sessionStorage || {})
            })`,
            true,
          );
        },
        async collectSelectorCandidates() {
          return window.webContents.executeJavaScript(selectorScript, true);
        },
        async captureScreenshot(label) {
          await mkdir(adapterOptions.screenshotDir, { recursive: true });
          const fileName = `${sanitizeLabel(label)}-${Date.now()}.png`;
          const filePath = join(adapterOptions.screenshotDir, fileName);
          const image = await window.webContents.capturePage();
          await writeFile(filePath, image.toPNG());
          return {
            packPath: `page/screenshots/${fileName}`,
            sourcePath: filePath,
          };
        },
      };
    },
  };
}
