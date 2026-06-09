import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTimeControl } from '../src/timeControl.js';

function makeGlobal() {
  return { Date, performance: { now: () => 0 }, document: undefined };
}

test('Date.now / performance.now follow virtual clock', () => {
  const g = makeGlobal();
  const tc = installTimeControl(g);
  assert.equal(g.Date.now(), 0);
  tc.goToTime(100);
  assert.equal(g.Date.now(), 100);
  assert.equal(g.performance.now(), 100);
  assert.equal(tc.currentTime, 100);
});

test('setTimeout fires at its virtual time', () => {
  const g = makeGlobal();
  const tc = installTimeControl(g);
  let firedAt = null;
  g.setTimeout(() => { firedAt = g.Date.now(); }, 50);
  tc.goToTime(40);
  assert.equal(firedAt, null);
  tc.goToTime(60);
  assert.equal(firedAt, 50);
});

test('clearTimeout cancels', () => {
  const g = makeGlobal();
  const tc = installTimeControl(g);
  let fired = false;
  const id = g.setTimeout(() => { fired = true; }, 10);
  g.clearTimeout(id);
  tc.goToTime(100);
  assert.equal(fired, false);
});

test('requestAnimationFrame fires once per frame with virtual timestamp', () => {
  const g = makeGlobal();
  const tc = installTimeControl(g);
  const stamps = [];
  function frame(t) { stamps.push(t); g.requestAnimationFrame(frame); }
  g.requestAnimationFrame(frame);
  tc.goToTime(33);
  tc.goToTime(66);
  assert.deepEqual(stamps, [33, 66]);
});

test('setInterval reschedules across goToTime', () => {
  const g = makeGlobal();
  const tc = installTimeControl(g);
  let count = 0;
  g.setInterval(() => { count++; }, 10);
  tc.goToTime(35);
  assert.equal(count, 3); // 10,20,30
});

test('zero-delay setTimeout chain does not infinite-loop; advances one per frame', () => {
  const g = makeGlobal();
  const tc = installTimeControl(g);
  let calls = 0;
  function loop() { calls++; g.setTimeout(loop, 0); }
  g.setTimeout(loop, 0);
  tc.goToTime(0);   // must return (no hang); fires the initial timer once
  assert.equal(calls, 1);
  tc.goToTime(16);  // next frame fires the chained timer once more
  assert.equal(calls, 2);
});
