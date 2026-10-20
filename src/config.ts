import { chmodSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import type { Config, RepoConfig, Settings } from './types.ts';
import { paths, ensureHome } from './paths.ts';
import { atomicWriteFile, deepClone, readJsonFile } from './util.ts';

export function defaultConfig(): Config {
  return {
    version: 1,
    ui: { port: 4317, openBrowser: true },
    linear: {
      mode: 'labels',
      triggerLabel: 'conductor',
      pollSeconds: 30,
      pickupFromBacklog: false,
      allowAssignedToMe: false,
    },
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
      planApproval: 'first',
      planReview: 'auto',
      onClaudeLimit: 'wait',
      failOn: ['blocker', 'major'],
      noGates: 'warn',
      timeoutsMin: { plan: 20, review: 10, build: 90, verify: 30, idle: 10, gate: 15 },
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
  const lin = (i.linear ?? {}) as Partial<Config['linear']>;
  const ag = (i.agents ?? {}) as any;
  const pl = (i.pipeline ?? {}) as any;
  const st = (i.stages ?? {}) as any;
  const to = (pl.timeoutsMin ?? {}) as any;
  const cfg: Config = {
    version: 1,
    ui: {
      port: clamp(i.ui?.port, 1024, 65535, d.ui.port),
      openBrowser: i.ui?.openBrowser !== false,
    },
    linear: {
      teamId: typeof lin.teamId === 'string' ? lin.teamId : undefined,
      teamKey: typeof lin.teamKey === 'string' ? lin.teamKey : undefined,
      mode: oneOf(lin.mode, ['labels', 'states'] as const, d.linear.mode),
      triggerLabel: typeof lin.triggerLabel === 'string' && lin.triggerLabel.trim() ? lin.triggerLabel.trim() : d.linear.triggerLabel,
      pollSeconds: clamp(lin.pollSeconds, 15, 600, d.linear.pollSeconds),
      pickupFromBacklog: lin.pickupFromBacklog === true,
      allowAssignedToMe: lin.allowAssignedToMe === true,
      viewerId: typeof lin.viewerId === 'string' ? lin.viewerId : undefined,
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
  if (!cfg.pipeline.failOn.length) cfg.pipeline.failOn = d.pipeline.failOn;
  return cfg;
}

function validRepo(r: unknown): boolean {
  const x = r as RepoConfig;
  return !!x && typeof x.name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(x.name) && typeof x.path === 'string' && x.path.startsWith('/');
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

export function loadConfig(): Config {
  return normalizeConfig(readJsonFile<unknown>(paths.config(), {}));
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  atomicWriteFile(paths.config(), JSON.stringify(cfg, null, 2) + '\n', 0o600);
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
    pickupFromBacklog: cfg.linear.pickupFromBacklog,
    stages: { ...cfg.stages },
    linearMode: cfg.linear.mode,
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
    linear: {
      ...next.linear,
      ...(patch.pickupFromBacklog !== undefined ? { pickupFromBacklog: patch.pickupFromBacklog } : {}),
      ...(patch.linearMode !== undefined ? { mode: patch.linearMode } : {}),
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
export function loadState(): PersistentState {
  const s = readJsonFile<Partial<PersistentState>>(paths.state(), {});
  return { repos: s.repos && typeof s.repos === 'object' ? s.repos : {} };
}
export function saveState(s: PersistentState): void {
  ensureHome();
  atomicWriteFile(paths.state(), JSON.stringify(s, null, 2) + '\n', 0o600);
}
