import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';

import type { CaptureTarget } from '../core/capture-pack/types';
import { createCaptureBrowserController } from './capture/createCaptureBrowserController';
import { createElectronCaptureBrowserAdapter } from './capture/createElectronCaptureBrowserAdapter';

const captureControllers = new Map<string, ReturnType<typeof createCaptureBrowserController>>();

function registerCaptureHandlers() {
  ipcMain.handle('capture:start', async (_event, target: CaptureTarget) => {
    const jobId = `job-${Date.now()}`;
    const screenshotDir = join(app.getPath('userData'), 'captures', jobId, 'screenshots');
    const controller = createCaptureBrowserController({
      jobId,
      target,
      adapter: createElectronCaptureBrowserAdapter({
        screenshotDir,
      }),
    });

    await controller.start();
    captureControllers.set(jobId, controller);

    return {
      jobId,
      timeline: controller.timeline(),
    };
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
