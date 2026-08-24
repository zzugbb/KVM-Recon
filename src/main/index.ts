import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CaptureTarget } from '../core/capture-pack/types';
import { exportCaptureJob, type CaptureExportJob } from '../core/delivery/exportCaptureJob';
import {
  classifyCaptureError,
  formatCaptureError,
} from '../core/delivery/formatCaptureError';
import { buildLiveCaptureSnapshot } from '../core/delivery/buildLiveCaptureSnapshot';
import { createCaptureLogger } from '../core/log/createCaptureLogger';
import { probeBmcTarget } from '../core/probe/probeBmcTarget';
import { createCaptureBrowserController } from './capture/createCaptureBrowserController';
import { createElectronCaptureBrowserAdapter } from './capture/createElectronCaptureBrowserAdapter';

const logger = createCaptureLogger();

interface CaptureSession extends CaptureExportJob {
  controller: ReturnType<typeof createCaptureBrowserController>;
}

const captureSessions = new Map<string, CaptureSession>();

async function stopExistingCaptureSessions() {
  const previous = [...captureSessions.values()];
  for (const session of previous) {
    try {
      await session.controller.stop();
    } catch (error) {
      // 捕获上一作业关窗失败：用户可能已手动关闭采集窗口
      // 策略：仍替换作业，避免新采集被旧窗口占用
      void error;
    }
  }
}

function sessionSnapshot(session: CaptureSession) {
  return {
    windowsOpen: session.controller.windowsOpen(),
    ...buildLiveCaptureSnapshot({
      probe: session.probe,
      page: session.controller.timeline(),
      network: session.controller.network(),
    }),
  };
}

function registerCaptureHandlers() {
  ipcMain.handle(
    'capture:start',
    async (
      _event,
      payload: CaptureTarget & {
        operatorNote?: string;
      },
    ) => {
    try {
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
      await stopExistingCaptureSessions();
      captureSessions.clear();
      logger.info('capture-start', { jobId, host: target.host, port: target.port });
      const session: CaptureSession = {
        jobId,
        startedAt,
        target,
        probe,
        operatorNote: payload.operatorNote,
        controller,
      };
      captureSessions.set(jobId, session);

      return {
        ok: true as const,
        jobId,
        family: probe.familySignatures,
        timeline: controller.timeline(),
        network: controller.network(),
        snapshot: sessionSnapshot(session),
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
      try {
        await session.controller.stop();
      } catch (error) {
        // 捕获导出后关窗失败：窗口可能已被用户手动关掉
        // 策略：导出已成功，忽略关窗错误，避免把成功结果改成失败
        void error;
      }
    }
    return result;
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
    };
  });

  ipcMain.handle('capture:collectPage', async (_event, jobId: string, role = 'live') => {
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
            detail: '采集窗口已关闭，无法补采当前页面。可直接导出已采集资料。',
          }),
        };
      }
      const screenshotRole = typeof role === 'string' && role ? role : 'live';
      logger.info('collect-page', { jobId, role: screenshotRole });
      await session.controller.collectPageFacts(screenshotRole);
      return {
        ok: true as const,
        ...sessionSnapshot(session),
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
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: 'KVM-Recon',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  registerCaptureHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
