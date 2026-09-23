/**
 * E2E 内读取 ZIP 全部条目（页面很小，内存断言可接受；生产链路不走这里）。
 *
 * 纯 Node 模块（不依赖 Electron）：回放 e2e 的 Node 进程与 Electron 主进程
 * 的 E2E 都能打包复用。readZipEntries 返回 utf8 文本（JSON / JSONL 断言用），
 * 二进制正文（如 crypto 输出原始字节）用 readZipEntryBuffers 逐字节读取。
 */

import yauzl from 'yauzl';

/** ZIP 全部条目的原始字节（二进制安全；utf8 解码有损时使用）。 */
export async function readZipEntryBuffers(zipPath: string): Promise<Map<string, Buffer>> {
  const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, decodeStrings: true });
  const entries = new Map<string, Buffer>();
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    zipfile.readEntry();
    zipfile.on('entry', (entry: yauzl.Entry) => {
      zipfile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error(`打开条目失败：${entry.fileName}`));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('end', () => {
          entries.set(entry.fileName, Buffer.concat(chunks));
          zipfile.readEntry();
        });
      });
    });
    zipfile.on('end', () => resolve(entries));
    zipfile.on('error', reject);
  });
}

/** ZIP 全部条目的 utf8 文本（JSON / JSONL 断言用；二进制条目有损）。 */
export async function readZipEntries(zipPath: string): Promise<Map<string, string>> {
  const buffers = await readZipEntryBuffers(zipPath);
  const entries = new Map<string, string>();
  for (const [name, buffer] of buffers) entries.set(name, buffer.toString('utf8'));
  return entries;
}
