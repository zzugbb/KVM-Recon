import { contextBridge, ipcRenderer } from 'electron';

interface StartCaptureTarget {
  host: string;
  port: number;
  scheme: 'http' | 'https';
  operatorNote?: string;
}

contextBridge.exposeInMainWorld('kvmRecon', {
  appName: 'KVM-Recon',
  startCapture(target: StartCaptureTarget) {
    return ipcRenderer.invoke('capture:start', target);
  },
  exportCapture(jobId: string) {
    return ipcRenderer.invoke('capture:export', jobId);
  },
});
