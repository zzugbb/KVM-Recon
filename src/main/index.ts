/**
 * KVM-Recon 主进程入口（0.3.0 阶段 2：生产 Controller + 单作业模型）。
 *
 * IPC 面只保留单作业生命周期：start / status / stop / export / discard
 * （+ 恢复作业手动导出 exportRecovered）。
 * 启动时先恢复上一个未完成作业（recoverCrashedJob，规范 §4.2：
 * 应用异常退出后只恢复这一份；恢复止步于 finalize，不自动导出——
 * 由用户在恢复卡上手动选择目录导出；拒绝恢复时现场资料保留）。
 * 0.2.x 的多作业 / 暂停 / 手动截图 / 打开对比包 / 离场复验 IPC 已删除。
 */

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { APP_VERSION, BUILD_ID } from '../version';
import type { JobWorkspace } from '../core/job-workspace/createJobWorkspace';
import { exportRecoveredJob, recoverCrashedJob } from '../core/export/recoverCrashedJob';
import {
  createProductionCapture,
  type ProductionCaptureController,
  type ProductionCaptureExportResult,
  type ProductionCaptureTarget,
} from './capture/productionCaptureController';
import { getCaptureWindowLogs, isCaptureSession, recordCaptureWindowLog } from './capture/captureWindowDiagnostics';
import {
  isE2eCaptureControllerLaunch,
  runProductionCaptureE2e,
} from './capture/runProductionCaptureE2e';
import { runFieldHarReplayE2e } from './capture/runFieldHarReplayE2e';

// 必须在 app ready 之前：现场 BMC 自签证书在 Chrome 要点「高级」，采集窗没有该页面，不忽略就会白屏。
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-running-insecure-content');

function workspacesRootDir() {
  return join(app.getPath('userData'), 'workspaces');
}

/**
 * 解析现场输入的 BMC 地址（规范 §4.1：支持 IP、主机名及带 scheme/port 的地址）。
 * 解析失败返回 null（不猜）；缺省 scheme 为 https、缺省端口 443。
 */
export function parseTargetInput(input: string): ProductionCaptureTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') return null;
  const host = url.hostname;
  if (!host) return null;
  const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port, scheme: scheme as 'http' | 'https', originalInput: trimmed };
}

interface CaptureStatusJob {
  jobId: string;
  /** capturing = 采集窗口工作中；stopped = 已收尾可导出；exported = 已导出。 */
  state: 'capturing' | 'stopped' | 'exported';
  /** 采集会话从观察事实派生的工作流状态（采集中实时派生；收尾后为终态值）。 */
  workflowStatus: 'TARGET_OPENED' | 'LOGIN_REACHED' | 'KVM_REACHED';
  windowsOpen: boolean;
  storageLimited: boolean;
  windowsLabel: string;
  diagnostics: {
    droppedEvents: number;
    droppedEventByMethod: Record<string, number>;
    gapCounts: Record<string, number>;
    storageLimitReached: boolean;
  };
}

interface CaptureStatusPayload {
  ok: true;
  job: CaptureStatusJob | null;
  export: (ProductionCaptureExportResult & { zipPath: string }) | null;
  /** 上次启动的崩溃恢复结果（null = 没有可恢复的作业）。 */
  recovery: RecoveryNotice | null;
}

interface RecoveryNotice {
  kind: 'recovered' | 'exported' | 'refused' | 'failed';
  jobId?: string;
  zipPath?: string;
  reason?: string;
  error?: string;
  conservative?: boolean;
  /** 待导出恢复作业的信息（kind=recovered）：恢复只接管不导出，导出由用户手动触发。 */
  workflowStatus?: string;
  targetUrl?: string;
  deviceLabel?: string;
  /** 本次导出的实际完整度（kind=exported）：照实显示，不得硬编码 INCOMPLETE。 */
  captureIntegrity?: string;
}

/** 启动恢复接管、等待用户手动导出的作业（finalized-unexported，导出成功才 markExported）。 */
interface RecoveredPendingJob {
  workspace: JobWorkspace;
  jobId: string;
  conservative: boolean;
}

let activeController: ProductionCaptureController | null = null;
let lastExport: (ProductionCaptureExportResult & { zipPath: string }) | null = null;
let recoveryNotice: RecoveryNotice | null = null;
let recoveredPending: RecoveredPendingJob | null = null;
// exportRecovered 进行中标志：ipcMain.handle 不串行化，并发 invoke 会绕过
// recoveredPending 检查写出两份 ZIP / 双重 markExported——同步置位挡重入
let exportRecoveredInFlight = false;

function statusJob(): CaptureStatusJob | null {
  if (!activeController) return null;
  const stopped = activeController.session.workspace.state !== 'active';
  return {
    jobId: activeController.session.workspace.jobId,
    state: lastExport ? 'exported' : stopped ? 'stopped' : 'capturing',
    workflowStatus: activeController.session.integrityEvidence().workflowStatus,
    windowsOpen: activeController.windowsOpen(),
    storageLimited: activeController.session.workspace.storageLimited,
    windowsLabel: activeController.session.workspace.deviceLabel ?? '',
    diagnostics: activeController.session.evidence().diagnostics() as CaptureStatusJob['diagnostics'],
  };
}

function statusPayload(): CaptureStatusPayload {
  return {
    ok: true,
    job: statusJob(),
    export: lastExport,
    recovery: recoveryNotice,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function registerCaptureHandlers() {
  ipcMain.handle(
    'capture:start',
    async (_event, payload: { target: string; deviceLabel?: string }) => {
      try {
        if (activeController) {
          return {
            ok: false as const,
            error: '已有进行中的采集作业（单作业模型）。先停止并导出，或丢弃已导出的作业。',
          };
        }
        if (recoveredPending) {
          return {
            ok: false as const,
            error: `上次恢复的作业 ${recoveredPending.jobId} 尚未导出。请先在恢复卡上导出，导出完成前不能开始新的采集作业。`,
          };
        }
        const target = parseTargetInput(String(payload?.target ?? ''));
        if (!target) {
          return { ok: false as const, error: 'BMC 地址无效：支持 IP、主机名或带 scheme/port 的地址。' };
        }
        const controller = await createProductionCapture({
          // 随机后缀防同毫秒碰撞（单作业模型下双击重试的理论场景）
          jobId: `job-${Date.now()}-${randomUUID().slice(0, 8)}`,
          workspacesRootDir: workspacesRootDir(),
          target,
          deviceLabel: payload?.deviceLabel?.trim() || undefined,
          tool: { version: APP_VERSION, buildId: BUILD_ID },
        });
        await controller.start();
        activeController = controller;
        return { ok: true as const, jobId: controller.session.workspace.jobId, target };
      } catch (error) {
        return { ok: false as const, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle('capture:status', () => statusPayload());

  ipcMain.handle('capture:stop', async () => {
    if (!activeController) {
      return { ok: false as const, error: '没有进行中的采集作业。' };
    }
    try {
      await activeController.stop();
      return statusPayload();
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
    }
  });

  ipcMain.handle('capture:export', async (event, payload?: { zipDir?: string }) => {
    if (!activeController) {
      return { ok: false as const, error: '没有进行中的采集作业。' };
    }
    try {
      // 导出前先收尾（窗口保留：收尾快照需要活页面；导出成功后再关）
      await activeController.stop();
      let zipDir = typeof payload?.zipDir === 'string' && payload.zipDir ? payload.zipDir : null;
      if (!zipDir) {
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title: '选择保存位置',
          defaultPath: app.getPath('downloads'),
          properties: ['openDirectory' as const, 'createDirectory' as const],
        };
        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths[0]) {
          return { ok: false as const, error: '已取消导出（作业与采集窗口保留，可重新导出）。' };
        }
        zipDir = result.filePaths[0];
      }
      const result = await activeController.exportPack(zipDir);
      lastExport = result;
      await activeController.closeWindows();
      return { ...statusPayload(), zipPath: result.zipPath, fileName: result.fileName };
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
    }
  });

  ipcMain.handle('capture:exportRecovered', async (event, payload?: { zipDir?: string }) => {
    if (!recoveredPending) {
      return { ok: false as const, error: '没有待导出的恢复作业。' };
    }
    if (exportRecoveredInFlight) {
      return { ok: false as const, error: '恢复作业导出进行中，请等待本次导出完成。' };
    }
    exportRecoveredInFlight = true;
    try {
      let zipDir = typeof payload?.zipDir === 'string' && payload.zipDir ? payload.zipDir : null;
      if (!zipDir) {
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title: '选择恢复作业保存位置',
          defaultPath: app.getPath('downloads'),
          properties: ['openDirectory' as const, 'createDirectory' as const],
        };
        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths[0]) {
          return { ok: false as const, error: '已取消导出（恢复作业保留，可重新导出）。' };
        }
        zipDir = result.filePaths[0];
      }
      const pending = recoveredPending;
      const result = await exportRecoveredJob({
        workspace: pending.workspace,
        zipDir,
        tool: { version: APP_VERSION, buildId: BUILD_ID },
      });
      if (!result.ok) {
        // 导出失败不 markExported：待导出状态保留，可重试
        return { ok: false as const, error: result.error };
      }
      // lastExport 只描述当前作业（activeController）的导出；恢复作业不属于
      // 任何当前作业，置位会让下一个新作业从首轮 status 起就报 'exported'
      // （canStop/canExport 全关，UI 无法停止/导出/丢弃）。恢复导出的事实
      // 由 recoveryNotice（kind=exported，含 zipPath/完整度）独自承载。
      // 先翻待导出状态再 close：close 抛错（互斥超时等）不得让已导出的
      // 作业退回待导出——那会诱导用户重试导出写出第二份 ZIP。
      recoveredPending = null;
      recoveryNotice = {
        kind: 'exported',
        jobId: pending.jobId,
        zipPath: result.zipPath,
        conservative: pending.conservative,
        captureIntegrity: result.status.captureIntegrity,
      };
      try {
        await pending.workspace.close();
      } catch (error) {
        // 句柄由进程退出兜底释放；导出事实已持久化（markExported 在 close 前）
        recordCaptureWindowLog(`recovered-export-close-failed ${errorMessage(error)}`);
      }
      return { ...statusPayload(), zipPath: result.zipPath, fileName: result.fileName };
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
    } finally {
      exportRecoveredInFlight = false;
    }
  });

  ipcMain.handle('capture:discard', async () => {
    if (!activeController) {
      return { ok: false as const, error: '没有进行中的采集作业。' };
    }
    try {
      if (!activeController.session.workspace.exported) {
        return {
          ok: false as const,
          error: '作业尚未导出，不能丢弃（未导出的现场资料必须保留）。先导出再丢弃。',
        };
      }
      await activeController.closeWindows();
      await activeController.session.workspace.cleanup();
      activeController = null;
      lastExport = null;
      return statusPayload();
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
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

/**
 * 启动时崩溃恢复（规范 §4.2；第 12 轮：只提示不自动写 ZIP）。
 * 恢复止步于 finalize：finalized-unexported 挂起为待导出，由用户在
 * 恢复卡上手动选择目录导出（capture:exportRecovered）。
 */
async function recoverPreviousJob() {
  const result = await recoverCrashedJob({
    rootDir: workspacesRootDir(),
    tool: { version: APP_VERSION, buildId: BUILD_ID },
    resetStaleOwner: true,
  });
  if (result.kind === 'no-workspace') return;
  if (result.kind === 'recovered') {
    recoveredPending = {
      workspace: result.workspace,
      jobId: result.jobId,
      conservative: result.conservative,
    };
    recoveryNotice = {
      kind: 'recovered',
      jobId: result.jobId,
      conservative: result.conservative,
      workflowStatus: result.workflowStatus,
      targetUrl: result.targetUrl,
      deviceLabel: result.deviceLabel,
    };
    return;
  }
  if (result.kind === 'refused') {
    recoveryNotice = { kind: 'refused', jobId: result.jobId, reason: result.reason };
    return;
  }
  recoveryNotice = { kind: 'failed', jobId: result.jobId, error: result.error };
}

// 采集中的正常退出也要收尾：把真实证据摘要写进 capture-facts，
// 下次启动的恢复就能用真实摘要而不是保守摘要。
// 待导出的恢复作业只需释放句柄（finalized-unexported 现场保留，
// 下次启动幂等再恢复提示，resetStaleOwner 已覆盖属主未释放的情况）。
app.on('before-quit', event => {
  if (recoveredPending) {
    const pending = recoveredPending;
    recoveredPending = null;
    void pending.workspace.close().catch(() => undefined);
  }
  if (!activeController || activeController.session.workspace.state !== 'active') return;
  event.preventDefault();
  void (async () => {
    try {
      await activeController.stop();
    } catch (error) {
      recordCaptureWindowLog(`capture-quit-stop-failed ${errorMessage(error)}`);
    }
    app.quit();
  })();
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.whenReady().then(async () => {
  if (isE2eCaptureControllerLaunch()) {
    const fieldHar = process.env.KVM_RECON_E2E_FIELD_HAR;
    try {
      if (fieldHar) {
        await runFieldHarReplayE2e(fieldHar);
      } else {
        await runProductionCaptureE2e();
      }
    } catch (error) {
      // E2E 未处理异常也必须立刻退出 1，否则进程悬死到外层超时
      console.error('采集 E2E 未处理异常：', error);
      app.exit(1);
    }
    return;
  }
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
  try {
    await recoverPreviousJob();
  } catch (error) {
    // 捕获启动恢复失败（未知状态目录等）：保留现场，不阻断应用启动
    recoveryNotice = { kind: 'failed', error: errorMessage(error) };
  }
  registerCaptureHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows().find(candidate => candidate.getTitle() === 'KVM-Recon');
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on('window-all-closed', () => {
  if (isE2eCaptureControllerLaunch()) {
    // 采集 E2E 的退出码只能由 runProductionCaptureE2e() 的 app.exit(0/1) 决定。
    // 关窗后若在这里 app.quit()，默认退出码为 0，外层会把尚未跑完的断言当成成功。
    return;
  }
  if (process.platform !== 'darwin' || isE2eSmokeLaunch()) {
    app.quit();
  }
});
