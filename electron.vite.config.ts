import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    build: {
      outDir: resolve(rootDir, 'dist/main'),
    },
  },
  preload: {
    build: {
      outDir: resolve(rootDir, 'dist/preload'),
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
