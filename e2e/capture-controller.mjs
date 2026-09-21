import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
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

// 0.3 韧性变体：断言前销毁全部采集窗口，stop/export 仍必须收尾出 INCOMPLETE 包
const closeBeforeAssert = process.argv.includes('--close-before-assert');
const successMarker = 'production capture controller e2e passed';

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ASAR;
childEnv.KVM_RECON_E2E_CAPTURE = '1';
childEnv.ELECTRON_DISABLE_SANDBOX = '1';

const child = spawn(
  electronBinary,
  [
    mainEntry,
    '--e2e-capture-controller',
    ...(closeBeforeAssert ? ['--e2e-capture-close-before-assert'] : []),
    '--no-sandbox',
    '--disable-gpu',
  ],
  {
    cwd: rootDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let output = '';
function append(chunk) {
  const text = String(chunk);
  output += text;
  return text;
}

child.stdout.on('data', chunk => {
  process.stdout.write(append(chunk));
});
child.stderr.on('data', chunk => {
  process.stderr.write(append(chunk));
});

child.on('error', error => {
  clearTimeout(timeout);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const timeout = setTimeout(() => {
  child.kill('SIGKILL');
  console.error('生产采集 Controller E2E 超时');
  process.exit(1);
}, 45000);

child.on('exit', code => {
  clearTimeout(timeout);
  const passed = output.includes(successMarker);
  if (!passed || code !== 0) {
    console.error(
      passed ? `生产采集 E2E 退出码 ${code}` : '生产采集 E2E 退出但未出现成功标记',
    );
    process.exit(code === 0 ? 1 : code ?? 1);
  }
  process.exit(0);
});
