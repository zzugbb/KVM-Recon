import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const data=JSON.parse(await readFile(new URL('../data/cases.json',import.meta.url),'utf8'));
const original=JSON.parse(await readFile(new URL('../../examples/capture-pack-v2/integrity.json',import.meta.url),'utf8'));
test('complete excerpt uses original verified public sample',()=>assert.deepEqual(data.complete,original));
test('failure result keeps exact ten gates and explicit worker gap',()=>{assert.equal(data.incomplete.captureIntegrity,'INCOMPLETE');assert.deepEqual(data.incomplete.reasons,['INCOMPLETE_WORKER_SOURCE']);assert.equal(data.incomplete.gates.length,10);assert.deepEqual(data.incomplete.gates.filter(g=>!g.passed).map(g=>g.id),['scripts-workers-wasm-complete']);});
test('public data limited to intentional sample files and local Mock addresses',()=>{assert.equal(Object.keys(data.files).length,11);assert.equal(data.files['manifest.json'].target.host,'127.0.0.1');for(const row of data.files['raw/http/transactions.jsonl'])assert.equal(new URL(row.url).hostname,'127.0.0.1');assert.deepEqual(data.files['ai/index.json'].webrtcChannelIds,[]);assert.deepEqual(data.files['ai/index.json'].webtransportChannelIds,[]);});
test('relative assets work under a GitHub Pages project path',async()=>{const html=await readFile(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/href="\.\/styles.css"/);assert.match(html,/src="\.\/app.js"/);const js=await readFile(new URL('../app.js',import.meta.url),'utf8');assert.match(js,/new URL\('\.\/data\/cases.json',import.meta.url\)/);for(const path of ['workflow','cases','capabilities','pack'])assert.ok(html.includes(`id="${path}"`));});
