/** 真实 Chromium 回归：快速整页跳转时，慢截图不能造成正文/源码漏采。 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const electronDir = dirname(require.resolve('electron/package.json'));
const binary = join(electronDir, 'dist', (await readFile(join(electronDir, 'path.txt'), 'utf8')).trim());
const appDir = await mkdtemp(join(tmpdir(), 'kvm-navigation-e2e-'));
try {
  await build({ entryPoints: [join(root, 'src/core/collector/createCaptureSession.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile: join(appDir, 'capture-session.mjs') });
  await copyFile(join(here, 'navigation-capture-main.mjs'), join(appDir, 'main.mjs'));
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'navigation-capture-e2e', main: 'main.mjs' }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH;
  await new Promise((resolve, reject) => {
    const child = spawn(binary, [appDir, '--no-sandbox', '--disable-gpu'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += String(chunk);
      process.stdout.write(chunk);
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('navigation capture E2E timeout')); }, 60000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0 && output.includes('navigation capture e2e passed')) resolve();
      else reject(new Error(`navigation capture E2E failed (${code})`));
    });
  });
} finally {
  await rm(appDir, { recursive: true, force: true });
}
