import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateError, createProject, createSample, sampleDir, validateIdentity } from '../src/onboarding/create.ts';
import { environmentReport } from '../src/onboarding/env.ts';
import { makeHarness } from './helpers/harness.ts';
import { Api } from '../src/server/api.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'onb-')));
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const bad = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: any) => e instanceof CreateError && re.test(e.message));

test('create project: a new git repo with one commit, identity in its LOCAL config, no global identity needed, no remote, no hooks', () => {
  process.env.HOME = tmp();
  const parent = tmp();
  const { path } = createProject({ parent, name: 'my-app' });
  assert.equal(path, join(parent, 'my-app'));
  assert.equal(g(path, 'log', '--format=%s'), 'Initial commit');
  assert.equal(g(path, 'config', '--local', 'user.email'), 'conductor@localhost');
  assert.equal(g(path, 'remote').length, 0);
  assert.match(readFileSync(join(path, 'README.md'), 'utf8'), /^# my-app/);
  // a later commit with NO global identity works (the builder's commit path)
  writeFileSync(join(path, 'a.txt'), 'x\n');
  g(path, 'add', '-A');
  g(path, 'commit', '-q', '-m', 'later');
  const mine = createProject({ parent, name: 'mine', identity: { name: 'Ada Lovelace', email: 'ada@example.com' } });
  assert.equal(g(mine.path, 'log', '-1', '--format=%an <%ae>'), 'Ada Lovelace <ada@example.com>');
});

test('create project: refuses bad names, bad identities, existing targets, links, system/home/Conductor folders, folders inside a repo — and leaves nothing behind', () => {
  const home = tmp();
  process.env.HOME = home;
  const parent = tmp();
  for (const name of ['', '.hidden', '-x', 'a/b', '..', 'x'.repeat(65), 'a b', 'a\nb', 5 as any]) bad(() => createProject({ parent, name }), /project name/);
  for (const id of [{ name: '--global', email: 'a@b' }, { name: 'A\u202eB', email: 'a@b' }, { name: 'A\nB', email: 'a@b' }, { name: 'A', email: 'no-at' }, { name: '<x>', email: 'a@b' }, null, { name: 'A' }]) assert.throws(() => validateIdentity(id), CreateError);
  mkdirSync(join(parent, 'exists'));
  bad(() => createProject({ parent, name: 'exists' }), /already exists|project name/);
  const link = join(tmp(), 'lnk');
  symlinkSync(parent, link);
  bad(() => createProject({ parent: link, name: 'x' }), /link/);
  bad(() => createProject({ parent: '/', name: 'x' }), /system folder|home folder/);
  bad(() => createProject({ parent: '/etc', name: 'x' }), /system folder|link/); // /etc is itself a link on macOS
  bad(() => createProject({ parent: home, name: 'x' }), /home folder/);
  bad(() => createProject({ parent: 'relative/path', name: 'x' }), /full path/);
  bad(() => createProject({ parent: join(parent, 'nope'), name: 'x' }), /does not exist/);
  mkdirSync(process.env.CONDUCTOR_HOME!, { recursive: true });
  bad(() => createProject({ parent: realpathSync(process.env.CONDUCTOR_HOME!), name: 'x' }), /Conductor data folder|system folder|inside a git|home folder/);
  const repo = tmp();
  g(repo, 'init', '-q');
  bad(() => createProject({ parent: repo, name: 'x' }), /inside a git repository/);
  assert.ok(!existsSync(join(parent, 'x')) && !existsSync(join(repo, 'x')));
});

test('sample project: one constant location, idempotent, never adopts a folder with other content, and its card waits in Backlog', async () => {
  const home = tmp();
  process.env.HOME = home;
  assert.equal(sampleDir(), join(home, 'Conductor-Sample'));
  const a = createSample();
  assert.equal(a.created, true);
  assert.equal(g(a.path, 'log', '--format=%s'), 'Initial commit');
  assert.equal(createSample().created, false);
  assert.match(execFileSync('node', ['--test'], { cwd: a.path, encoding: 'utf8', env: { PATH: process.env.PATH!, NODE_OPTIONS: '' } }), /pass\s+1\b/, 'the sample test passes');
  writeFileSync(join(a.path, 'extra.txt'), 'mine\n');
  bad(() => createSample(), /not the sample project/);
  const h = await makeHarness();
  try {
    process.env.HOME = tmp();
    const api = new Api({ engine: h.engine, store: h.store, board: h.board, auth: {} as any, version: 't', getConfig: () => h.cfg, saveConfig: (c) => { Object.assign(h.cfg, c); }, persistent: () => ({ repos: {} }) as any, health: async () => ({}) as any, probe: async () => ({ ok: true, detail: '', durationMs: 1 }) });
    const call = (m: string, p: string, b: any = {}) => api.handle(m, p, new URLSearchParams(), b) as Promise<any>;
    await assert.rejects(call('POST', '/api/setup/sample', { path: '/etc' }), (e: any) => e.status === 400);
    const r = await call('POST', '/api/setup/sample');
    assert.equal(r.json.ok, true);
    const again = await call('POST', '/api/setup/sample');
    assert.equal(again.json.key, r.json.key, 'idempotent');
    const card = h.board.item(r.json.key)!;
    assert.equal(card.lane, 'backlog');
    await h.settle();
    assert.equal(h.store.list().length, 0, 'it never starts by itself');
    await assert.rejects(call('POST', '/api/setup/project/create', { parent: tmp(), name: 'x', evil: 1 }), (e: any) => e.status === 400);
    const env = (await call('GET', '/api/setup/environment')).json;
    assert.equal(env.nodeOk, true);
  } finally { await h.cleanup(); }
  assert.equal(environmentReport().gitOk, true);
});
