import type { AgentResult, Config, LimitInfo, StageName } from '../types.ts';
import { resolveBin } from '../config.ts';
import type { Clock } from '../util.ts';
import { systemClock } from '../util.ts';
import { claudeEnv, cursorEnv } from './env.ts';
import { describeSchema, type Schema } from './json.ts';
import type { EmitEvent } from './claude.ts';
import { runProcess } from './spawn.ts';
import { createProviders, mutatedProviderForTests, providerLabel } from './providers/registry.ts';
import type { Provider, ProviderId } from './providers/types.ts';
import type { Complexity, Role } from './roles.ts';
import { advances, route, type States } from './routing.ts';

export interface ReadOnlyReq {
  /** Which job this is — the router resolves the provider chain from the configured roles. */
  role: Role;
  stage: Extract<StageName, 'plan' | 'plan_review' | 'verify'>;
  cwd: string;
  prompt: string;
  schema: Schema;
  name: string; // session display name, e.g. "conductor ENG-12 plan"
  onEvent: (ev: EmitEvent) => void;
  signal?: AbortSignal;
  secrets?: string[];
  /** Multiply the Claude --max-turns cap (retry after error_max_turns). */
  maxTurnsFactor?: number;
  /** Plan complexity once known (drives `autoByComplexity`, post-plan roles only). */
  complexity?: Complexity;
  /** Provider health/pause/capability snapshot (the engine builds it). */
  states: States;
  /** Called when a candidate hits a usage limit — even when the chain advances — so the engine records the pause. */
  onLimit?: (info: LimitInfo) => void;
}
export type AgentOutcome = AgentResult & { agent: ProviderId; fellBack?: boolean; /** the chain head this stage should have run on, when `fellBack` */ from?: ProviderId };

/** Appended to read-only prompts: works for every provider, and is the Claude fallback when structured_output is absent. */
export function jsonInstruction(schema: Schema): string {
  return [
    '',
    '## Required output format',
    'Reply with ONLY one fenced ```json code block holding a single JSON object — no prose before or after the block. Fields:',
    describeSchema(schema),
  ].join('\n');
}

const minutes = (n: number) => n * 60_000;

export class Agents {
  private getConfig: () => Config;
  private clock: Clock;
  private versions = new Map<string, Promise<string>>();
  private extraEnv: Record<string, string>;
  private providers: Record<ProviderId, Provider>;

  constructor(getConfig: () => Config, opts: { clock?: Clock; extraEnv?: Record<string, string> } = {}) {
    this.getConfig = getConfig;
    this.clock = opts.clock ?? systemClock;
    this.extraEnv = opts.extraEnv ?? {};
    this.providers = createProviders({ getConfig, clock: this.clock, extraEnv: this.extraEnv });
  }

  /** A registry provider (sealed). Builds are started only by pipeline/envelope.ts (static test) — not through this class. */
  provider(id: ProviderId): Provider {
    return this.providers[id];
  }

  /** TEST SEAM: replace a provider with a sealed, edited copy (throws outside a test run). */
  _testMutate(id: ProviderId, mutate: (draft: Provider) => void): void {
    this.providers = { ...this.providers, [id]: mutatedProviderForTests(this.providers[id], mutate) };
  }

  /** `<bin> --version`, cached per binary. */
  cliVersion(agent: ProviderId): Promise<string> {
    const cfg = this.getConfig();
    const bin = resolveBin(agent === 'claude' ? cfg.agents.claude.bin : cfg.agents.cursor.bin);
    if (!bin) return Promise.resolve('not found');
    let p = this.versions.get(bin);
    if (!p) {
      p = runProcess({
        bin,
        args: ['--version'],
        cwd: process.cwd(),
        env: agent === 'claude' ? claudeEnv() : cursorEnv(),
        idleMs: 15_000,
        hardMs: 15_000,
      }).then((r) => (r.stdoutTail.trim().split('\n')[0] ?? '').slice(0, 80) || 'unknown');
      this.versions.set(bin, p);
    }
    return p;
  }

  /**
   * One read-only stage: resolve the provider chain for the role (pure routing), run the first candidate and advance ONLY on
   * limit / spawn / auth errors (never on an isolation failure), with a visible note at every hop.
   */
  async readOnly(req: ReadOnlyReq): Promise<AgentOutcome> {
    const cfg = this.getConfig();
    const prompt = req.prompt + '\n' + jsonInstruction(req.schema);
    const head: ProviderId = cfg.roles[req.role].providers[0] ?? 'claude';
    const r = route({ role: req.role, complexity: req.complexity, roles: cfg.roles, states: req.states, now: this.clock.now(), label: providerLabel });
    if (!r.ok) {
      const none = { text: '', exitCode: null, agent: head } as const;
      if (r.kind === 'paused') return { ok: false, ...none, agent: r.provider, errorKind: 'limit', error: r.reason, limit: { provider: r.provider, resetsAt: r.pauseUntil, message: r.reason } };
      return { ok: false, ...none, errorKind: 'spawn', error: r.reason };
    }
    for (let i = 0; i < r.candidates.length; i++) {
      const cand = r.candidates[i]!;
      const provider = this.providers[cand.id];
      if (i === 0 && cand.id !== head) {
        const why = r.skipped.find((s) => s.id === head)?.why ?? `${providerLabel(head)} is unavailable`;
        req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text: `${why} — ${provider.label} is doing this read-only step${tierNote(cand.tier)}.` });
      }
      const res = await provider.runReadOnly!({ stage: req.stage, cwd: req.cwd, prompt, schema: req.schema, name: req.name, onEvent: req.onEvent, signal: req.signal, secrets: req.secrets, maxTurnsFactor: req.maxTurnsFactor });
      const last = i === r.candidates.length - 1;
      if (res.ok || last || !advances(res.errorKind)) return { ...res, agent: cand.id, fellBack: i > 0 || cand.id !== head, from: i > 0 || cand.id !== head ? head : undefined };
      if (res.errorKind === 'limit') req.onLimit?.(res.limit ?? { provider: cand.id, resetsAt: null, message: res.error ?? 'limit' });
      const next = this.providers[r.candidates[i + 1]!.id];
      const what = res.errorKind === 'limit' ? 'usage limit reached' : res.errorKind === 'auth' ? 'is not signed in' : 'could not start';
      req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text: `${provider.label} ${what} — falling back to ${next.label} (read-only${tierNote(r.candidates[i + 1]!.tier)}) for this stage.` });
    }
    /* unreachable: the loop always returns on the last candidate */
    return { ok: false, text: '', exitCode: null, errorKind: 'spawn', error: 'no provider ran', agent: head };
  }
}

/** A visible reminder when the stage runs on a provider with a weaker read-only isolation than Claude's fail-closed lock-down. */
function tierNote(tier: string): string {
  return tier === 'partial' ? ' — ask mode, without Claude\'s tool lock-down' : tier === 'unverified' ? ' — isolation not verified' : '';
}
