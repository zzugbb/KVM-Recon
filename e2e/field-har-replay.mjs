import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 现场 HAR 回放 E2E 启动器：用 0.2.x 时代的真实现场语料（HAR）回放给
 * 0.3.0 新链路采集，断言新包是旧语料的超集（大正文无上限、登录口令不脱敏）。
 *
 * 语料目录由 KVM_RECON_FIELD_COLLECTION_2 指定（仓库外，只读）；缺失时跳过
 * （exit 0 + skipped 标记），没有现场数据的环境不阻塞其余 E2E。
 */

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const corpusDir = process.env.KVM_RECON_FIELD_COLLECTION_2 || '';
const replayAll = process.env.KVM_RECON_FIELD_HAR_ALL === '1';
// 代表语料：8.86/8.101 = >24 资源 + >1 MiB 大正文反例；8.77 = 真实登录口令（不脱敏断言）
const REPRESENTATIVE_HARS = ['10.10.8.86.har', '10.10.8.101.har', '10.10.8.77.har'];

if (!corpusDir || !existsSync(corpusDir)) {
  if (replayAll) {
    console.error('全量现场 HAR 回放需要有效的 KVM_RECON_FIELD_COLLECTION_2 目录');
    process.exit(1);
  }
  console.log('field har replay e2e skipped（未设置 KVM_RECON_FIELD_COLLECTION_2 或目录不存在）');
  process.exit(0);
}

const harNames = replayAll
  ? readdirSync(corpusDir).filter(name => name.toLowerCase().endsWith('.har')).sort()
  : REPRESENTATIVE_HARS;
if (harNames.length === 0) {
  console.error(`现场 HAR 目录没有可回放文件：${corpusDir}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const electronPackageDir = dirname(require.resolve('electron/package.json'));
const electronPathFile = join(electronPackageDir, 'path.txt');
if (!existsSync(electronPathFile)) {
  console.error('Electron 二进制未安装：缺少 node_modules/electron/path.txt');
  process.exit(1);
}
const electronBinary = join(
  electronPackageDir,
  'dist',
  readFileSync(electronPathFile, 'utf8').trim(),
);
if (!existsSync(electronBinary)) {
  console.error(`Electron 二进制不存在：${electronBinary}`);
  process.exit(1);
}

const mainEntry = join(rootDir, 'dist/main/index.js');
if (!existsSync(mainEntry)) {
  console.error('缺少 dist 构建产物，请先运行 npm run build');
  process.exit(1);
}

const successMarker = 'field har replay e2e passed';

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ASAR;
childEnv.KVM_RECON_E2E_CAPTURE = '1';
childEnv.ELECTRON_DISABLE_SANDBOX = '1';

async function replayHar(harPath) {
  const env = { ...childEnv, KVM_RECON_E2E_FIELD_HAR: harPath };
  const child = spawn(
    electronBinary,
    [mainEntry, '--e2e-capture-controller', '--no-sandbox', '--disable-gpu'],
    { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', chunk => {
    const text = String(chunk);
    output += text;
    if (!replayAll) process.stdout.write(text);
  });
  child.stderr.on('data', chunk => {
    const text = String(chunk);
    output += text;
    if (!replayAll) process.stderr.write(text);
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 180000);
  const code = await new Promise(resolve => {
    child.once('exit', resolve);
  });
  clearTimeout(timeout);
  const passed = !timedOut && code === 0 && output.includes(successMarker);
  if (replayAll) {
    const result = output.split('\n').find(line => line.startsWith(successMarker));
    console.log(`${passed ? 'PASS' : 'FAIL'} ${harPath.split('/').at(-1)}${result ? ` ${result.slice(successMarker.length).trim().replace(/ zip=.*/, '')}` : ''}${timedOut ? ' timeout' : ''}`);
  } else if (!passed) {
    console.error(`现场 HAR 回放失败：${harPath}（退出码 ${code}${timedOut ? '，超时' : ''}）`);
    process.exit(code === 0 ? 1 : code ?? 1);
  }
  return passed;
}

const failed = [];
for (const name of harNames) {
  const harPath = resolve(corpusDir, name);
  if (!existsSync(harPath)) {
    if (replayAll) {
      console.error(`现场 HAR 缺失：${harPath}`);
      process.exit(1);
    }
    console.log(`field har replay e2e skipped（语料缺失：${harPath}）`);
    continue;
  }
  if (!(await replayHar(harPath))) failed.push(name);
}
if (replayAll) console.log(`现场 HAR 全量回放：${harNames.length - failed.length}/${harNames.length} 通过${failed.length ? `；失败：${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
