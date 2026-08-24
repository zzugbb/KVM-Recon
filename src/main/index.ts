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
        host: payload.host,
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
      logger.info('capture-start', { jobId, host: target.host, port: target.port });
      captureSessions.set(jobId, {
        jobId,
        startedAt,
        target,
        probe,
        operatorNote: payload.operatorNote,
        controller,
      });

      return {
        ok: true as const,
        jobId,
        family: probe.familySignatures,
        timeline: controller.timeline(),
        network: controller.network(),
        snapshot: buildLiveCaptureSnapshot({
          probe,
          page: controller.timeline(),
          network: controller.network(),
        }),
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
    return exportCaptureJob({
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

    return {
      ok: true as const,
      ...buildLiveCaptureSnapshot({
        probe: session.probe,
        page: session.controller.timeline(),
        network: session.controller.network(),
      }),
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
      const screenshotRole = typeof role === 'string' && role ? role : 'live';
      logger.info('collect-page', { jobId, role: screenshotRole });
      await session.controller.collectPageFacts(screenshotRole);
      return {
        ok: true as const,
        ...buildLiveCaptureSnapshot({
          probe: session.probe,
          page: session.controller.timeline(),
          network: session.controller.network(),
        }),
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
