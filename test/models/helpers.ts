// Shared helpers for the M8-1 model-discovery tests. Every service built here gets an INJECTED spawn (a recording wrapper around
// runProcess) and fake bins, so no test can reach a real CLI (B1/AC12).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome } from '../../src/paths.ts';
import { runProcess, type SpawnOpts, type SpawnResult } from '../../src/agents/spawn.ts';
import { ModelService, type ModelServiceDeps } from '../../src/models/service.ts';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import type { Clock } from '../../src/util.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, '..', '..', 'fixtures');
export const FAKE_CLAUDE = join(FIXTURES, 'fake-claude.mjs');
export const FAKE_AGENT = join(FIXTURES, 'fake-agent.mjs');
export const REAL = join(FIXTURES, 'real');

export interface SpawnRecord {
  opts: SpawnOpts;
  startedAt: number;
  endedAt?: number;
  result?: SpawnResult;
}

export interface ModelHome {
  root: string;
  home: string;
  fake: string;
  scenario(o: unknown): void;
  calls(): any[];
  cleanup(): void;
}

export function modelHome(): ModelHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cond-models-')));
  const home = join(root, 'home');
  process.env.CONDUCTOR_HOME = home;
  process.env.CONDUCTOR_QUIET = '1';
  ensureHome();
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_AGENT, 0o755);
  const fake = join(root, 'fake');
  mkdirSync(fake, { recursive: true });
  return {
    root,
    home,
    fake,
    scenario(o) {
      writeFileSync(join(fake, 'scenario.json'), JSON.stringify(o));
    },
    calls() {
      const f = join(fake, 'calls.jsonl');
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export class ManualClock implements Clock {
  t: number;
  constructor(t = Date.now()) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Built {
  svc: ModelService;
  spawns: SpawnRecord[];
  logs: string[];
}

/** A service wired to the fakes with a recording spawn. `spawnImpl` replaces the real runProcess (stubs). */
export function buildService(h: ModelHome, over: Partial<ModelServiceDeps> & { spawnImpl?: (o: SpawnOpts) => Promise<SpawnResult> } = {}): Built {
  const spawns: SpawnRecord[] = [];
  const logs: string[] = [];
  const impl = over.spawnImpl ?? runProcess;
  const { spawnImpl, ...rest } = over;
  void spawnImpl;
  const svc = new ModelService({
    getConfig: () => normalizeConfig(defaultConfig()),
    extraEnv: { FAKE_DIR: h.fake },
    bins: () => ({ claude: FAKE_CLAUDE, cursor: FAKE_AGENT }),
    timeoutMs: 4000,
    graceMs: 300,
    log: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`) },
    spawn: async (o) => {
      const rec: SpawnRecord = { opts: o, startedAt: Date.now() };
      spawns.push(rec);
      const r = await impl(o);
      rec.endedAt = Date.now();
      rec.result = r;
      return r;
    },
    ...rest,
  });
  return { svc, spawns, logs };
}

/** A runProcess stand-in that feeds the given lines to onLine and returns the given result (no child at all). */
export function stubSpawn(lines: { line: string; stream?: 'stdout' | 'stderr' }[], result: Partial<SpawnResult> = {}): (o: SpawnOpts) => Promise<SpawnResult> {
  return async (o) => {
    for (const l of lines) o.onLine?.(l.line, l.stream ?? 'stdout');
    return { code: 0, signal: null, timedOut: null, aborted: !!o.signal?.aborted, stdoutTail: '', stderrTail: '', durationMs: 1, overflow: false, ...result };
  };
}

export const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
export const waitFor = async (pred: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
