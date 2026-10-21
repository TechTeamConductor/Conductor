// /modes.js (M8-U) is one exact entry of the static whitelist: served with a session only, with the security headers, and no
// variant of its path reaches another file.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startDemo, type DemoHandle } from '../src/demo.ts';

let demo: DemoHandle;
let port = 0;
let cookie = '';
const modesSrc = readFileSync(join(import.meta.dirname, '..', 'ui', 'modes.js'), 'utf8');

function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: t }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  demo = await startDemo({ port: 0, pollMs: 150, delayMs: 15 });
  port = demo.rt.server.listeningPort;
  const url = new URL(demo.rt.server.loginUrl());
  const r = await raw(url.pathname + url.search);
  assert.equal(r.status, 302);
  cookie = String(r.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
});
after(async () => {
  await demo.close();
  rmSync(demo.home, { recursive: true, force: true });
});

test('/modes.js is served to a signed-in browser with the security headers', async () => {
  const r = await raw('/modes.js', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.match(String(r.headers['content-security-policy']), /script-src 'self'/);
  assert.match(String(r.headers['content-security-policy']), /style-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.text, modesSrc);
  assert.match(r.text, /ConductorModes/);
});

test('/modes.js is not served without a session', async () => {
  const r = await raw('/modes.js');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login');
  assert.doesNotMatch(r.text, /ConductorModes/);
});

test('no variant of the path reaches another file', async () => {
  for (const p of ['/ui/modes.js', '/MODES.JS', '/modes.js/', '/modes.js%00', '/%2fmodes.js', '/modes.js/../package.json', '/modes.mjs', '/modes.js.map']) {
    const r = await raw(p, { cookie });
    assert.notEqual(r.status, 200, `${p} → ${r.status}`);
    assert.doesNotMatch(r.text, /ConductorModes|"name"/, `${p} leaked content`);
  }
  // the query string never selects a file, and dot segments normalise to the same whitelisted path (never elsewhere)
  for (const p of ['/modes.js?x=../app.js', '/./modes.js', '/x/../modes.js', '/%2e%2e/modes.js']) {
    const r = await raw(p, { cookie });
    assert.ok(r.status !== 200 || r.text === modesSrc, `${p} served something other than modes.js`);
  }
});

test('index.html loads modes.js before app.js, both deferred', async () => {
  const r = await raw('/', { cookie });
  assert.equal(r.status, 200);
  const a = r.text.indexOf('<script src="/modes.js" defer></script>');
  const b = r.text.indexOf('<script src="/app.js" defer></script>');
  assert.ok(a > 0 && b > a, 'order');
});
