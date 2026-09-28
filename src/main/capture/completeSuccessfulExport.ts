/** ZIP 已写入、校验并标记导出后，收尾 UI 操作不得把成功结果改报为失败。 */
export async function completeSuccessfulExport<TStatus extends { ok: true }>(input: {
  artifact: { zipPath: string; fileName: string };
  closeWindows?: () => Promise<void>;
  status: () => Promise<TStatus>;
  fallbackStatus: () => TStatus;
  onPostExportError?: (step: 'close-windows' | 'status', error: unknown) => void;
}): Promise<TStatus & {
  zipPath: string;
  fileName: string;
  postExportWarnings?: string[];
}> {
  const warnings: string[] = [];
  const report = (step: 'close-windows' | 'status', error: unknown) => {
    try {
      input.onPostExportError?.(step, error);
    } catch {
      // 诊断记录也不能推翻已完成的 ZIP 导出。
    }
  };
  if (input.closeWindows) {
    try {
      await input.closeWindows();
    } catch (error) {
      report('close-windows', error);
      warnings.push('采集窗口未能自动关闭，请手动关闭。');
    }
  }
  let status: TStatus;
  try {
    status = await input.status();
  } catch (error) {
    report('status', error);
    warnings.push('状态暂不可用；导出文件已写入并校验。');
    status = input.fallbackStatus();
  }
  return {
    ...status,
    zipPath: input.artifact.zipPath,
    fileName: input.artifact.fileName,
    ...(warnings.length ? { postExportWarnings: warnings } : {}),
  };
}
