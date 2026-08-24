import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CaptureTarget } from '../core/capture-pack/types';
import { exportCaptureJob, type CaptureExportJob } from '../core/delivery/exportCaptureJob';
import {
  classifyCaptureError,
  formatCaptureError,
} from '../core/delivery/formatCaptureError';
import { probeBmcTarget } from '../core/probe/probeBmcTarget';
import { createCaptureBrowserController } from './capture/createCaptureBrowserController';
import { createElectronCaptureBrowserAdapter } from './capture/createElectronCaptureBrowserAdapter';

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
