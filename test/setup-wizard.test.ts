// AC2 (v2): the first-run wizard — agents → repository — driven through the HTTP API. No Linear, no key, no team, no labels.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { MemoryStore } from '../src/secrets.ts';
import { defaultConfig, normalizeConfig } from '../src/config.ts';
import { makeRepo } from './helpers/harness.ts';

let rt: Runtime;
let port = 0;
let csrf = '';
let home = '';
const secrets = new MemoryStore();

function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin' } }, (res) => {
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
    secretStore: secrets,
    health: async () => ({ claude: { found: true, ok: true, loggedIn: true, detail: 'ok' }, cursor: { found: true, ok: true, loggedIn: true, detail: 'ok' } }),
    persistent: { load: () => ({ repos: {} }), save: () => undefined },
    notify: () => undefined,
  });
  port = await rt.server.listen(0);
  csrf = (await call('/api/state')).json.csrf;
  makeRepo(join(home, 'app'), {});
});
after(async () => {
  await rt.close();
  rmSync(home, { recursive: true, force: true });
});

test('fresh install: setup is incomplete with exactly two steps (agents, repository) and no Linear anywhere', async () => {
  const s = (await call('/api/state')).json;
  assert.equal(s.setup.complete, false);
  assert.deepEqual(s.setup.steps.map((x: any) => [x.id, x.ok]), [['agents', true], ['repo', false]]);
  assert.equal(s.health.linear, undefined);
  assert.equal(JSON.stringify(s).toLowerCase().includes('linear'), false, 'no Linear wording in the state the UI receives');
  assert.equal((await call('/api/setup/linear-key', 'POST', { key: 'lin_api_' + 'x'.repeat(30) })).status, 404, 'the old Linear endpoints are gone');
});

test('wizard end to end: register a repository → setup complete; tasks need a repository first', async () => {
  const early = await call('/api/tasks', 'POST', { title: 'too early' });
  assert.ok(early.status >= 400 && early.status < 500, 'no repository yet ⇒ a clear 4xx, not a crash');
  const repo = await call('/api/setup/repo', 'POST', { path: join(home, 'app') });
  assert.equal(repo.status, 200);
  assert.ok(repo.json.repo.gates.some((g: any) => g.name === 'test'));
  const done = (await call('/api/state')).json;
  assert.equal(done.setup.complete, true);
  assert.ok(done.setup.steps.every((s: any) => s.ok));
});

test('after setup the pipeline works from the dashboard: New task → card on the board → picked up', async () => {
  rt.engine.start({ pollMs: 100 });
  const t = await call('/api/tasks', 'POST', { title: 'Wizard smoke task', description: 'hello' });
  assert.equal(t.status, 201);
  assert.match(t.json.key, /^APP-\d+$/, 'the project key is derived from the repository name');
  const board = (await call('/api/board')).json;
  assert.ok(board.projects.some((p: any) => p.repo === 'app'));
  assert.ok(board.items.some((i: any) => i.key === t.json.key && i.createdBy === 'user'));
  const t0 = Date.now();
  for (;;) {
    const r = (await call('/api/state')).json.runs.find((x: any) => x.key === t.json.key);
    if (r) break;
    if (Date.now() - t0 > 10_000) throw new Error('the new task was never claimed');
    await new Promise((x) => setTimeout(x, 150));
  }
});
