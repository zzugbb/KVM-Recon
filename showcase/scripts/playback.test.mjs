import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback } from '../playback.js';

function fixture(enabled = true) {
 let pending, state, advances = 0;
 const player = createPlayback({ interval: 2000, enabled,
  advance() { advances++; }, onChange(value) { state = value; },
  schedule(callback, delay) { assert.equal(delay, 2000); pending = callback; return 1; },
  cancel() { pending = undefined; }
 });
 return { player, tick() { assert.ok(pending); const callback=pending; pending=undefined; callback(); },
  get state() { return state; }, get pending() { return Boolean(pending); }, get advances() { return advances; } };
}
test('autoplay advances only while visible and foreground, then resumes', () => {
 const f=fixture(); assert.equal(f.pending,false);
 f.player.setVisible(true); f.tick(); assert.equal(f.advances,1);
 f.player.setForeground(false); assert.equal(f.pending,false);
 f.player.setForeground(true); f.tick(); assert.equal(f.advances,2);
 f.player.setVisible(false); assert.equal(f.pending,false);
 f.player.setVisible(true); assert.equal(f.pending,true);
});
test('manual pause survives viewport changes until explicit resume', () => {
 const f=fixture(); f.player.setVisible(true); f.player.pause();
 f.player.setVisible(false); f.player.setVisible(true);
 assert.deepEqual(f.state,{enabled:false,running:false}); assert.equal(f.pending,false);
 f.player.toggle(); f.tick(); assert.equal(f.advances,1);
});
test('reduced motion starts paused but permits explicit play', () => {
 const f=fixture(false); f.player.setVisible(true); assert.equal(f.pending,false);
 f.player.toggle(); f.tick(); assert.equal(f.advances,1);
});
