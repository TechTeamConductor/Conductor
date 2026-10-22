// M8-1 S4/B2: `SpawnOpts.maxOutputBytes` — raw bytes of stdout+stderr counted before line splitting; exceeding it kills the process
// group and sets `overflow`. Off by default: existing callers get the exact same result shape (no `overflow` key) and no cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/agents/spawn.ts';

const node = process.execPath;
const env = { PATH: process.env.PATH ?? '' };
const base = { bin: node, cwd: process.cwd(), env, idleMs: 20_000, hardMs: 20_000, graceMs: 300 };
// writes `total` bytes in 64 KB chunks (newline every `every` bytes, 0 = never), then lingers so only a kill ends it early
const writer = (total: number, every: number, linger = 20_000) =>
  `const c='x'.repeat(65536);let n=0;function w(){while(n<${total}){n+=65536;const s=${every}?c.slice(0,${every}-1)+'\\n':c;if(!process.stdout.write(s.repeat(${every}?Math.floor(65536/${every}):1)))return process.stdout.once('drain',w)}setTimeout(()=>{},${linger})}w()`;

test('default (no cap): no `overflow` field, a 3 MB output is read to the end', async () => {
  let lines = 0;
  const r = await runProcess({ ...base, args: ['-e', writer(3 * 1024 * 1024, 1024, 0)], onLine: () => lines++ });
  assert.equal(r.code, 0);
  assert.equal('overflow' in r, false);
  assert.ok(lines >= 3000, `got ${lines} lines`);
});

test('5 MB with no newline over a 2 MB cap ⇒ overflow, the group is killed long before its 20 s linger', async () => {
  let lines = 0;
  const r = await runProcess({ ...base, args: ['-e', writer(5 * 1024 * 1024, 0)], maxOutputBytes: 2 * 1024 * 1024, onLine: () => lines++ });
  assert.equal(r.overflow, true);
  assert.equal(lines, 0);
  assert.ok(r.durationMs < 8000, `took ${r.durationMs}`);
  assert.notEqual(r.signal ?? r.code, 0);
});

test('50,000 short lines (≈ 3 MB) over a 2 MB cap ⇒ overflow; no line is delivered after the cap tripped', async () => {
  let lines = 0;
  let bytes = 0;
  const r = await runProcess({
    ...base,
    args: ['-e', `let b='';for(let i=0;i<50000;i++)b+='{"n":'+i+',"pad":"${'p'.repeat(40)}"}\\n';process.stdout.write(b);setTimeout(()=>{},20000)`],
    maxOutputBytes: 2 * 1024 * 1024,
    onLine: (l) => {
      lines++;
      bytes += l.length + 1;
    },
  });
  assert.equal(r.overflow, true);
  assert.ok(lines < 50_000);
  assert.ok(bytes <= 2 * 1024 * 1024);
  assert.ok(r.durationMs < 8000);
});

test('under the cap: overflow false and the normal exit status', async () => {
  const r = await runProcess({ ...base, args: ['-e', 'process.stdout.write("ok\\n")'], maxOutputBytes: 1024 });
  assert.equal(r.overflow, false);
  assert.equal(r.code, 0);
});
