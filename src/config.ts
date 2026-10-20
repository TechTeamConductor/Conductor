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
import { ROLES, cursorFollowsClaude, defaultRoles, firstReadOnlyProvider, normalizeRoles, type Roles } from './agents/roles.ts';
import type { ProviderId } from './agents/providers/types.ts';

const log = logger('config');
/** The config shape this build reads/writes. v1 → v2 defaults upgrade stays inside normalizeConfig (inert in M1a). */
/** v1 → v2 (defaults upgrade) happens inside normalizeConfig; v2 → v3 moves the Linear block aside (config v3, M1c). */
export function migrateConfigV2ToV3(raw: any): any {
  const { linear, ...rest } = raw ?? {};
  return linear === undefined ? rest : { ...rest, legacy: { ...(rest.legacy ?? {}), linear } };
}
/**
 * v3 → v4 (M2): `stages{plan,review,verify}` + `pipeline.onClaudeLimit` become `roles` (planning/review/verification chains; the
 * implementation/debugging/documentation roles keep Cursor, the rest Claude). The old keys are kept verbatim under `legacy.v3`.
 * v1 files get v1's default upgrade first (`wait` was friction, not a choice → `cursor`), exactly as normalizeConfig always did.
 */
export function migrateConfigV3ToV4(raw: any): any {
  const { stages, pipeline, ...rest } = raw ?? {};
  const v1 = !(typeof raw?.version === 'number' && raw.version >= 2);
  const { onClaudeLimit, ...pl } = pipeline && typeof pipeline === 'object' ? pipeline : ({} as Record<string, unknown>);
  const takeover = (v1 && onClaudeLimit === 'wait') || onClaudeLimit !== 'wait';
  const chain = (p: unknown): ProviderId[] => {
    const first: ProviderId = p === 'cursor' ? 'cursor' : 'claude';
    return first === 'claude' && takeover ? ['claude', 'cursor'] : [first];
  };
  const roles = rest.roles ?? { planning: { providers: chain(stages?.plan) }, review: { providers: chain(stages?.review) }, verification: { providers: chain(stages?.verify) } };
  const legacy = stages !== undefined || onClaudeLimit !== undefined ? { ...(rest.legacy ?? {}), v3: { stages, onClaudeLimit } } : rest.legacy;
  return { ...rest, ...(pipeline !== undefined ? { pipeline: pl } : {}), roles, ...(legacy !== undefined ? { legacy } : {}) };
}
export const CONFIG_SPEC: VersionSpec = { kind: 'config', field: 'version', current: 4, assumeWhenMissing: 1, migrations: { 2: migrateConfigV2ToV3, 3: migrateConfigV3ToV4 } };
const KNOWN_CONFIG_KEYS = new Set(['version', 'ui', 'repos', 'agents', 'stages', 'roles', 'pipeline', 'worktreeRoot', 'extra', 'legacy']);

export function defaultConfig(): Config {
  return {
    version: 4,
    ui: { port: 4327, openBrowser: true }, // v1 uses 4317: both can run side by side
    repos: [],
    agents: {
      claude: { bin: 'claude', isolation: 'safe-mode', maxTurns: { plan: 40, review: 25, verify: 40 } },
      cursor: { bin: 'agent' },
    },
    roles: defaultRoles(),
    pipeline: {
      maxParallel: 2,
      maxLoops: 3,
      maxAgentRunsPerIssue: 10,
      // Hands-off defaults: plans only wait for you when they are large or touch protected files; when Claude is
      // rate-limited Cursor takes over the read-only stages (the default planning/review/verification chains are claude → cursor).
      planApproval: 'auto',
      planReview: 'auto',
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
  const to = (pl.timeoutsMin ?? {}) as any;
  // v1 → v2: the v1 defaults ('first' approval, 'wait' on limit, 10-min idle) were friction, not choices — upgrade them once.
  const v1 = !(typeof i.version === 'number' && i.version >= 2);
  if (v1 && pl.planApproval === 'first') pl.planApproval = 'auto';
  // a config that still has the v3 `stages` / `onClaudeLimit` keys (or no roles yet) gets its roles derived from them (idempotent)
  const withRoles = i.roles === undefined && (i.stages !== undefined || pl.onClaudeLimit !== undefined) ? migrateConfigV3ToV4(i) : i;
  if (v1 && to.idle === 10) to.idle = 15;
  const cfg: Config = {
    version: 4,
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
    roles: normalizeRoles((withRoles as any).roles, (m) => log.warn(`config roles: ${m}`)),
    pipeline: {
      maxParallel: clamp(pl.maxParallel, 1, 6, d.pipeline.maxParallel),
      maxLoops: clamp(pl.maxLoops, 1, 8, d.pipeline.maxLoops),
      maxAgentRunsPerIssue: clamp(pl.maxAgentRunsPerIssue, 2, 60, d.pipeline.maxAgentRunsPerIssue),
      planApproval: oneOf(pl.planApproval, ['auto', 'manual', 'first'] as const, d.pipeline.planApproval),
      planReview: oneOf(pl.planReview, ['off', 'auto', 'always'] as const, d.pipeline.planReview),
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
  const legacySrc = (withRoles as any).legacy;
  if (legacySrc && typeof legacySrc === 'object' && !Array.isArray(legacySrc)) for (const [k, v] of Object.entries(legacySrc as Record<string, unknown>)) if (!BAD.has(k)) legacy[k] = v;
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
  atomicWriteFile(paths.config(), JSON.stringify({ ...(extra ?? {}), ...known }, null, 2) + '\n', 0o600, { durable: true });
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
    // compat layer (the dashboard still speaks stages/onClaudeLimit): derived from roles
    onClaudeLimit: cursorFollowsClaude(cfg.roles.planning.providers) ? 'cursor' : 'wait',
    noGates: cfg.pipeline.noGates,
    stages: {
      plan: firstReadOnlyProvider(cfg.roles.planning.providers),
      review: firstReadOnlyProvider(cfg.roles.review.providers),
      verify: firstReadOnlyProvider(cfg.roles.verification.providers),
    },
  };
}

const isReadOnlyChoice = (x: unknown): x is 'claude' | 'cursor' => x === 'claude' || x === 'cursor';

/**
 * Map the dashboard's `stages.*` value back onto a chain: ONLY the first claude|cursor slot changes; every other entry (e.g. a
 * Codex entry) stays where it is. Duplicates are removed afterwards (the first occurrence wins).
 */
function setFirstReadOnlySlot(chain: readonly ProviderId[], to: 'claude' | 'cursor'): ProviderId[] {
  const i = chain.findIndex((p) => p === 'claude' || p === 'cursor');
  const next = [...chain];
  if (i < 0) next.unshift(to);
  else next[i] = to;
  return next.filter((p, k) => next.indexOf(p) === k);
}
/** `onClaudeLimit: 'cursor'` ⇒ a Cursor follows Claude (appended when missing); `'wait'` ⇒ no Cursor follows a Claude. Other entries are untouched. */
function setCursorFallback(chain: readonly ProviderId[], on: boolean): ProviderId[] {
  const c = chain.indexOf('claude');
  if (c < 0) return [...chain];
  if (on) return cursorFollowsClaude(chain) ? [...chain] : [...chain.filter((p) => p !== 'cursor'), 'cursor'];
  return chain.filter((p, k) => !(p === 'cursor' && k > c));
}

/** Apply a (partial, untrusted) settings patch; unknown keys are ignored; values are clamped. */
export function applySettings(cfg: Config, patch: Partial<Settings>): Config {
  const next = deepClone(cfg);
  const roles: Roles = next.roles;
  const st = patch.stages && typeof patch.stages === 'object' ? (patch.stages as Record<string, unknown>) : {};
  if (isReadOnlyChoice(st.plan)) roles.planning.providers = setFirstReadOnlySlot(roles.planning.providers, st.plan);
  if (isReadOnlyChoice(st.review)) roles.review.providers = setFirstReadOnlySlot(roles.review.providers, st.review);
  if (isReadOnlyChoice(st.verify)) roles.verification.providers = setFirstReadOnlySlot(roles.verification.providers, st.verify);
  if (patch.onClaudeLimit === 'cursor' || patch.onClaudeLimit === 'wait') {
    for (const r of ['planning', 'review', 'verification'] as const) roles[r].providers = setCursorFallback(roles[r].providers, patch.onClaudeLimit === 'cursor');
  }
  return normalizeConfig({
    ...next,
    roles,
    pipeline: {
      ...next.pipeline,
      ...(patch.planApproval !== undefined ? { planApproval: patch.planApproval } : {}),
      ...(patch.planReview !== undefined ? { planReview: patch.planReview } : {}),
      ...(patch.maxLoops !== undefined ? { maxLoops: patch.maxLoops } : {}),
      ...(patch.maxParallel !== undefined ? { maxParallel: patch.maxParallel } : {}),
      ...(patch.noGates !== undefined ? { noGates: patch.noGates } : {}),
    },
  });
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
  atomicWriteFile(paths.state(), JSON.stringify({ ...s, schemaVersion: STATE_SPEC.current }, null, 2) + '\n', 0o600, { durable: true });
}
