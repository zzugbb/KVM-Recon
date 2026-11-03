import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';
import { afterEach, expect, it } from 'vitest';
import { findMissingDocumentationLinks } from './verify-packaged-docs.mjs';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('./verify-packaged-docs.mjs', import.meta.url));
const temporaryDirs = [];
async function temporaryDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kvm-packaged-docs-'));
  temporaryDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it.each(['/', '\\'])('识别 %s 分隔的 ASAR 路径并排除依赖文档', separator => {
  const markdown = new Map([
    ['README.md', '[指南](docs/nested/guide.md#usage)'],
    [`docs${separator}nested${separator}guide.md`, '[首页](../../README.md) [有空格](../../assets/a%20b.png) [外链](https://example.com) [锚点](#usage)'],
  ]);
  const entries = ['/README.md', '/docs/nested/guide.md', '/assets/a b.png', '/node_modules/pkg/README.md']
    .map(file => file.replaceAll('/', separator));
  const read = [];
  expect(findMissingDocumentationLinks(entries, file => {
    read.push(file);
    return markdown.get(file);
  })).toEqual([]);
  expect(read).toEqual(['README.md', `docs${separator}nested${separator}guide.md`]);
});

it('Windows 路径中的真实缺失仍阻止通过', () => {
  expect(findMissingDocumentationLinks(['\\docs\\guide.md'], () => '[安全](../SECURITY.md)'))
    .toEqual(['/docs/guide.md -> ../SECURITY.md']);
});

it('命令行检查真实 ASAR，缺少随包文档时失败', async () => {
  const root = await temporaryDir();
  const source = path.join(root, 'source');
  const output = path.join(root, 'release', 'app with spaces', 'resources');
  await mkdir(source, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(source, 'README.md'), '[安全](SECURITY.md)');
  const archive = path.join(output, 'app.asar');
  await createPackage(source, archive);
  await expect(execFileAsync(process.execPath, [script, path.join(root, 'release')]))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('/README.md -> SECURITY.md') });
  await writeFile(path.join(source, 'SECURITY.md'), '# 安全');
  await createPackage(source, archive);
  const result = await execFileAsync(process.execPath, [script, path.join(root, 'release')]);
  expect(result.stdout).toContain(`Packaged documentation links verified: ${archive}`);
});

it('未生成应用包时不能空跑通过', async () => {
  await expect(execFileAsync(process.execPath, [script, await temporaryDir()]))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('未找到 app.asar') });
});
