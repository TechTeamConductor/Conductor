// The shared PROVIDER CONTRACT SUITE (M2 AC(d)/AC3): the same behaviour is required of every provider, driven through the one interface
// (detect / auth / selfTest / runReadOnly) against scripted fakes. Fakes are NOT evidence about the real CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import { createProviders } from '../../src/agents/providers/registry.ts';
import type { ProviderId } from '../../src/agents/providers/types.ts';
import { codexHomePath, prepareCodexHome } from '../../src/agents/providers/codex-home.ts';
import { systemClock } from '../../src/util.ts';
import type { Config } from '../../src/types.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures');
const FAKE = { claude: join(FIX, 'fake-claude.mjs'), cursor: join(FIX, 'fake-agent.mjs'), codex: join(FIX, 'fake-codex.mjs') };
const BROKEN = join(FIX, 'fake-broken.mjs');
const WEIRD = join(FIX, 'fake-weird.mjs');
for (const f of [...Object.values(FAKE), BROKEN, WEIRD]) chmodSync(f, 0o755);
const IDS: ProviderId[] = ['claude', 'cursor', 'codex'];
const SECRET = 'hunter2-contract-secret-9876';

function signIn(): void {
  prepareCodexHome();
  writeFileSync(join(codexHomePath(), 'auth.json'), '{}', { mode: 0o600 });
}
function setup(id: ProviderId, bin: string, scenario: Record<string, unknown> = {}) {
  signIn();
  const dir = mkdtempSync(join(tmpdir(), 'cond-contract-'));
  const cfg: Config = normalizeConfig({ ...defaultConfig(), agents: { ...defaultConfig().agents, [id]: { bin } } });
  const provider = createProviders({ getConfig: () => cfg, clock: systemClock, extraEnv: { FAKE_DIR: dir } })[id];
  const put = (sc: Record<string, unknown>) => writeFileSync(join(dir, id === 'codex' ? 'codex.json' : 'scenario.json'), JSON.stringify(sc));
  put(scenario);
  return { cfg, provider, dir, put };
}
const calls = (dir: string, id: ProviderId): any[] => {
  const f = join(dir, id === 'codex' ? 'codex-calls.jsonl' : 'calls.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** The scenario each fake needs for: a plain success / a usage limit / a hang. */
const scenarios = (id: ProviderId) => ({
  ok: id === 'codex' ? { exec: [{ mode: 'ok' }] } : {},
  limit: id === 'claude' ? { claude: { '*': { plan: [{ limit: {} }] } } } : id === 'cursor' ? { cursor: { '*': { plan: [{ limit: true }] } } } : { exec: [{ mode: 'limit' }] },
  hang: id === 'claude' ? { claude: { '*': { plan: [{ hang: true }] } } } : id === 'cursor' ? { cursor: { '*': { plan: [{ delayMs: 10, hang: true }] } } } : { exec: [{ mode: 'hang' }] },
});
const req = (over: Record<string, unknown> = {}) => ({
  stage: 'plan' as const,
  cwd: mkdtempSync(join(tmpdir(), 'cond-contract-cwd-')),
  prompt: `# Stage: PLAN\nIssue key: ENG-1\nTitle: ${SECRET}\nPlease plan this.`,
  schema: { type: 'object' } as any,
  name: 'contract',
  onEvent: () => undefined,
  secrets: [SECRET],
  ...over,
});

for (const id of IDS) {
  test(`[${id}] detect: missing / broken-install / ok (with a version)`, async () => {
    const missing = await setup(id, 'definitely-not-installed-cli-xyz').provider.detect(setup(id, 'definitely-not-installed-cli-xyz').cfg);
    assert.equal(missing.state, 'missing');
    const bk = setup(id, BROKEN);
    const broken = await bk.provider.detect(bk.cfg);
    assert.equal(broken.state, 'broken-install');
    assert.match(broken.detail ?? '', /ENOENT/);
    const ok = setup(id, FAKE[id]);
    const d = await ok.provider.detect(ok.cfg);
    assert.equal(d.state, 'ok');
    assert.match(d.version ?? '', /\d+\.\d+/);
  });

  test(`[${id}] auth: ok / not-logged-in / unknown`, async () => {
    const ok = setup(id, FAKE[id]);
    assert.equal((await ok.provider.auth(ok.cfg)).state, 'ok');
    const out = setup(id, FAKE[id], id === 'codex' ? { login: 'out' } : { login: 'out' });
    assert.equal((await out.provider.auth(out.cfg)).state, 'not-logged-in');
    const weird = setup(id, id === 'codex' ? 'definitely-not-installed-cli-xyz' : WEIRD);
    assert.equal((await weird.provider.auth(weird.cfg)).state, 'unknown');
  });

  test(`[${id}] selfTest('cheap') never reaches a model and reports the common vocabulary`, async () => {
    const t = setup(id, FAKE[id]);
    const r = await t.provider.selfTest(t.cfg, 'cheap');
    assert.deepEqual([r.level, r.state, r.ok], ['cheap', 'ok', true]);
    assert.equal(calls(t.dir, id).filter((c) => c.cmd === 'exec' || c.stage).length, 0, 'no model call was made');
    const m = setup(id, 'definitely-not-installed-cli-xyz');
    assert.equal((await m.provider.selfTest(m.cfg, 'cheap')).state, 'missing');
    const b = setup(id, BROKEN);
    assert.equal((await b.provider.selfTest(b.cfg, 'cheap')).state, 'broken-install');
    const o = setup(id, FAKE[id], { login: 'out' });
    const lo = await o.provider.selfTest(o.cfg, 'cheap');
    assert.deepEqual([lo.state, lo.ok], ['not-logged-in', false]);
    assert.equal(calls(o.dir, id).filter((c) => c.cmd === 'exec' || c.stage).length, 0);
  });

  test(`[${id}] runReadOnly: a structured result; secrets never in argv; events and text carry no secret`, async () => {
    const t = setup(id, FAKE[id], scenarios(id).ok);
    const events: string[] = [];
    const res = await t.provider.runReadOnly!(req({ onEvent: (e: any) => events.push(String(e.text ?? '')) }));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.json && typeof res.json === 'object', 'a parsed JSON object');
    assert.ok(!res.text.includes(SECRET), 'the final text is redacted');
    assert.ok(events.every((e) => !e.includes(SECRET)), 'every event is redacted');
    for (const c of calls(t.dir, id)) assert.ok(!(c.argv ?? []).join(' ').includes(SECRET), 'the secret/prompt never travels in argv');
  });

  test(`[${id}] a usage limit is classified as limit and carries THIS provider's id`, async () => {
    const t = setup(id, FAKE[id], scenarios(id).limit);
    const res = await t.provider.runReadOnly!(req());
    assert.equal(res.ok, false);
    assert.equal(res.errorKind, 'limit');
    assert.equal(res.limit?.provider, id);
  });

  test(`[${id}] abort stops the child promptly`, async () => {
    const t = setup(id, FAKE[id], scenarios(id).hang);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    const t0 = Date.now();
    const res = await t.provider.runReadOnly!(req({ signal: ac.signal }));
    assert.equal(res.errorKind, 'aborted');
    assert.ok(Date.now() - t0 < 12_000, 'the process group was killed, not waited for');
  });

  test(`[${id}] a broken install is a START failure (errorKind spawn), so the chain can advance`, async () => {
    const t = setup(id, BROKEN, {});
    const res = await t.provider.runReadOnly!(req());
    assert.equal(res.ok, false);
    assert.equal(res.errorKind, 'spawn', `got ${res.errorKind}: ${res.error}`);
  });
}

test('every provider in the registry is covered by this suite (a new provider without contract tests fails here)', () => {
  const reg = createProviders({ getConfig: () => defaultConfig(), clock: systemClock, extraEnv: {} });
  assert.deepEqual(Object.keys(reg).sort(), [...IDS].sort());
  for (const p of Object.values(reg)) for (const m of ['detect', 'auth', 'selfTest', 'runReadOnly'] as const) assert.equal(typeof (p as any)[m], 'function', `${p.id}.${m}`);
  mkdirSync(join(tmpdir(), 'x'), { recursive: true });
});
