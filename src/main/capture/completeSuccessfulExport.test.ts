import { describe, expect, it, vi } from 'vitest';

import { completeSuccessfulExport } from './completeSuccessfulExport';

describe('导出成功后的状态返回', () => {
  const artifact = { zipPath: '/tmp/capture.zip', fileName: 'capture.zip' };

  it('窗口关闭与状态读取都失败，仍返回成功和已写入 ZIP 的路径', async () => {
    const onPostExportError = vi.fn();
    const result = await completeSuccessfulExport({
      artifact,
      closeWindows: async () => { throw new Error('window close failed'); },
      status: async () => { throw new Error('status failed'); },
      fallbackStatus: () => ({ ok: true as const, job: null, export: artifact }),
      onPostExportError,
    });

    expect(result).toMatchObject({ ok: true, zipPath: artifact.zipPath, fileName: artifact.fileName });
    expect(result.postExportWarnings).toHaveLength(2);
    expect(onPostExportError.mock.calls.map(call => call[0])).toEqual(['close-windows', 'status']);
  });

  it('没有后续异常时保留正常状态且不添警告', async () => {
    const result = await completeSuccessfulExport({
      artifact,
      status: async () => ({ ok: true as const, job: { state: 'exported' } }),
      fallbackStatus: () => ({ ok: true as const, job: { state: 'exported' } }),
    });
    expect(result.job).toEqual({ state: 'exported' });
    expect(result.postExportWarnings).toBeUndefined();
  });
});
