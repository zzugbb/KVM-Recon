import { contextBridge, ipcRenderer } from 'electron';

import { APP_VERSION } from '../version';

interface StartCaptureTarget {
  host: string;
  port: number;
  scheme: 'http' | 'https';
  operatorNote?: string;
  operatorObserved?: {
    vendor?: string;
    product?: string;
    firmware?: string;
    location?: string;
    note?: string;
  };
}

contextBridge.exposeInMainWorld('kvmRecon', {
  appName: 'KVM-Recon',
  appVersion: APP_VERSION,
  startCapture(target: StartCaptureTarget) {
    return ipcRenderer.invoke('capture:start', target);
  },
  exportCapture(jobId: string) {
    return ipcRenderer.invoke('capture:export', jobId);
  },
  getCaptureSnapshot(jobId: string) {
    return ipcRenderer.invoke('capture:snapshot', jobId);
  },
  collectCapturePage(jobId: string, role?: string) {
    return ipcRenderer.invoke('capture:collectPage', jobId, role);
  },
  stopCapture(jobId: string) {
    return ipcRenderer.invoke('capture:stop', jobId);
  },
  refreshCaptureProbe(jobId: string) {
    return ipcRenderer.invoke('capture:refreshProbe', jobId);
  },
  listCaptureJobs() {
    return ipcRenderer.invoke('capture:listJobs');
  },
  pauseCapture(jobId: string) {
    return ipcRenderer.invoke('capture:pause', jobId);
  },
  resumeCapture(jobId: string) {
    return ipcRenderer.invoke('capture:resume', jobId);
  },
  closeCaptureJob(jobId: string) {
    return ipcRenderer.invoke('capture:closeJob', jobId);
  },
  chooseCapturePack() {
    return ipcRenderer.invoke('pack:choose');
  },
  summarizeCapturePack(filePath: string) {
    return ipcRenderer.invoke('pack:summarize', filePath);
  },
  compareCapturePacks(leftPath: string, rightPath: string) {
    return ipcRenderer.invoke('pack:compare', leftPath, rightPath);
  },
});
