// AC2: the whole first-run wizard (agents → Linear key → team → labels → repo) driven through the HTTP API.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { FakeLinear } from '../src/linear/fake.ts';
import { MemoryStore } from '../src/secrets.ts';
import { defaultConfig, normalizeConfig } from '../src/config.ts';
import { makeRepo } from './helpers/harness.ts';

let rt: Runtime;
let port = 0;
let cookie = '';
let csrf = '';
let home = '';
const secrets = new MemoryStore();
const fake = new FakeLinear({ key: 'WIZ' });
const KEY = 'lin_api_' + 'AbCdEfGhIjKlMnOpQrStUvWx0123456789';

function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { cookie, 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin' } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let j: any = null;
        try {
          j = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, json: j, text: t });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cond-wiz-')));
  process.env.CONDUCTOR_HOME = join(home, 'h');
  process.env.CONDUCTOR_NO_KEYCHAIN = '1';
  rt = await createRuntime({
    ephemeral: true,
    config: normalizeConfig(defaultConfig()),
    linear: null,
    secretStore: secrets,
    connect: async () => ({ viewer: { id: fake.viewerId, name: 'Wiz User', email: 'w@example.com' }, teams: [{ id: fake.teamId, key: 'WIZ', name: 'Wizard Team' }] }),
    makeLinear: () => fake,
    health: async () => ({ claude: { found: true, ok: true, loggedIn: true, detail: 'ok' }, cursor: { found: true, ok: true, loggedIn: true, detail: 'ok' } }),
    persistent: { load: () => ({ repos: {} }), save: () => undefined },
    notify: () => undefined,
  });
  port = await rt.server.listen(0);
  const u = new URL(rt.server.loginUrl());
  const r = await new Promise<http.IncomingMessage>((res) => http.get({ host: '127.0.0.1', port, path: u.pathname + u.search }, res));
  cookie = String(r.headers['set-cookie']?.[0]).split(';')[0]!;
  csrf = (await call('/api/state')).json.csrf;
  makeRepo(join(home, 'app'), {});
});
after(async () => {
  await rt.close();
  rmSync(home, { recursive: true, force: true });
});

test('fresh install: setup is incomplete with the right steps, and the board is not shown', async () => {
  const s = (await call('/api/state')).json;
  assert.equal(s.setup.complete, false);
  assert.deepEqual(s.setup.steps.map((x: any) => [x.id, x.ok]), [['agents', true], ['linear', false], ['team', false], ['repo', false]]);
});

test('wizard end to end: key → (dry-run preview) → create labels → repo → complete; the key is stored once and never echoed', async () => {
  const bad = await call('/api/setup/linear-key', 'POST', { key: 'not-a-linear-key' });
  assert.equal(bad.status, 400);
  const k = await call('/api/setup/linear-key', 'POST', { key: KEY });
  assert.equal(k.status, 200);
  assert.deepEqual(k.json.teams.map((t: any) => t.key), ['WIZ']);
  assert.ok(!k.text.includes(KEY), 'the key is not echoed back');
  assert.equal(await secrets.get('linear-api-key'), KEY, 'stored in the secret store');
  assert.equal((await call('/api/state')).json.setup.steps[1].ok, true);

  const dry = await call('/api/setup/team', 'POST', { teamId: fake.teamId, mode: 'labels', dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.dryRun, true);
  assert.ok(dry.json.willCreate.includes('conductor') && dry.json.willCreate.includes('conductor-bug') && dry.json.willCreate.length === 8, dry.text);
  assert.equal(fake.allLabels().some((l) => l.name === 'conductor'), false, 'the preview creates nothing in Linear');
  assert.ok(Array.isArray(dry.json.warnings));

  const real = await call('/api/setup/team', 'POST', { teamId: fake.teamId, mode: 'labels', dryRun: false });
  assert.equal(real.status, 200);
  assert.equal(real.json.created.length, 8);
  assert.ok(fake.labelByName('conductor') && fake.labelByName('conductor:building'));
  const again = await call('/api/setup/team', 'POST', { teamId: fake.teamId, mode: 'labels', dryRun: false });
  assert.equal(again.json.created.length, 0, 'idempotent');

  const repo = await call('/api/setup/repo', 'POST', { path: join(home, 'app') });
  assert.equal(repo.status, 200);
  assert.ok(repo.json.repo.gates.some((g: any) => g.name === 'test'));

  const done = (await call('/api/state')).json;
  assert.equal(done.setup.complete, true);
  assert.ok(done.setup.steps.every((s: any) => s.ok));
});

test('after setup the pipeline works from the dashboard: New task → picked up → finished', async () => {
  rt.engine.start({ pollMs: 100 });
  const t = await call('/api/tasks', 'POST', { title: 'Wizard smoke task', description: 'hello' });
  assert.equal(t.status, 201);
  assert.match(t.json.key, /^WIZ-\d+$/);
  const t0 = Date.now();
  for (;;) {
    const r = (await call('/api/state')).json.runs.find((x: any) => x.key === t.json.key);
    if (r) break;
    if (Date.now() - t0 > 10_000) throw new Error('the new task was never claimed');
    await new Promise((x) => setTimeout(x, 150));
  }
});
