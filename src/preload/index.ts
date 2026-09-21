import { contextBridge, ipcRenderer } from 'electron';

import { APP_VERSION } from '../version';

/**
 * 单作业模型 IPC 面（规范 §4.2，阶段 2）：
 * start（地址 + 设备说明）/ status / stop / export / discard。
 * 0.2.x 的多作业、暂停、手动截图、离场复验、打开/对比包已删除。
 */
contextBridge.exposeInMainWorld('kvmRecon', {
  appName: 'KVM-Recon',
  appVersion: APP_VERSION,
  startCapture(target: string, deviceLabel?: string) {
    return ipcRenderer.invoke('capture:start', { target, deviceLabel });
  },
  getCaptureStatus() {
    return ipcRenderer.invoke('capture:status');
  },
  stopCapture() {
    return ipcRenderer.invoke('capture:stop');
  },
  exportCapture(zipDir?: string) {
    return ipcRenderer.invoke('capture:export', zipDir ? { zipDir } : undefined);
  },
  discardCapture() {
    return ipcRenderer.invoke('capture:discard');
  },
});
