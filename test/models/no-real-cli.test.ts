// AC12 (B1, R2-N2): `npm test` never reaches a real CLI through model discovery. Exercised for real — not just asserted — on
//  (1) a runtime created exactly the way test/setup-wizard.test.ts creates one (default config ⇒ the REAL `claude`/`agent` bins, injected
//      health), driven through the same endpoints the wizard hits, plus warmUp();
//  (2) the demo boot (src/demo.ts: fake bins + FAKE_DIR, injected health);
//  (3) a service with no injected spawn inside the test context: it refuses, and the fake bin it was pointed at never runs.
// Spawns are counted through the service's own counter (its injected-spawn seam); ESM exports cannot be spied.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/runtime.ts';
import { MemoryStore } from '../../src/secrets.ts';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import { ModelService, TEST_REFUSAL_REASON } from '../../src/models/service.ts';
import { FAKE_AGENT, FAKE_CLAUDE, modelHome } from './helpers.ts';

const h = modelHome();
after(() => h.cleanup());

test('setup-wizard-style runtime (real default bins, injected health): health reads, warmUp and GET /api/models start 0 discoveries; a manual refresh is refused, 0 spawns', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cond-wiz-models-')));
  process.env.CONDUCTOR_HOME = join(home, 'h');
  process.env.CONDUCTOR_NO_KEYCHAIN = '1';
  const rt = await createRuntime({
    ephemeral: true,
    config: normalizeConfig(defaultConfig()),
    secretStore: new MemoryStore(),
    health: async () => ({ claude: { found: true, ok: true, loggedIn: true, detail: 'ok', version: '2.1.304' }, cursor: { found: true, ok: true, loggedIn: true, detail: 'ok', version: '2026.10.19' } }),
    persistent: { load: () => ({ repos: {} }), save: () => undefined },
    notify: () => undefined,
  });
  try {
    assert.ok(rt.models, 'the service exists by default');
    const port = await rt.server.listen(0);
    for (let i = 0; i < 5; i++) {
      await rt.api.handle('GET', '/api/state', new URLSearchParams(), {});
      await rt.api.handle('GET', '/api/providers', new URLSearchParams(), {});
      await rt.engine.freshHealth();
    }
    rt.warmUp();
    await new Promise((res) => setTimeout(res, 200));
    const g = await rt.api.handle('GET', '/api/models', new URLSearchParams(), {});
    assert.equal((g.json as any).providers.length, 3);
    assert.deepEqual(rt.models!.counters, { spawns: 0, refusedInTest: 0, refreshes: 0 }, 'injected health ⇒ no automatic discovery at all');
    // a manual refresh goes through the service, which refuses inside the test context (no injected spawn)
    const p = await rt.api.handle('POST', '/api/models/refresh', new URLSearchParams(), {});
    assert.equal(p.status, 202);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(rt.models!.counters.spawns, 0);
    assert.equal(rt.models!.counters.refusedInTest, 2, 'claude + cursor refused; codex never attempted');
    assert.equal(rt.models!.view('claude').reason, TEST_REFUSAL_REASON);
  } finally {
    await rt.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('runtime `models: false` ⇒ no service at all', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cond-nomodels-')));
  process.env.CONDUCTOR_HOME = join(home, 'h');
  const rt = await createRuntime({ ephemeral: true, config: normalizeConfig(defaultConfig()), secretStore: new MemoryStore(), health: async () => ({ claude: { found: false, ok: false }, cursor: { found: false, ok: false } }), persistent: { load: () => ({ repos: {} }), save: () => undefined }, notify: () => undefined, models: false });
  try {
    assert.equal(rt.models, null);
  } finally {
    await rt.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a service without an injected spawn refuses inside the test context; the fake bin it points at never runs', async () => {
  process.env.CONDUCTOR_HOME = h.home;
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this runs under node --test');
  const svc = new ModelService({ getConfig: () => normalizeConfig(defaultConfig()), extraEnv: { FAKE_DIR: h.fake }, bins: () => ({ claude: FAKE_CLAUDE, cursor: FAKE_AGENT }), log: { info: () => undefined, warn: () => undefined } });
  const a = await svc.refresh('claude');
  const b = await svc.refresh('cursor');
  await svc.startup({ claude: { found: true, state: 'ok', version: '9.9.9' } });
  assert.equal(a.reason, TEST_REFUSAL_REASON);
  assert.equal(b.reason, TEST_REFUSAL_REASON);
  assert.equal(svc.counters.spawns, 0);
  assert.equal(existsSync(join(h.fake, 'calls.jsonl')), false, 'no fake (or real) CLI ran');
});

test('demo boot (fake bins, FAKE_DIR, injected health): 0 discovery spawns while it serves the dashboard', async () => {
  const { startDemo } = await import('../../src/demo.ts');
  const d = await startDemo({ port: 0, pollMs: 60_000, delayMs: 10 });
  try {
    for (let i = 0; i < 3; i++) {
      await d.rt.api.handle('GET', '/api/state', new URLSearchParams(), {});
      await d.rt.api.handle('GET', '/api/models', new URLSearchParams(), {});
    }
    d.rt.warmUp();
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(d.rt.models);
    assert.deepEqual(d.rt.models!.counters, { spawns: 0, refusedInTest: 0, refreshes: 0 });
  } finally {
    await d.close();
    rmSync(d.home, { recursive: true, force: true });
  }
});
