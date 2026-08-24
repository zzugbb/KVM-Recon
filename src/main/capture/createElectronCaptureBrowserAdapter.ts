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
  const push = (role, node, confidence) => {
    const id = node.id ? '#' + CSS.escape(node.id) : '';
    const testId = node.getAttribute('data-testid');
    const selector = testId ? '[data-testid="' + CSS.escape(testId) + '"]' : id || node.tagName.toLowerCase();
    items.push({ role, selector, confidence });
  };
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
  for (const node of controls) {
    const text = (node.innerText || node.value || node.getAttribute('aria-label') || '').trim();
    const lower = text.toLowerCase();
    if (/login|sign in|signin|submit|登录|登陆/i.test(text)) {
      push('login', node, 0.72);
    }
    if (/kvm|console|remote|html5|viewer|远程|控制台/i.test(text)) {
      push(lower.includes('login') ? 'login' : 'kvm-entry', node, 0.7);
    }
  }
  const viewers = Array.from(document.querySelectorAll('canvas, video, [id*="kvm" i], [class*="kvm" i], [id*="viewer" i], [class*="viewer" i]'));
  for (const node of viewers.slice(0, 8)) {
    push('viewer', node, 0.65);
  }
  return items.slice(0, 30);
})()
`;

const clickProbeScript = `
(() => {
  if (window.__kvmReconClickProbe) return true;
  window.__kvmReconClicks = [];
  window.__kvmReconClickProbe = true;
  document.addEventListener('click', (event) => {
    const node = event.target;
    if (!node || !node.tagName) return;
    const text = String(node.innerText || node.getAttribute('aria-label') || node.value || '').trim().slice(0, 80);
    const testId = node.getAttribute && node.getAttribute('data-testid');
    const selector = testId
      ? '[data-testid="' + testId + '"]'
      : (node.id ? '#' + node.id : node.tagName.toLowerCase());
    window.__kvmReconClicks.push({
      selector,
      text,
      tagName: String(node.tagName).toLowerCase()
    });
  }, true);
  return true;
})()
`;

function windowAlive(window: BrowserWindow | null): window is BrowserWindow {
  return window !== null && !window.isDestroyed();
}

export function createElectronCaptureBrowserAdapter(
  adapterOptions: CreateElectronCaptureBrowserAdapterOptions,
): CaptureBrowserAdapter {
  return {
    async createWindow(options: CaptureBrowserAdapterOptions): Promise<CaptureBrowserWindowHandle> {
      const captureSession = session.fromPartition(options.partition);
      captureSession.setCertificateVerifyProc((request, callback) => {
        callback(options.allowCertificateError(`https://${request.hostname}/`) ? 0 : -3);
      });

      const windows = new Set<BrowserWindow>();
      let foreground: BrowserWindow | null = null;

      function activeWindow() {
        if (windowAlive(foreground)) return foreground;
        const next = [...windows].find(windowAlive) || null;
        foreground = next;
        if (!next) {
          throw new Error('Capture browser has not started');
        }
        return next;
      }

      async function installPageProbe(targetWindow: BrowserWindow) {
        try {
          await targetWindow.webContents.executeJavaScript(clickProbeScript, true);
        } catch (error) {
          // 捕获页面脚本注入失败：文档可能尚未就绪或已导航离开
          // 策略：忽略本次注入，等待下次采集或 did-finish-load 再试
          void error;
        }
      }

      async function attachWindow(targetWindow: BrowserWindow) {
        windows.add(targetWindow);
        foreground = targetWindow;
        targetWindow.on('focus', () => {
          if (windowAlive(targetWindow)) foreground = targetWindow;
        });
        targetWindow.on('closed', () => {
          windows.delete(targetWindow);
          if (foreground === targetWindow) {
            foreground = [...windows].find(windowAlive) || null;
          }
          if (![...windows].some(windowAlive)) {
            options.onAllWindowsClosed();
          }
        });
        targetWindow.webContents.on('did-navigate', (_event, url) => {
          options.onNavigation(url);
        });
        targetWindow.webContents.on('did-navigate-in-page', (_event, url) => {
          options.onHashChange(url);
        });
        targetWindow.webContents.on('did-finish-load', () => {
          options.onChromiumAccess({ reachable: true, authorizationError: '' });
          void installPageProbe(targetWindow);
        });
        targetWindow.webContents.on('did-fail-load', (_event, _code, description) => {
          options.onChromiumAccess({
            reachable: false,
            authorizationError: String(description || 'did-fail-load'),
          });
        });
        targetWindow.webContents.setWindowOpenHandler(details => {
          options.onPopup({
            url: details.url,
            disposition: details.disposition,
          });
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
        targetWindow.webContents.on('did-create-window', childWindow => {
          void attachWindow(childWindow);
        });
        await options.onNetworkDebugger(targetWindow.webContents.debugger as unknown as CdpDebuggerLike);
      }

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

      await attachWindow(window);

      return {
        async loadURL(url) {
          await activeWindow().loadURL(url);
        },
        async collectStorageKeys() {
          return activeWindow().webContents.executeJavaScript(
            `({
              localStorageKeys: Object.keys(window.localStorage || {}),
              sessionStorageKeys: Object.keys(window.sessionStorage || {})
            })`,
            true,
          );
        },
        async collectSelectorCandidates() {
          return activeWindow().webContents.executeJavaScript(selectorScript, true);
        },
        async captureScreenshot(label) {
          const current = activeWindow();
          await mkdir(adapterOptions.screenshotDir, { recursive: true });
          const fileName = `${sanitizeLabel(label)}-${Date.now()}.png`;
          const filePath = join(adapterOptions.screenshotDir, fileName);
          const image = await current.webContents.capturePage();
          await writeFile(filePath, image.toPNG());
          return {
            packPath: `page/screenshots/${fileName}`,
            sourcePath: filePath,
          };
        },
        async drainClicks() {
          try {
            return await activeWindow().webContents.executeJavaScript(
              `(() => {
                const items = window.__kvmReconClicks || [];
                window.__kvmReconClicks = [];
                return items;
              })()`,
              true,
            );
          } catch (error) {
            // 捕获点击摘要读取失败：窗口可能已关闭
            // 策略：返回空列表，不影响 HTTP/WS 导出
            void error;
            return [];
          }
        },
        async collectSessionCookies() {
          try {
            const cookies = await captureSession.cookies.get({});
            return cookies.map(cookie => ({
              name: String(cookie.name || ''),
              value: String(cookie.value || ''),
            }));
          } catch (error) {
            // 捕获读取 Chromium Cookie 失败：分区可能已销毁
            // 策略：返回空列表，导出仍使用匿名探测结果，不记录 Cookie 值
            void error;
            return [];
          }
        },
        async close() {
          for (const targetWindow of [...windows]) {
            try {
              if (!targetWindow.isDestroyed()) {
                targetWindow.close();
              }
            } catch (error) {
              // 捕获关闭单个采集窗口失败：窗口可能已销毁
              // 策略：继续关闭其余窗口，避免作业句柄泄漏
              void error;
            }
          }
          windows.clear();
          foreground = null;
        },
      };
    },
  };
}
