import { chmodSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import type { Config, RepoConfig, Settings } from './types.ts';
import { paths, ensureHome } from './paths.ts';
import { atomicWriteFile, deepClone, readJsonFile } from './util.ts';
import { CorruptFileError } from './schema/errors.ts';
import { assertNotNewer, loadVersioned, quarantine, type VersionSpec } from './schema/version.ts';
import { backupPaths } from './schema/backup.ts';
import { logger } from './log.ts';

const log = logger('config');
/** The config shape this build reads/writes. v1 → v2 defaults upgrade stays inside normalizeConfig (inert in M1a). */
/** v1 → v2 (defaults upgrade) happens inside normalizeConfig; v2 → v3 moves the Linear block aside (config v3, M1c). */
export function migrateConfigV2ToV3(raw: any): any {
  const { linear, ...rest } = raw ?? {};
  return linear === undefined ? rest : { ...rest, legacy: { ...(rest.legacy ?? {}), linear } };
}
export const CONFIG_SPEC: VersionSpec = { kind: 'config', field: 'version', current: 3, assumeWhenMissing: 1, migrations: { 2: migrateConfigV2ToV3 } };
const KNOWN_CONFIG_KEYS = new Set(['version', 'ui', 'repos', 'agents', 'stages', 'pipeline', 'worktreeRoot', 'extra', 'legacy']);

export function defaultConfig(): Config {
  return {
    version: 3,
    ui: { port: 4317, openBrowser: true },
    repos: [],
    agents: {
      claude: { bin: 'claude', isolation: 'safe-mode', maxTurns: { plan: 40, review: 25, verify: 40 } },
      cursor: { bin: 'agent' },
    },
    stages: { plan: 'claude', review: 'claude', verify: 'claude' },
    pipeline: {
      maxParallel: 2,
      maxLoops: 3,
      maxAgentRunsPerIssue: 10,
      // Hands-off defaults: plans only wait for you when they are large or touch protected files; when Claude is
      // rate-limited Cursor takes over the read-only stages instead of everything stalling until the reset.
      planApproval: 'auto',
      planReview: 'auto',
      onClaudeLimit: 'cursor',
      failOn: ['blocker', 'major'],
      noGates: 'warn',
      timeoutsMin: { plan: 20, review: 10, build: 90, verify: 30, idle: 15, gate: 15 },
    },
  };
}

const clamp = (n: unknown, lo: number, hi: number, d: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : d;
  return Math.min(hi, Math.max(lo, Math.round(v)));
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;

/** Merge unknown input over defaults and clamp every value to a safe range. */
export function normalizeConfig(input: unknown): Config {
  const d = defaultConfig();
  const i = (input && typeof input === 'object' ? input : {}) as Partial<Config> & Record<string, any>;
  const ag = (i.agents ?? {}) as any;
  const pl = (i.pipeline ?? {}) as any;
  const st = (i.stages ?? {}) as any;
  const to = (pl.timeoutsMin ?? {}) as any;
  // v1 → v2: the v1 defaults ('first' approval, 'wait' on limit, 10-min idle) were friction, not choices — upgrade them once.
  const v1 = !(typeof i.version === 'number' && i.version >= 2);
  if (v1 && pl.planApproval === 'first') pl.planApproval = 'auto';
  if (v1 && pl.onClaudeLimit === 'wait') pl.onClaudeLimit = 'cursor';
  if (v1 && to.idle === 10) to.idle = 15;
  const cfg: Config = {
    version: 3,
    ui: {
      port: clamp(i.ui?.port, 1024, 65535, d.ui.port),
      openBrowser: i.ui?.openBrowser !== false,
    },
    repos: Array.isArray(i.repos) ? (i.repos as RepoConfig[]).filter(validRepo).map(normRepo) : [],
    agents: {
      claude: {
        bin: typeof ag.claude?.bin === 'string' && ag.claude.bin ? ag.claude.bin : d.agents.claude.bin,
        model: typeof ag.claude?.model === 'string' && ag.claude.model ? ag.claude.model : undefined,
        isolation: oneOf(ag.claude?.isolation, ['safe-mode', 'setting-sources'] as const, 'safe-mode'),
        maxTurns: {
          plan: clamp(ag.claude?.maxTurns?.plan, 3, 200, d.agents.claude.maxTurns.plan),
          review: clamp(ag.claude?.maxTurns?.review, 3, 200, d.agents.claude.maxTurns.review),
          verify: clamp(ag.claude?.maxTurns?.verify, 3, 200, d.agents.claude.maxTurns.verify),
        },
      },
      cursor: {
        bin: typeof ag.cursor?.bin === 'string' && ag.cursor.bin ? ag.cursor.bin : d.agents.cursor.bin,
        model: typeof ag.cursor?.model === 'string' && ag.cursor.model ? ag.cursor.model : undefined,
      },
    },
    stages: {
      plan: oneOf(st.plan, ['claude', 'cursor'] as const, 'claude'),
      review: oneOf(st.review, ['claude', 'cursor'] as const, 'claude'),
      verify: oneOf(st.verify, ['claude', 'cursor'] as const, 'claude'),
    },
    pipeline: {
      maxParallel: clamp(pl.maxParallel, 1, 6, d.pipeline.maxParallel),
      maxLoops: clamp(pl.maxLoops, 1, 8, d.pipeline.maxLoops),
      maxAgentRunsPerIssue: clamp(pl.maxAgentRunsPerIssue, 2, 60, d.pipeline.maxAgentRunsPerIssue),
      planApproval: oneOf(pl.planApproval, ['auto', 'manual', 'first'] as const, d.pipeline.planApproval),
      planReview: oneOf(pl.planReview, ['off', 'auto', 'always'] as const, d.pipeline.planReview),
      onClaudeLimit: oneOf(pl.onClaudeLimit, ['wait', 'cursor'] as const, d.pipeline.onClaudeLimit),
      failOn: Array.isArray(pl.failOn) && pl.failOn.length
        ? (pl.failOn.filter((s: unknown) => ['blocker', 'major', 'minor', 'nit'].includes(String(s))) as Config['pipeline']['failOn'])
        : d.pipeline.failOn,
      noGates: oneOf(pl.noGates, ['warn', 'block'] as const, d.pipeline.noGates),
      timeoutsMin: {
        plan: clamp(to.plan, 1, 240, d.pipeline.timeoutsMin.plan),
        review: clamp(to.review, 1, 120, d.pipeline.timeoutsMin.review),
        build: clamp(to.build, 1, 480, d.pipeline.timeoutsMin.build),
        verify: clamp(to.verify, 1, 240, d.pipeline.timeoutsMin.verify),
        idle: clamp(to.idle, 1, 120, d.pipeline.timeoutsMin.idle),
        gate: clamp(to.gate, 1, 240, d.pipeline.timeoutsMin.gate),
      },
    },
    worktreeRoot: typeof i.worktreeRoot === 'string' && i.worktreeRoot ? i.worktreeRoot : undefined,
  };
  // keys this build does not know (written by a newer build or by hand) are carried through untouched
  const extra: Record<string, unknown> = Object.create(null); // no prototype: assigning "__proto__" below can never rewrite one
  const BAD = new Set(['__proto__', 'constructor', 'prototype']); // S-10: never carried (they could rewrite a prototype when merged later)
  if (i.extra && typeof i.extra === 'object' && !Array.isArray(i.extra)) for (const [k, v] of Object.entries(i.extra as Record<string, unknown>)) if (!BAD.has(k)) extra[k] = v;
  for (const [k, v] of Object.entries(i)) if (!KNOWN_CONFIG_KEYS.has(k) && !BAD.has(k)) extra[k] = v;
  if (Object.keys(extra).length) cfg.extra = { ...extra };
  // the old `linear` block (a config that skipped the migration) and any `legacy` content are carried verbatim, never interpreted
  const legacy: Record<string, unknown> = Object.create(null);
  if (i.legacy && typeof i.legacy === 'object' && !Array.isArray(i.legacy)) for (const [k, v] of Object.entries(i.legacy as Record<string, unknown>)) if (!BAD.has(k)) legacy[k] = v;
  if ((i as any).linear !== undefined && legacy.linear === undefined) legacy.linear = (i as any).linear;
  if (Object.keys(legacy).length) cfg.legacy = { ...legacy };
  if (!cfg.pipeline.failOn.length) cfg.pipeline.failOn = d.pipeline.failOn;
  return cfg;
}

function validRepo(r: unknown): boolean {
  const x = r as RepoConfig;
  return !!x && typeof x.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x.name) && typeof x.path === 'string' && x.path.startsWith('/');
}
function normRepo(r: RepoConfig): RepoConfig {
  return {
    name: r.name,
    path: r.path,
    baseBranch: typeof r.baseBranch === 'string' && r.baseBranch ? r.baseBranch : 'main',
    gates: Array.isArray(r.gates) ? r.gates.filter((g) => g && typeof g.cmd === 'string' && typeof g.name === 'string') : [],
    setup: typeof r.setup === 'string' && r.setup ? r.setup : undefined,
    copyFiles: Array.isArray(r.copyFiles) ? r.copyFiles.filter((f) => typeof f === 'string') : ['.env', '.env.local'],
    envPassthrough: Array.isArray(r.envPassthrough) ? r.envPassthrough.filter((f) => typeof f === 'string') : [],
  };
}

/**
 * Reads the config under the version contract. A config written by a NEWER build throws NewerVersionError (the caller must
 * refuse to start and must not write). A corrupt file is kept aside as `config.json.corrupt-<ts>` and defaults are used.
 */
let backupBeforeNextSave = false;
export function loadConfig(): Config {
  try {
    const l = loadVersioned<Record<string, any>>(paths.config(), CONFIG_SPEC, () => ({}));
    backupBeforeNextSave = l.existed && l.fromVersion < CONFIG_SPEC.current; // an older file is rewritten in the new shape on the next save → keep the original first
    return normalizeConfig(l.data);
  } catch (e) {
    if (e instanceof CorruptFileError) {
      const kept = quarantine(paths.config());
      log.warn(`config.json was unreadable — kept as ${kept ?? paths.config()}; starting from defaults`);
      return normalizeConfig({});
    }
    throw e;
  }
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  assertNotNewer(paths.config(), CONFIG_SPEC); // a newer build wrote it since we loaded it: do not overwrite (S-9)
  if (backupBeforeNextSave) {
    // the old file is only replaced once its backup is safely on disk (S-7): a failed backup aborts the save
    backupPaths([paths.config()], { label: 'pre-upgrade-config' });
    backupBeforeNextSave = false;
  }
  const { extra, ...known } = cfg;
  atomicWriteFile(paths.config(), JSON.stringify({ ...(extra ?? {}), ...known }, null, 2) + '\n', 0o600);
  try {
    chmodSync(paths.config(), 0o600);
  } catch {
    /* best effort */
  }
}

export function toSettings(cfg: Config): Settings {
  return {
    planApproval: cfg.pipeline.planApproval,
    planReview: cfg.pipeline.planReview,
    maxLoops: cfg.pipeline.maxLoops,
    maxParallel: cfg.pipeline.maxParallel,
    onClaudeLimit: cfg.pipeline.onClaudeLimit,
    noGates: cfg.pipeline.noGates,
    stages: { ...cfg.stages },
  };
}

/** Apply a (partial, untrusted) settings patch; unknown keys are ignored; values are clamped. */
export function applySettings(cfg: Config, patch: Partial<Settings>): Config {
  const next = deepClone(cfg);
  const merged = normalizeConfig({
    ...next,
    pipeline: {
      ...next.pipeline,
      ...(patch.planApproval !== undefined ? { planApproval: patch.planApproval } : {}),
      ...(patch.planReview !== undefined ? { planReview: patch.planReview } : {}),
      ...(patch.maxLoops !== undefined ? { maxLoops: patch.maxLoops } : {}),
      ...(patch.maxParallel !== undefined ? { maxParallel: patch.maxParallel } : {}),
      ...(patch.onClaudeLimit !== undefined ? { onClaudeLimit: patch.onClaudeLimit } : {}),
      ...(patch.noGates !== undefined ? { noGates: patch.noGates } : {}),
    },
    stages: { ...next.stages, ...(patch.stages ?? {}) },
  });
  return merged;
}

// ───────────── executable resolution (launchd has a minimal PATH) ─────────────
export function searchPath(): string[] {
  const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const cur = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return [...new Set([...cur, ...extra])];
}
export function resolveBin(bin: string): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  for (const d of searchPath()) {
    const p = join(d, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

// ───────────── small persistent state (not config) ─────────────
export interface PersistentState {
  repos: Record<string, { approvedPlans: number }>;
}
export const STATE_SPEC: VersionSpec = { kind: 'state', field: 'schemaVersion', current: 1, assumeWhenMissing: 1 };
export function loadState(): PersistentState {
  try {
    const s = loadVersioned<Partial<PersistentState>>(paths.state(), STATE_SPEC, () => ({})).data;
    return { repos: s.repos && typeof s.repos === 'object' ? s.repos : {} };
  } catch (e) {
    if (e instanceof CorruptFileError) {
      const kept = quarantine(paths.state());
      log.warn(`state.json was unreadable — kept as ${kept ?? paths.state()}; starting empty`);
      return { repos: {} };
    }
    throw e;
  }
}
export function saveState(s: PersistentState): void {
  ensureHome();
  assertNotNewer(paths.state(), STATE_SPEC);
  atomicWriteFile(paths.state(), JSON.stringify({ ...s, schemaVersion: STATE_SPEC.current }, null, 2) + '\n', 0o600);
}
