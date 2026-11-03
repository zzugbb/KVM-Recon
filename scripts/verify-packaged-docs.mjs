import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

// 检查实际 ASAR，而不是只核对源码：打包白名单可能漏掉文档链接的目标。
async function archivesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await archivesUnder(file));
    else if (entry.isFile() && entry.name === 'app.asar') found.push(file);
  }
  return found;
}

export function findMissingDocumentationLinks(entries, readMarkdown) {
  // 链接比较用 POSIX 路径，读取 ASAR 时保留宿主分隔符（asar 按 path.sep 遍历目录）。
  const files = new Map(entries.map(file => [file.replaceAll('\\', '/'), file.slice(1)]));
  const missing = [];
  for (const [file, archivePath] of files) {
    if (!file.endsWith('.md') || file.includes('/node_modules/')) continue;
    const markdown = readMarkdown(archivePath);
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      const resolved = path.posix.resolve(path.posix.dirname(file), decodeURIComponent(target));
      if (!files.has(resolved)) missing.push(`${file} -> ${target}`);
    }
  }
  return missing;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const archives = await archivesUnder(process.argv[2] || 'release');
  if (!archives.length) throw new Error('未找到 app.asar；请先构建安装包');
  for (const archive of archives) {
    const missing = findMissingDocumentationLinks(
      listPackage(archive),
      file => extractFile(archive, file).toString('utf8'),
    );
    if (missing.length) throw new Error(`${archive} 文档缺失：\n${missing.join('\n')}`);
    console.log(`Packaged documentation links verified: ${archive}`);
  }
}
