import { cp, mkdir, rm } from 'node:fs/promises';
await rm(new URL('../out/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../out/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'playback.js', 'data']) await cp(new URL(`../${file}`, import.meta.url), new URL(`../out/${file}`, import.meta.url), { recursive: true });
console.log('Static showcase built: showcase/out');
