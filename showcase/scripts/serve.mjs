import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const pages = process.argv.includes('--pages');
const root = resolve(fileURLToPath(new URL(pages ? '../out/' : '../', import.meta.url)));
const base = pages ? '/KVM-Recon/' : '/';
const port = pages ? 3101 : 3100;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
http.createServer(async (req, res) => {
 try { const p=decodeURIComponent(new URL(req.url,'http://localhost').pathname); if (!p.startsWith(base)) throw Error(); const relative=p.slice(base.length)||'index.html'; const file=resolve(root,relative); if (!file.startsWith(root+sep)) throw Error(); const data=await readFile(file); res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(data); } catch {res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${port}${base}`));
