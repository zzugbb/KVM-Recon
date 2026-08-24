import { contextBridge, ipcRenderer } from 'electron';

interface StartCaptureTarget {
  host: string;
  port: number;
  scheme: 'http' | 'https';
}

contextBridge.exposeInMainWorld('kvmRecon', {
  appName: 'KVM-Recon',
  startCapture(target: StartCaptureTarget) {
    return ipcRenderer.invoke('capture:start', target);
  },
});
