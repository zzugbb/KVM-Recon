import { BrowserWindow, session } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CaptureBrowserAdapter,
  CaptureBrowserAdapterOptions,
  CaptureBrowserWindowHandle,
} from './createCaptureBrowserController';
import type { CdpDebuggerLike } from './attachCdpNetworkCapture';
import { recordCaptureWindowLog, registerCaptureSession } from './captureWindowDiagnostics';

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
      registerCaptureSession(captureSession);
      captureSession.setCertificateVerifyProc((_request, callback) => {
        // 采集分区只打开目标 BMC。现场自签证书在 Chrome 要点「高级」；这里直接放行，避免白屏。
        callback(0);
      });

      const windows = new Set<BrowserWindow>();
      const windowRoles = new Map<BrowserWindow, 'main' | 'popup'>();
      let foreground: BrowserWindow | null = null;
      let debuggerCount = 0;

      function activeWindow() {
        if (windowAlive(foreground)) return foreground;
        const next = [...windows].find(windowAlive) || null;
        foreground = next;
        if (!next) {
          throw new Error('Capture browser has not started');
        }
        return next;
      }

      async function windowHasKvmSurface(targetWindow: BrowserWindow) {
        try {
          return Boolean(
            await targetWindow.webContents.executeJavaScript(
              `Boolean(document.querySelector('canvas, video, embed, object, [id*="kvm" i], [class*="kvm" i], [id*="viewer" i], [class*="viewer" i]'))`,
              true,
            ),
          );
        } catch (error) {
          // 捕获判断 KVM 画面失败：弹窗可能尚未加载或已关闭
          // 策略：当作没有画面，继续检查其他窗口
          void error;
          return false;
        }
      }

      async function pickScreenshotWindow(options?: { requireKvmSurface?: boolean; preferredWindowRole?: 'main' | 'popup' }) {
        const alive = [...windows].filter(windowAlive);
        const preferred = alive.filter(
          candidate => !options?.preferredWindowRole || windowRoles.get(candidate) === options.preferredWindowRole,
        );
        const ordered = [...preferred, ...alive.filter(candidate => !preferred.includes(candidate))];
        if (
          windowAlive(foreground) &&
          (!options?.preferredWindowRole || windowRoles.get(foreground) === options.preferredWindowRole) &&
          (await windowHasKvmSurface(foreground))
        ) {
          return foreground;
        }
        for (const candidate of ordered) {
          if (candidate !== foreground && (await windowHasKvmSurface(candidate))) {
            return candidate;
          }
        }
        if (options?.requireKvmSurface) return null;
        return activeWindow();
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

      async function attachWindow(targetWindow: BrowserWindow, attachDebugger: boolean) {
        windows.add(targetWindow);
        foreground = targetWindow;
        if (!windowRoles.has(targetWindow)) {
          windowRoles.set(targetWindow, debuggerCount++ === 0 ? 'main' : 'popup');
        }
        targetWindow.on('focus', () => {
          if (windowAlive(targetWindow)) foreground = targetWindow;
        });
        targetWindow.on('closed', () => {
          windows.delete(targetWindow);
          windowRoles.delete(targetWindow);
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
        targetWindow.webContents.session.setCertificateVerifyProc((_request, callback) => {
          callback(0);
        });
        targetWindow.webContents.on(
          'certificate-error',
          (event, url, error, _certificate, callback) => {
            event.preventDefault();
            callback(true);
            recordCaptureWindowLog(`capture-cert-trusted ${error} ${url}`);
          },
        );
        targetWindow.webContents.on('did-navigate-in-page', (_event, url) => {
          options.onHashChange(url);
        });
        targetWindow.webContents.on('did-finish-load', () => {
          options.onChromiumAccess({ reachable: true, authorizationError: '' });
          recordCaptureWindowLog(`capture-window-loaded ${targetWindow.webContents.getURL()}`);
          void installPageProbe(targetWindow);
        });
        targetWindow.webContents.on(
          'did-fail-load',
          (_event, errorCode, description, validatedURL, isMainFrame) => {
            if (!isMainFrame) return;
            // 采集窗口主框加载失败：证书、DNS、TLS、被导航拦截等
            // 策略：写入 chromiumAccess 与诊断日志；窗口可能仍是白屏
            recordCaptureWindowLog(
              `capture-window-fail-load ${errorCode} ${description} ${validatedURL}`,
            );
            options.onChromiumAccess({
              reachable: false,
              authorizationError: `${errorCode} ${description || 'did-fail-load'}`.trim(),
            });
          },
        );
        targetWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
          if (level < 2) return;
          // 只记录告警/错误；正文截断并去掉明显敏感词，避免把 BMC 页面日志里的口令打出来
          const safe = String(message)
            .replace(/password|passwd|cookie|token|authorization/gi, '[redacted]')
            .slice(0, 240);
          recordCaptureWindowLog(`capture-console level=${level} ${safe} (${sourceId}:${line})`);
        });
        targetWindow.webContents.on('render-process-gone', (_event, details) => {
          recordCaptureWindowLog(
            `capture-renderer-gone reason=${details.reason} exit=${details.exitCode}`,
          );
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
                webSecurity: false,
              },
            },
          };
        });
        targetWindow.webContents.on('did-create-window', childWindow => {
          void attachWindow(childWindow, true);
        });
        if (attachDebugger) {
          await options.onNetworkDebugger(targetWindow.webContents.debugger as unknown as CdpDebuggerLike);
          recordCaptureWindowLog(`capture-cdp-attached role=${windowRoles.get(targetWindow) || 'unknown'}`);
        }
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
          webSecurity: false,
        },
      });

      await attachWindow(window, true);
      recordCaptureWindowLog(`capture-window-created host=${options.targetHost} partition=${options.partition}`);

      return {
        async loadURL(url) {
          const current = activeWindow();
          recordCaptureWindowLog(`capture-load-start ${url}`);
          try {
            await current.loadURL(url);
            recordCaptureWindowLog(`capture-load-done ${current.webContents.getURL()}`);
          } catch (error) {
            recordCaptureWindowLog(
              `capture-load-error ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
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
        async captureScreenshot(label, screenshotOptions) {
          const requireKvmSurface = /^viewer/i.test(label);
          const current = await pickScreenshotWindow({
            requireKvmSurface,
            preferredWindowRole: screenshotOptions?.preferredWindowRole,
          });
          if (!current) {
            throw new Error('No KVM viewer surface is ready for screenshot');
          }
          await mkdir(adapterOptions.screenshotDir, { recursive: true });
          const fileName = `${sanitizeLabel(label)}-${Date.now()}.png`;
          const filePath = join(adapterOptions.screenshotDir, fileName);
          const image = await current.webContents.capturePage();
          await writeFile(filePath, image.toPNG());
          recordCaptureWindowLog(`capture-screenshot ${fileName} ${current.webContents.getURL()}`);
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
