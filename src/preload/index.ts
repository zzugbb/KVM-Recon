import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('kvmRecon', {
  appName: 'KVM-Recon',
});
