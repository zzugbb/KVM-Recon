import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  compareCapturePacks,
  summarizeCapturePackZip,
} from '../core/capture-pack/summarizeCapturePack';
import type { CaptureTarget } from '../core/capture-pack/types';
import { canAddCaptureJob, type CaptureJobSummary } from '../core/delivery/captureJob';
import { exportCaptureJob, type CaptureExportJob } from '../core/delivery/exportCaptureJob';
import { normalizeOperatorObserved, type OperatorObservedAsset } from '../core/delivery/operatorObserved';
import {
  classifyCaptureError,
  formatCaptureError,
} from '../core/delivery/formatCaptureError';
import { buildLiveCaptureSnapshot } from '../core/delivery/buildLiveCaptureSnapshot';
import { createCaptureLogger } from '../core/log/createCaptureLogger';
import {
  detectKvmFamily,
  tlsOrganizationFromCertificate,
  trafficEvidenceFromNetwork,
} from '../core/signatures/detectKvmFamily';
import { applyAuthenticatedProbe, probeBmcTarget } from '../core/probe/probeBmcTarget';
import { createNodeProbeHttpClient } from '../core/probe/createNodeProbeHttpClient';
import { createCaptureBrowserController } from './capture/createCaptureBrowserController';
import { createElectronCaptureBrowserAdapter } from './capture/createElectronCaptureBrowserAdapter';
import { getCaptureWindowLogs, isCaptureSession, recordCaptureWindowLog } from './capture/captureWindowDiagnostics';

const logger = createCaptureLogger();

// 必须在 app ready 之前：现场 BMC 自签证书在 Chrome 要点「高级」，采集窗没有该页面，不忽略就会白屏。
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-running-insecure-content');

interface CaptureSession extends CaptureExportJob {
  controller: ReturnType<typeof createCaptureBrowserController>;
  exported: boolean;
  exportedAt?: string;
}

const captureSessions = new Map<string, CaptureSession>();

function sessionSnapshot(session: CaptureSession) {
  return {
    windowsOpen: session.controller.windowsOpen(),
    paused: session.controller.isPaused(),
    capturingScreenshot: session.controller.isCapturingScreenshot(),
    ...buildLiveCaptureSnapshot({
      probe: session.probe,
      page: session.controller.timeline(),
      network: session.controller.network(),
    }),
  };
}

function toJobSummary(session: CaptureSession): CaptureJobSummary {
  const snapshot = sessionSnapshot(session);
  return {
    jobId: session.jobId,
    host: session.target.host,
    port: session.target.port,
    scheme: session.target.scheme,
    family: detectKvmFamily({
      redfish: {
        vendor: session.probe.basic.vendor,
        product: session.probe.basic.product,
      },
      paths: session.probe.paths,
      tls: {
        organization: tlsOrganizationFromCertificate(session.probe.tls.certificate),
      },
      traffic: trafficEvidenceFromNetwork(session.controller.network()),
    }).primary,
    startedAt: session.startedAt,
    vendor: session.operatorObserved?.vendor || '',
    product: session.operatorObserved?.product || '',
    windowsOpen: snapshot.windowsOpen,
    paused: snapshot.paused,
    exported: session.exported,
    exportedAt: session.exportedAt,
    readiness: snapshot.readiness,
  };
}

function listJobSummaries() {
  return [...captureSessions.values()]
    .map(toJobSummary)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function missingSessionResult() {
  return {
    ok: false as const,
    error: formatCaptureError({
      code: 'EXPORT_FAILED',
      detail: '没有正在进行的采集作业。',
    }),
  };
}

async function refreshAuthenticatedProbe(session: CaptureSession) {
  try {
    const cookies = await session.controller.readSessionCookies();
    const cookieNames = cookies.map(cookie => cookie.name).filter(Boolean);
    if (cookieNames.length === 0) {
      if (!session.probe.authenticated) {
        session.probe = {
          ...session.probe,
          authenticated: {
            attempted: true,
            cookieNames: [],
            paths: {},
          },
        };
      }
      return;
    }
    const header = cookies
      .filter(cookie => cookie.name && cookie.value)
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    const authenticated = await probeBmcTarget({
      target: session.target,
      httpClient: createNodeProbeHttpClient(session.target, {
        extraHeaders: { Cookie: header },
      }),
    });
    session.probe = applyAuthenticatedProbe(session.probe, authenticated, cookieNames);
    logger.info('authenticated-probe', {
      jobId: session.jobId,
      cookieCount: cookieNames.length,
      family: session.probe.familySignatures.primary,
    });
  } catch (error) {
    // 捕获登录后复验失败：BMC 可能拒绝带会话的探测或网络中断
    // 策略：保留匿名 probe，不把 Cookie 值写入日志，不阻断导出
    logger.info('authenticated-probe-failed', { jobId: session.jobId });
    void error;
  }
}

function registerCaptureHandlers() {
  ipcMain.handle(
    'capture:start',
    async (
      _event,
      payload: CaptureTarget & {
        operatorNote?: string;
        operatorObserved?: Partial<OperatorObservedAsset> | null;
      },
    ) => {
    try {
      const limit = canAddCaptureJob(captureSessions.size);
      if (!limit.ok) {
        return {
          ok: false as const,
          error: formatCaptureError({
            code: 'UNKNOWN',
            detail: limit.message,
          }),
        };
      }
      const target: CaptureTarget = {
        host: String(payload.host || '').trim(),
        port: payload.port,
        scheme: payload.scheme,
      };
      const jobId = `job-${Date.now()}`;
      const startedAt = new Date().toISOString();
      const screenshotDir = join(app.getPath('userData'), 'captures', jobId, 'screenshots');
      const probe = await probeBmcTarget({ target });
      const controller = createCaptureBrowserController({
        jobId,
        target,
        adapter: createElectronCaptureBrowserAdapter({
          screenshotDir,
        }),
      });

      await controller.start();
      const operatorObserved = normalizeOperatorObserved({
        ...payload.operatorObserved,
        note: payload.operatorObserved?.note ?? payload.operatorNote,
      });
      logger.info('capture-start', {
        jobId,
        host: target.host,
        port: target.port,
        vendor: operatorObserved.vendor || undefined,
        product: operatorObserved.product || undefined,
      });
      const session: CaptureSession = {
        jobId,
        startedAt,
        target,
        probe,
        operatorNote: operatorObserved.note,
        operatorObserved,
        controller,
        exported: false,
      };
      captureSessions.set(jobId, session);

      return {
        ok: true as const,
        jobId,
        family: probe.familySignatures,
        timeline: controller.timeline(),
        network: controller.network(),
        snapshot: sessionSnapshot(session),
        jobs: listJobSummaries(),
      };
    } catch (error) {
      // 捕获采集启动失败：BMC 不可达、证书策略、权限不足或窗口创建失败
      // 策略：返回现场可读错误，避免主窗口白屏或抛出技术堆栈
      return {
        ok: false as const,
        error: formatCaptureError({
          code: classifyCaptureError(error),
          detail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  });

  ipcMain.handle('capture:export', async (event, jobId: string) => {
    const session = captureSessions.get(jobId);
    if (!session) {
      return {
        ok: false as const,
        error: formatCaptureError({
          code: 'EXPORT_FAILED',
          detail: '没有正在进行的采集作业。',
        }),
      };
    }

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    await refreshAuthenticatedProbe(session);
    const result = await exportCaptureJob({
      job: session,
      collectPageFacts: label => session.controller.collectPageFacts(label),
      getPage: () => session.controller.timeline(),
      getNetwork: () => session.controller.network(),
      getChromiumAccess: () => session.controller.chromiumAccess(),
      confirmExport: async summary => {
        logger.info('export-confirm', {
          jobId,
          readiness: summary.readiness,
          redactionStatus: summary.redactionStatus,
          redactedFields: summary.redactedFields,
        });
        const detail = [
          `脱敏：${summary.redactionStatus}，已脱敏字段 ${summary.redactedFields}`,
          ...summary.pendingActions.slice(0, 6),
        ].join('\n');
        const result = parentWindow
          ? await dialog.showMessageBox(parentWindow, {
              type: 'info',
              title: '确认导出 Capture Pack',
              message: `离场适配就绪：${summary.readiness}`,
              detail,
              buttons: ['取消', '选择保存位置'],
              defaultId: 1,
              cancelId: 0,
            })
          : await dialog.showMessageBox({
              type: 'info',
              title: '确认导出 Capture Pack',
              message: `离场适配就绪：${summary.readiness}`,
              detail,
              buttons: ['取消', '选择保存位置'],
              defaultId: 1,
              cancelId: 0,
            });
        return result.response === 1;
      },
      chooseSavePath: async fileName => {
        const options = {
          title: '导出 Capture Pack',
          defaultPath: join(app.getPath('downloads'), fileName),
          filters: [{ name: 'Capture Pack', extensions: ['zip'] }],
        };
        const result = parentWindow
          ? await dialog.showSaveDialog(parentWindow, options)
          : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      writeFile,
    });
    if (result.ok) {
      session.exported = true;
      session.exportedAt = new Date().toISOString();
      try {
        await session.controller.stop();
      } catch (error) {
        // 捕获导出后关窗失败：窗口可能已被用户手动关掉
        // 策略：导出已成功，忽略关窗错误，避免把成功结果改成失败
        void error;
      }
    }
    return {
      ...result,
      jobs: listJobSummaries(),
    };
  });

  ipcMain.handle('capture:stop', async (_event, jobId: string) => {
    const session = captureSessions.get(jobId);
    if (!session) {
      return {
        ok: false as const,
        error: formatCaptureError({
          code: 'EXPORT_FAILED',
          detail: '没有正在进行的采集作业。',
        }),
      };
    }

    try {
      await session.controller.ingestLiveEvents();
      await session.controller.stop();
      logger.info('capture-stop', { jobId });
      return {
        ok: true as const,
        ...sessionSnapshot(session),
        jobs: listJobSummaries(),
      };
    } catch (error) {
      // 捕获停止采集失败：窗口可能已关闭，作业数据仍应可导出
      // 策略：返回当前快照与可读错误，避免现场无法继续导出
      return {
        ok: false as const,
        error: formatCaptureError({
          code: classifyCaptureError(error),
          detail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  });

  ipcMain.handle('capture:snapshot', async (_event, jobId: string) => {
    const session = captureSessions.get(jobId);
    if (!session) {
      return {
        ok: false as const,
        error: formatCaptureError({
          code: 'EXPORT_FAILED',
          detail: '没有正在进行的采集作业。',
        }),
      };
    }

    await session.controller.ingestLiveEvents();
    return {
      ok: true as const,
      ...sessionSnapshot(session),
      jobs: listJobSummaries(),
    };
  });

  ipcMain.handle('capture:collectPage', async (_event, jobId: string, role = 'login') => {
    const session = captureSessions.get(jobId);
    if (!session) {
      return {
        ok: false as const,
        error: formatCaptureError({
          code: 'EXPORT_FAILED',
          detail: '没有正在进行的采集作业。',
        }),
      };
    }

    try {
      if (!session.controller.windowsOpen()) {
        return {
          ok: false as const,
          error: formatCaptureError({
            code: 'UNKNOWN',
            detail: '采集窗口已关闭，无法补采当前画面。可直接导出已采集资料。',
          }),
        };
      }
      const screenshotRole = typeof role === 'string' && role ? role : 'login';
      logger.info('collect-page', { jobId, role: screenshotRole });
      await session.controller.collectPageFacts(screenshotRole);
      return {
        ok: true as const,
        ...sessionSnapshot(session),
        jobs: listJobSummaries(),
      };
    } catch (error) {
      // 捕获页面补采失败：采集窗口可能已关闭或截图目录不可写
      // 策略：返回现场可读错误，保留当前作业，便于重试补采
      return {
        ok: false as const,
        error: formatCaptureError({
          code: classifyCaptureError(error),
          detail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  });

  ipcMain.handle('capture:listJobs', async () => {
    return {
      ok: true as const,
      jobs: listJobSummaries(),
    };
  });

  ipcMain.handle('capture:pause', async (_event, jobId: string) => {
    const session = captureSessions.get(jobId);
    if (!session) return missingSessionResult();
    session.controller.pause();
    logger.info('capture-pause', { jobId });
    return {
      ok: true as const,
      ...sessionSnapshot(session),
      jobs: listJobSummaries(),
    };
  });

  ipcMain.handle('capture:resume', async (_event, jobId: string) => {
    const session = captureSessions.get(jobId);
    if (!session) return missingSessionResult();
    session.controller.resume();
    logger.info('capture-resume', { jobId });
    return {
      ok: true as const,
      ...sessionSnapshot(session),
      jobs: listJobSummaries(),
    };
  });

  ipcMain.handle('capture:closeJob', async (_event, jobId: string) => {
    const session = captureSessions.get(jobId);
    if (!session) return missingSessionResult();
    try {
      await session.controller.stop();
    } catch (error) {
      // 捕获关闭作业时关窗失败：窗口可能已不存在
      // 策略：仍从内存列表移除作业，避免残留不可操作的条目
      void error;
    }
    captureSessions.delete(jobId);
    logger.info('capture-close-job', { jobId });
    return {
      ok: true as const,
      jobs: listJobSummaries(),
    };
  });

  ipcMain.handle('pack:choose', async event => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: '打开 Capture Pack',
      filters: [{ name: 'Capture Pack', extensions: ['zip'] }],
      properties: ['openFile' as const],
    };
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false as const, canceled: true as const };
    }
    return { ok: true as const, filePath: result.filePaths[0] };
  });

  ipcMain.handle('pack:summarize', async (_event, filePath: string) => {
    try {
      const bytes = await readFile(filePath);
      const summary = await summarizeCapturePackZip(bytes);
      return { ok: true as const, summary, filePath };
    } catch (error) {
      // 捕获打开资料包失败：路径无效、不是 zip 或 JSON 损坏
      // 策略：返回可读错误，不调用公网，不影响当前采集作业
      return {
        ok: false as const,
        error: formatCaptureError({
          code: classifyCaptureError(error),
          detail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  });

  ipcMain.handle('pack:compare', async (_event, leftPath: string, rightPath: string) => {
    try {
      const [leftBytes, rightBytes] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
      const left = await summarizeCapturePackZip(leftBytes);
      const right = await summarizeCapturePackZip(rightBytes);
      return {
        ok: true as const,
        comparison: compareCapturePacks(left, right),
        leftPath,
        rightPath,
      };
    } catch (error) {
      // 捕获对比资料包失败：其中一个 zip 无法读取或解析
      // 策略：返回可读错误，保留已打开的另一份摘要（由界面决定是否清空）
      return {
        ok: false as const,
        error: formatCaptureError({
          code: classifyCaptureError(error),
          detail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  });

  ipcMain.handle('capture:refreshProbe', async (_event, jobId: string) => {
    const session = captureSessions.get(jobId);
    if (!session) {
      return {
        ok: false as const,
        error: formatCaptureError({
          code: 'EXPORT_FAILED',
          detail: '没有正在进行的采集作业。',
        }),
      };
    }

    try {
      await refreshAuthenticatedProbe(session);
      return {
        ok: true as const,
        ...sessionSnapshot(session),
        jobs: listJobSummaries(),
      };
    } catch (error) {
      // 捕获登录后复验 IPC 失败：探测超时或目标拒绝
      // 策略：返回可读错误，保留当前作业和已采集网络事实
      return {
        ok: false as const,
        error: formatCaptureError({
          code: classifyCaptureError(error),
          detail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  });
}

function installApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: '查看',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: '采集窗口诊断',
          accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '采集窗口诊断',
              message: '采集窗口诊断（加载与证书日志）',
              detail:
                getCaptureWindowLogs() ||
                [
                  '当前进程还没有采集窗口日志，多半仍在用旧窗口。',
                  '请退出菜单栏里所有 Electron / KVM-Recon（含 /Applications 安装包），只保留 npm run dev 新弹出的窗口后再新建作业。',
                ].join('\n'),
            });
          },
        },
        {
          label: '主窗口开发者工具',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            const main = BrowserWindow.getAllWindows().find(
              window => !window.getTitle().startsWith('KVM-Recon Capture'),
            );
            const target = main || focused;
            target?.webContents.openDevTools({ mode: 'detach' });
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function isE2eSmokeLaunch() {
  return process.env.KVM_RECON_E2E === '1' || process.argv.includes('--e2e-smoke');
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'KVM-Recon',
    show: !isE2eSmokeLaunch(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    // 捕获预加载失败：安装包把 CJS preload 当成 ESM 加载，或签名后路径失效
    // 策略：打日志便于现场排查；界面会因缺少 window.kvmRecon 给出可读提示
    logger.info('preload-error', {
      preloadPath,
      message: error instanceof Error ? error.message : String(error),
    });
    console.error('preload-error', preloadPath, error);
  });

  if (isE2eSmokeLaunch()) {
    mainWindow.webContents.once('did-finish-load', () => {
      app.quit();
    });
    mainWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      // 捕获烟测加载失败：构建产物缺失或 renderer 路径错误
      // 策略：以非零退出让 CI 失败，避免误报启动成功
      console.error(`e2e smoke load failed: ${errorCode} ${errorDescription}`);
      app.exit(1);
    });
  }

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  app.on('certificate-error', (event, webContents, url, error, _certificate, callback) => {
    if (isCaptureSession(webContents.session)) {
      event.preventDefault();
      callback(true);
      recordCaptureWindowLog(`app-cert-trusted ${error} ${url}`);
      return;
    }
    callback(false);
  });
  if (!isE2eSmokeLaunch()) {
    installApplicationMenu();
  }
  registerCaptureHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isE2eSmokeLaunch()) {
    app.quit();
  }
});
