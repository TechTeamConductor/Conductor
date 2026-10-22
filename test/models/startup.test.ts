// Reviewer B1: the PRODUCTION startup path — a runtime WITHOUT injected health (what `conductor start` and the desktop sidecar build),
// `warmUp()` → real `agentHealth` → `models.startup()` → automatic discovery. Fakes only: the configured claude/cursor bins are the
// fake CLIs (agentHealth runs their `--version` / `auth status`), Codex's bin is a path that does not exist (resolved as missing, never
// spawned — S17), and discovery spawns go through an injected recording spawn.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRuntime } from '../../src/runtime.ts';
import { MemoryStore } from '../../src/secrets.ts';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import { runProcess, type SpawnOpts } from '../../src/agents/spawn.ts';
import { FAKE_AGENT, FAKE_CLAUDE, modelHome, waitFor } from './helpers.ts';

const h = modelHome();
after(() => h.cleanup());

test('B1: no injected health — warmUp() discovers Claude and Cursor automatically (2 spawns, both fresh); a second warmUp() adds none', async () => {
  h.scenario({ models: 'in', listModels: 'ok', lingerMs: 30_000 });
  const cfg = normalizeConfig({
    ...defaultConfig(),
    agents: { claude: { bin: FAKE_CLAUDE, isolation: 'safe-mode', maxTurns: { plan: 40, review: 25, verify: 40 } }, cursor: { bin: FAKE_AGENT }, codex: { bin: join(h.root, 'no-such-codex') } },
  });
  const spawned: SpawnOpts[] = [];
  const rt = await createRuntime({
    ephemeral: true,
    config: cfg,
    secretStore: new MemoryStore(),
    persistent: { load: () => ({ repos: {} }), save: () => undefined },
    notify: () => undefined,
    // NO `health`: the real agentHealth runs (against the fakes)
    models: {
      extraEnv: { FAKE_DIR: h.fake },
      bins: () => ({ claude: FAKE_CLAUDE, cursor: FAKE_AGENT }),
      timeoutMs: 4000,
      graceMs: 300,
      log: { info: () => undefined, warn: () => undefined },
      spawn: (o) => {
        spawned.push(o);
        return runProcess(o);
      },
    },
  });
  try {
    const m = rt.models!;
    assert.equal(m.counters.spawns, 0, 'nothing before warmUp');
    rt.warmUp();
    await waitFor(() => m.counters.spawns === 2 && m.view('claude').state === 'fresh' && m.view('cursor').state === 'fresh', 15_000);
    assert.equal(m.view('claude').models!.length, 13);
    assert.equal(m.view('cursor').models!.length, 265);
    assert.deepEqual(spawned.map((o) => o.bin).sort(), [FAKE_AGENT, FAKE_CLAUDE].sort());
    assert.equal(m.view('codex').state, 'unavailable');
    // the same versions again (agentHealth caches 60 s): S11 — no second discovery
    rt.warmUp();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(m.counters.spawns, 2);
    // the discovery fakes recorded zero prompts
    const calls = h.calls().filter((c) => c.mode === 'models');
    assert.equal(calls.length, 2);
    assert.ok(calls.filter((c) => c.who === 'claude').every((c) => c.prompts === 0));
  } finally {
    await rt.close();
  }
});
