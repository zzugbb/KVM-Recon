import { BrowserWindow, session, webContents, type WebContents } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CaptureBrowserAdapter,
  CaptureBrowserAdapterOptions,
  CaptureBrowserWindowHandle,
  CapturePageTarget,
} from './createCaptureBrowserController';
import { pickCaptureWindow } from '../../core/browser/pickCaptureWindow';
import { nativePopupWindowOpenHandler, popupWindowFacts } from '../../core/browser/popupWindowFacts';
import { SOURCE_REFERENCED_LIMIT } from '../../core/network/sourceCapture';
import type { CdpDebuggerLike } from './attachCdpNetworkCapture';
import { recordCaptureWindowLog, registerCaptureSession } from './captureWindowDiagnostics';

interface CreateElectronCaptureBrowserAdapterOptions {
  screenshotDir: string;
}

function sanitizeLabel(label: string) {
  return label.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'page';
}

function selectorScript(includeAnyFrame: boolean) {
  return `
(() => {
  const includeAnyFrame = ${JSON.stringify(includeAnyFrame)};
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
  const frames = Array.from(document.querySelectorAll('iframe'));
  for (const node of frames.slice(0, 8)) {
    const hint = [node.src, node.name, node.id, node.className, node.title].join(' ');
    let containsViewer = false;
    try {
      containsViewer = Boolean(node.contentDocument && node.contentDocument.querySelector(
        'canvas, video, embed, object, [id*="kvm" i], [class*="kvm" i], [id*="viewer" i], [class*="viewer" i]'
      ));
    } catch (_error) {
      containsViewer = false;
    }
    if (includeAnyFrame || containsViewer || /kvm|console|viewer|vnc|irc|remote/i.test(hint)) {
      push('viewer', node, containsViewer ? 0.7 : (includeAnyFrame ? 0.5 : 0.62));
    }
  }
  return items.slice(0, 30);
})()
`;
}

const referencedScriptsCollector = `
(() => {
  const items = [];
  const seen = new Set();
  const push = (url, kind, initiator) => {
    if (!url || String(url).startsWith('data:') || String(url).startsWith('blob:')) return;
    const key = String(url).split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ url: String(url), kind, initiator });
  };
  const walk = (doc) => {
    if (!doc) return;
    for (const node of Array.from(doc.scripts || [])) {
      if (node.src) push(node.src, 'javascript', 'script-tag');
    }
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        const name = String(entry.name || '');
        const initiator = String(entry.initiatorType || '');
        if (initiator === 'script' || initiator === 'worker' || /\\.(?:m?js|html?)(?:[?#]|$)/i.test(name)) {
          push(name, /\\.html?(?:[?#]|$)/i.test(name) ? 'html' : 'javascript', initiator || 'performance');
        }
      }
    } catch (_error) {}
    for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
      try { walk(frame.contentDocument); } catch (_error) {}
      if (frame.src) push(frame.src, 'html', 'iframe');
    }
  };
  walk(document);
  return {
    scripts: items.slice(0, ${SOURCE_REFERENCED_LIMIT}),
    truncated: items.length > ${SOURCE_REFERENCED_LIMIT},
    total: items.length
  };
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
      const cdpByContentsId = new Map<number, Promise<void>>();
      function ensureCdp(contents: WebContents) {
        const existing = cdpByContentsId.get(contents.id);
        if (existing) return existing;
        const matched = [...windows].find(
          candidate => windowAlive(candidate) && candidate.webContents.id === contents.id,
        );
        const windowRole = matched
          ? windowRoles.get(matched) || 'popup'
          : debuggerCount === 0
            ? 'main'
            : 'popup';
        const started = (async () => {
          try {
            await options.onNetworkDebugger(contents.debugger as unknown as CdpDebuggerLike, {
              windowRole,
              captureWindowId: String(contents.id),
              openerCaptureWindowId: matched ? windowOpeners.get(matched) : undefined,
              ancestorCaptureWindowIds: matched ? windowAncestors.get(matched) : undefined,
            });
            recordCaptureWindowLog(`capture-cdp-attached role=${windowRole}`);
          } catch (error) {
            // 捕获 debugger.attach 或 Network.enable 失败：弹窗 CDP 可能被占用
            // 策略：记入 attachFailures，窗口继续用于截图，避免未处理拒绝
            options.onAttachFailure?.(String(contents.id), 'cdp-attach-failed');
            recordCaptureWindowLog(`capture-cdp-attach-failed window=${contents.id}`);
            void error;
          }
        })();
        cdpByContentsId.set(contents.id, started);
        return started;
      }
      captureSession.webRequest.onBeforeRequest((details, callback) => {
        const contents =
          typeof details.webContentsId === 'number' ? webContents.fromId(details.webContentsId) : undefined;
        if (contents && contents.session === captureSession && contents.getType() === 'window') {
          void ensureCdp(contents);
        }
        callback({});
      });
      captureSession.setCertificateVerifyProc((_request, callback) => {
        // 采集分区只打开目标 BMC。现场自签证书在 Chrome 要点「高级」；这里直接放行，避免白屏。
        callback(0);
      });

      const windows = new Set<BrowserWindow>();
      const windowRoles = new Map<BrowserWindow, 'main' | 'popup'>();
      const windowOpeners = new Map<BrowserWindow, string>();
      const windowAncestors = new Map<BrowserWindow, string[]>();
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

      function pageTarget(targetWindow: BrowserWindow): CapturePageTarget {
        const openerCaptureWindowId = windowOpeners.get(targetWindow);
        const ancestorCaptureWindowIds = windowAncestors.get(targetWindow);
        return {
          windowId: String(targetWindow.webContents.id),
          windowRole: windowRoles.get(targetWindow) || 'main',
          ...(openerCaptureWindowId ? { openerCaptureWindowId } : {}),
          ...(ancestorCaptureWindowIds?.length ? { ancestorCaptureWindowIds } : {}),
        };
      }

      function targetWindow(target?: CapturePageTarget) {
        if (!target) return activeWindow();
        const matched = [...windows].find(
          candidate => windowAlive(candidate) && String(candidate.webContents.id) === target.windowId,
        );
        if (!matched) throw new Error(`Capture window ${target.windowId} is no longer available`);
        return matched;
      }

      async function windowHasKvmSurface(targetWindow: BrowserWindow) {
        try {
          return Boolean(
            await targetWindow.webContents.executeJavaScript(
              `(() => {
                if (document.querySelector('canvas, video, embed, object, [id*="kvm" i], [class*="kvm" i], [id*="viewer" i], [class*="viewer" i]')) return true;
                return Array.from(document.querySelectorAll('iframe')).some(frame => {
                  const hint = [frame.src, frame.name, frame.id, frame.className, frame.title].join(' ');
                  if (/kvm|console|viewer|vnc|irc|remote/i.test(hint)) return true;
                  try {
                    return Boolean(frame.contentDocument && frame.contentDocument.querySelector(
                      'canvas, video, embed, object, [id*="kvm" i], [class*="kvm" i], [id*="viewer" i], [class*="viewer" i]'
                    ));
                  } catch (_error) {
                    return false;
                  }
                });
              })()`,
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

      async function pickScreenshotWindow(options?: {
        requireKvmSurface?: boolean;
        preferredWindowRole?: 'main' | 'popup';
        preferredCaptureWindowId?: string;
      }) {
        return pickCaptureWindow({
          alive: [...windows].filter(windowAlive),
          foreground,
          preferredCaptureWindowId: options?.preferredCaptureWindowId,
          preferredWindowRole: options?.preferredWindowRole,
          requireKvmSurface: options?.requireKvmSurface,
          windowId: candidate => String(candidate.webContents.id),
          windowRole: candidate => windowRoles.get(candidate) || 'main',
          hasKvmSurface: windowHasKvmSurface,
        });
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

      async function attachWindow(
        targetWindow: BrowserWindow,
        attachDebugger: boolean,
        lineage?: { openerCaptureWindowId?: string; ancestorCaptureWindowIds?: string[] },
      ) {
        windows.add(targetWindow);
        foreground = targetWindow;
        if (!windowRoles.has(targetWindow)) {
          windowRoles.set(targetWindow, debuggerCount++ === 0 ? 'main' : 'popup');
        }
        if (lineage?.openerCaptureWindowId) {
          windowOpeners.set(targetWindow, lineage.openerCaptureWindowId);
          windowAncestors.set(
            targetWindow,
            lineage.ancestorCaptureWindowIds?.length
              ? [...lineage.ancestorCaptureWindowIds]
              : [lineage.openerCaptureWindowId],
          );
        }
        if (attachDebugger) {
          try {
            await ensureCdp(targetWindow.webContents);
          } catch (error) {
            // 捕获 debugger.attach 或 Network.enable 失败：弹窗 CDP 可能被占用
            // 策略：记入 attachFailures，窗口继续用于截图，避免未处理拒绝
            options.onAttachFailure?.(
              String(targetWindow.webContents.id),
              'cdp-attach-failed',
            );
            recordCaptureWindowLog(
              `capture-cdp-attach-failed window=${targetWindow.webContents.id}`,
            );
            void error;
          }
        }
        targetWindow.on('focus', () => {
          if (windowAlive(targetWindow)) foreground = targetWindow;
        });
        targetWindow.on('closed', () => {
          windows.delete(targetWindow);
          windowRoles.delete(targetWindow);
          windowOpeners.delete(targetWindow);
          windowAncestors.delete(targetWindow);
          if (foreground === targetWindow) {
            foreground = [...windows].find(windowAlive) || null;
          }
          if (![...windows].some(windowAlive)) {
            options.onAllWindowsClosed();
          }
        });
        targetWindow.webContents.on('did-navigate', (_event, url) => {
          options.onNavigation({
            url,
            windowRole: windowRoles.get(targetWindow) || 'main',
            captureWindowId: String(targetWindow.webContents.id),
          });
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
          options.onHashChange({
            url,
            windowRole: windowRoles.get(targetWindow) || 'main',
            captureWindowId: String(targetWindow.webContents.id),
          });
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
        targetWindow.webContents.setWindowOpenHandler(() =>
          nativePopupWindowOpenHandler({ partition: options.partition }),
        );
        targetWindow.webContents.on('did-create-window', (childWindow, details) => {
          const facts = popupWindowFacts({
            childCaptureWindowId: String(childWindow.webContents.id),
            openerCaptureWindowId: String(targetWindow.webContents.id),
            openerAncestorCaptureWindowIds: windowAncestors.get(targetWindow),
            details,
            fallbackUrl: childWindow.webContents.getURL(),
          });
          options.onPopup(facts);
          void attachWindow(childWindow, true, {
            openerCaptureWindowId: facts.openerCaptureWindowId,
            ancestorCaptureWindowIds: facts.ancestorCaptureWindowIds,
          }).catch(error => {
            // 捕获弹窗窗口挂载失败：debugger.attach、Network.enable 或页面脚本注入拒绝
            // 策略：记入 attachFailures，避免未处理拒绝；KVM 弹窗仍可显示但清单 PARTIAL
            options.onAttachFailure?.(facts.captureWindowId, 'popup-attach-failed');
            recordCaptureWindowLog(
              `capture-popup-attach-failed window=${facts.captureWindowId}`,
            );
            void error;
          });
        });
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
        async selectPageTarget(targetOptions) {
          const selected = await pickScreenshotWindow(targetOptions);
          if (!selected) throw new Error('No KVM viewer surface is ready for page capture');
          return pageTarget(selected);
        },
        async collectStorageKeys(targetOptions) {
          return targetWindow(targetOptions?.target).webContents.executeJavaScript(
            `({
              localStorageKeys: Object.keys(window.localStorage || {}),
              sessionStorageKeys: Object.keys(window.sessionStorage || {})
            })`,
            true,
          );
        },
        async collectSelectorCandidates(targetOptions) {
          return targetWindow(targetOptions?.target).webContents.executeJavaScript(
            selectorScript(targetOptions?.expectedRole === 'viewer'),
            true,
          );
        },
        async captureScreenshot(label, screenshotOptions) {
          const requireKvmSurface = /^viewer/i.test(label);
          const current = screenshotOptions?.target
            ? targetWindow(screenshotOptions.target)
            : await pickScreenshotWindow({
                requireKvmSurface,
                preferredWindowRole: screenshotOptions?.preferredWindowRole,
                preferredCaptureWindowId: screenshotOptions?.preferredCaptureWindowId,
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
            ...pageTarget(current),
          };
        },
        async drainClicks(targetOptions) {
          try {
            const current = targetWindow(targetOptions?.target);
            const clicks = await current.webContents.executeJavaScript(
              `(() => {
                const items = window.__kvmReconClicks || [];
                window.__kvmReconClicks = [];
                return items;
              })()`,
              true,
            );
            return (clicks as Array<{ selector: string; text: string; tagName: string }>).map(
              click => ({
                ...click,
                windowRole: windowRoles.get(current) || 'main',
                captureWindowId: String(current.webContents.id),
              }),
            );
          } catch (error) {
            // 捕获点击摘要读取失败：窗口可能已关闭
            // 策略：返回空列表，不影响 HTTP/WS 导出
            void error;
            return [];
          }
        },
        async collectReferencedScripts() {
          const groups: Array<{
            windowRole: 'main' | 'popup';
            captureWindowId: string;
            scripts: Array<{ url: string; kind?: 'javascript' | 'html'; initiator?: string }>;
            truncated?: boolean;
            total?: number;
          }> = [];
          for (const current of [...windows]) {
            if (!windowAlive(current)) continue;
            try {
              const result = (await current.webContents.executeJavaScript(
                referencedScriptsCollector,
                true,
              )) as { scripts?: unknown; truncated?: unknown; total?: unknown } | unknown[];
              const scripts = Array.isArray(result)
                ? result
                : Array.isArray(result.scripts)
                  ? result.scripts
                  : [];
              groups.push({
                windowRole: windowRoles.get(current) || 'main',
                captureWindowId: String(current.webContents.id),
                scripts: scripts as Array<{ url: string; kind?: 'javascript' | 'html'; initiator?: string }>,
                ...(!Array.isArray(result) && result.truncated
                  ? { truncated: true, total: Number(result.total) || scripts.length }
                  : {}),
              });
            } catch (error) {
              // 捕获页面引用脚本清单失败：文档可能尚未就绪或跨域 iframe 不可读
              // 策略：跳过该窗口，保留已观察到的 HTTP 源码，清单按覆盖率判定
              void error;
            }
          }
          return groups;
        },
        async collectSessionCookies(targetUrl) {
          try {
            const cookies = await captureSession.cookies.get({ url: targetUrl });
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
