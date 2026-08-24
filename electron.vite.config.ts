import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    build: {
      outDir: resolve(rootDir, 'dist/main'),
      // 把 jszip 打进主进程包，安装包 files 不含 node_modules 时导出 zip 仍可用
      externalizeDeps: {
        exclude: ['jszip'],
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(rootDir, 'dist/preload'),
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.js',
        },
      },
    },
  },
  renderer: {
    root: resolve(rootDir, 'src/renderer'),
    build: {
      outDir: resolve(rootDir, 'dist/renderer'),
      emptyOutDir: true,
    },
  },
});
