/**
 * Controller 诊断记录器写失败语义（规范 §3「缺失必须显式」）。
 * 反例：诊断行 appendJsonl 抛错（模拟非 ENOSPC 磁盘故障）时若异常
 * 逃逸会中断采集诊断——必须走 droppedEvent 计账，stderr 镜像不受影响，
 * 后续诊断照常记录。
 */

import { describe, expect, it } from 'vitest';

import { createDiagnosticRecorder } from './controllerDiagnosticRecorder';

function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('Controller 诊断记录器', () => {
  it('诊断行写入失败：droppedEvent 计账、镜像保留、后续诊断不受影响', async () => {
    const mirrored: string[] = [];
    const dropped: string[] = [];
    const record = createDiagnosticRecorder({
      appendDiagnosticRow: async () => {
        throw new Error('磁盘写入失败（模拟）');
      },
      droppedEvent: method => {
        dropped.push(method);
      },
      mirrorLog: line => {
        mirrored.push(line);
      },
    });

    expect(() => record('window-created', 'host=10.10.8.111 partition=kvm-recon-capture-job-1')).not.toThrow();
    // 镜像同步完成，写失败不阻断
    expect(mirrored).toEqual(['capture-window-created host=10.10.8.111 partition=kvm-recon-capture-job-1']);
    await settle();
    expect(dropped).toEqual(['controller-diagnostic']);

    // 第二条诊断仍照常镜像并计账（单次写失败不中断采集诊断）
    record('renderer-gone', 'reason=clean-exit exit=0');
    await settle();
    expect(mirrored).toHaveLength(2);
    expect(dropped).toEqual(['controller-diagnostic', 'controller-diagnostic']);
  });

  it('诊断行写入成功：行追加进包，无 droppedEvent', async () => {
    const appended: object[] = [];
    const record = createDiagnosticRecorder({
      appendDiagnosticRow: async row => {
        appended.push(row);
      },
      droppedEvent: () => {
        throw new Error('成功路径不得记 droppedEvent');
      },
      mirrorLog: () => {},
    });
    record('cert-trusted', 'ERR_CERT_AUTHORITY_INVALID https://10.10.8.111/');
    await settle();
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ kind: 'cert-trusted' });
  });
});
