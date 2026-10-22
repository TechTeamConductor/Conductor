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
import { redact } from '../redact.ts';
import { selectionForTool, type ResolvedSel } from '../models/select.ts';
import type { CatalogView } from '../models/types.ts';
import type { LimitRule } from '../accounts/limit-rule.ts';
import { DEFAULT_ACCOUNT, type AccountRef } from '../accounts/types.ts';

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
  /** Multiply the wall-clock limit (code research). */
  timeoutFactor?: number;
  /** Plan complexity once known (drives `autoByComplexity`, post-plan roles only). */
  complexity?: Complexity;
  /** Provider health/pause/capability snapshot (the engine builds it). */
  states: States;
  /** Called when a candidate hits a usage limit — even when the chain advances — so the engine records the pause. */
  onLimit?: (info: LimitInfo) => void;
  /**
   * M8-2: the role whose model/effort selection applies (defaults to `role`). Selection ONLY — it never changes the route, candidates,
   * profile, tools, init predicate, turns, timeouts, cwd or env (M8-6 Security S2). Set from code constants only.
   */
  selRole?: Role;
  /** M8-6 (Security S3): NARROWING-ONLY filter over `route()`'s candidates — it never adds a provider. Empty after filtering ⇒ zero spawns. */
  onlyProviders?: readonly ProviderId[];
  /**
   * M8-2 N4: server-only — run on each tool's DEFAULT model (no role effort). Model selection only, under the same S3 discipline as
   * `selRole`; wins over `selRole` when both are set (R2-N1).
   */
  toolDefaultOnly?: true;
  /** M8-3 (C1): REQUIRED — the caller passes `effectiveLimitRule(cfg)`; no silent default at the call boundary (code review B1). */
  rule: LimitRule;
  /** M8-3: called as each (tool, account) attempt starts — the engine records the run's account (removal ⇒ restart). */
  onCandidate?: (ref: AccountRef) => void;
}
/** One move inside a call (B3a): every limit/auth/spawn hop, in order. */
export interface Hop {
  from: AccountRef;
  to: AccountRef;
  kind: 'limit' | 'auth' | 'spawn';
}
export type AgentOutcome = AgentResult & {
  agent: ProviderId;
  /** M8-3: the account that produced this result. */
  account?: string;
  fellBack?: boolean;
  /** the chain head this stage should have run on, when `fellBack` */
  from?: ProviderId;
  /** M8-3 (B3a): hops made inside this call. */
  hops?: Hop[];
  /** M8-3: how the first candidate differs from the head's first account, and why (N5: the real skip reason). */
  moved?: { kind: 'account' | 'tool'; reason?: string; note: string };
};

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
  private catalog: (tool: ProviderId, account?: string) => CatalogView | null;
  private onUnknownModel: (tool: ProviderId, account?: string) => void;

  /**
   * `catalog` (M8-2): the synchronous, memory-only model view per tool (runtime wires ModelService.view); default none ⇒ tool defaults.
   * `onUnknownModel`: called when a run with an explicit --model failed and the CLI itself said the model is unknown (S10).
   */
  constructor(getConfig: () => Config, opts: { clock?: Clock; extraEnv?: Record<string, string>; catalog?: (tool: ProviderId, account?: string) => CatalogView | null; onUnknownModel?: (tool: ProviderId, account?: string) => void } = {}) {
    this.getConfig = getConfig;
    this.clock = opts.clock ?? systemClock;
    this.extraEnv = opts.extraEnv ?? {};
    this.catalog = opts.catalog ?? (() => null);
    this.onUnknownModel = opts.onUnknownModel ?? (() => undefined);
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

  /** M8-2: wire model discovery after construction (the runtime builds the ModelService after the Agents). */
  attachModels(o: { catalog: (tool: ProviderId, account?: string) => CatalogView | null; onUnknownModel: (tool: ProviderId, account?: string) => void }): void {
    this.catalog = o.catalog;
    this.onUnknownModel = o.onUnknownModel;
  }

  /** M8-2: what `tool` runs with for `role` (the B2 binding rule, re-validated against the current catalog at every call). */
  selectionFor(role: Role, tool: ProviderId, opts: { toolDefaultOnly?: boolean; account?: string } = {}): ResolvedSel {
    return selectionForTool(role, tool, this.getConfig(), this.catalogOf(tool, opts.account), { toolDefaultOnly: opts.toolDefaultOnly });
  }

  /** M8-3: the target ACCOUNT's model view (M8-1 per-account cache); `default` ⇒ exactly today's call. */
  catalogOf(tool: ProviderId, account: string = DEFAULT_ACCOUNT): CatalogView | null {
    try {
      return account === DEFAULT_ACCOUNT ? this.catalog(tool) : this.catalog(tool, account);
    } catch {
      return null; // a broken catalog source never blocks a run: tool defaults
    }
  }

  /** "Claude" while the tool has its single main sign-in (today's wording); "Claude · Work" once it has several (labels only, S12). */
  accountLabel(tool: ProviderId, account: string = DEFAULT_ACCOUNT): string {
    const list = this.getConfig().accounts?.[tool] ?? [];
    const enabled = tool === 'codex' ? list.filter((a) => a.id === DEFAULT_ACCOUNT) : list;
    const meta = list.find((a) => a.id === account);
    if (account === DEFAULT_ACCOUNT && enabled.length <= 1) return providerLabel(tool);
    return `${providerLabel(tool)} · ${meta?.name ?? account}`;
  }

  /** M8-2 S10: a run that carried a --model the CLI rejected asks discovery (rate-limited there) for a fresh list. */
  noteRunResult(tool: ProviderId, sel: ResolvedSel | undefined, res: AgentResult, account: string = DEFAULT_ACCOUNT): void {
    if (res.cliRejectedModel === true && sel?.modelArg !== undefined) {
      try {
        if (account === DEFAULT_ACCOUNT) this.onUnknownModel(tool);
        else this.onUnknownModel(tool, account);
      } catch {
        /* never fails a run */
      }
    }
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
    const r = route({ role: req.role, complexity: req.complexity, roles: cfg.roles, states: req.states, now: this.clock.now(), label: providerLabel, rule: req.rule });
    if (!r.ok) {
      const none = { text: '', exitCode: null, agent: head } as const;
      if (r.kind === 'paused') return { ok: false, ...none, agent: r.provider, account: r.account, errorKind: 'limit', error: r.reason, limit: { provider: r.provider, account: r.account, resetsAt: r.pauseUntil, message: r.reason } };
      return { ok: false, ...none, errorKind: 'spawn', error: r.reason };
    }
    if (req.onlyProviders) {
      const only = req.onlyProviders;
      r.candidates = r.candidates.filter((c) => only.includes(c.id));
      if (!r.candidates.length) return { ok: false, text: '', exitCode: null, agent: head, errorKind: 'spawn', error: `This step can only run on ${only.map((id) => providerLabel(id)).join(' or ')}, and none of them is available for it.` };
    }
    const hops: Hop[] = [];
    let moved: AgentOutcome['moved'];
    const headFirst = (cfg.accounts?.[head] ?? [])[0]?.id ?? DEFAULT_ACCOUNT;
    for (let i = 0; i < r.candidates.length; i++) {
      const cand = r.candidates[i]!;
      const provider = this.providers[cand.id];
      const who = this.accountLabel(cand.id, cand.account);
      if (i === 0 && cand.id !== head) {
        // M8-6 m4: a head filtered out by `onlyProviders` is not "unavailable" — say why this step runs where it does
        const sk = r.skipped.find((s) => s.id === head);
        const why = req.onlyProviders && !req.onlyProviders.includes(head) ? `This step runs on ${req.onlyProviders.map((id) => providerLabel(id)).join(' or ')} only` : sk?.why ?? `${providerLabel(head)} is unavailable`;
        const text = `${why} — ${who} is doing this read-only step${tierNote(cand.tier)}.`;
        req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text });
        moved = { kind: 'tool', reason: sk?.kind, note: text };
      } else if (i === 0 && cand.moved === 'account') {
        const sk = r.skipped.find((s) => s.id === head && s.account === headFirst);
        const text = `${sk?.why ?? `${this.accountLabel(head, headFirst)} is unavailable`} — ${who} is doing this step.`;
        req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text });
        moved = { kind: 'account', reason: sk?.kind, note: text };
      }
      // M8-2 (S3): `selRole`/`toolDefaultOnly` pick the model/effort ONLY — route, gates, candidates, provider method, profile, turns and the
      // init check above and below all key off `req.role`. M8-3: the selection is resolved against THIS account's model list.
      const sel = this.selectionFor(req.selRole ?? req.role, cand.id, { toolDefaultOnly: req.toolDefaultOnly === true, account: cand.account });
      for (const n of sel.notes) req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text: redact(n, req.secrets ?? []) });
      const ref: AccountRef = { provider: cand.id, id: cand.account };
      req.onCandidate?.(ref);
      const res = await provider.runReadOnly!({ stage: req.stage, cwd: req.cwd, prompt, schema: req.schema, name: req.name, onEvent: req.onEvent, signal: req.signal, secrets: req.secrets, maxTurnsFactor: req.maxTurnsFactor, ...(req.timeoutFactor ? { timeoutFactor: req.timeoutFactor } : {}), sel, ...(cand.account !== DEFAULT_ACCOUNT ? { account: ref } : {}) });
      this.noteRunResult(cand.id, sel, res, cand.account);
      const nextCand = r.candidates[i + 1];
      // mid-call rule (§2.2 step 3): a LIMIT advances only to a candidate whose crossOnLimit is true; spawn/auth advance as today
      const blocked = res.errorKind === 'limit' && nextCand !== undefined && !nextCand.crossOnLimit;
      const fellBack = i > 0 || cand.id !== head;
      const out = (): AgentOutcome => ({ ...res, agent: cand.id, account: cand.account, fellBack, from: fellBack ? head : undefined, hops, ...(moved ? { moved } : {}), ...(res.errorKind === 'limit' ? { limit: { ...(res.limit ?? { resetsAt: null, message: res.error ?? 'limit' }), provider: cand.id, account: cand.account } } : {}) });
      if (res.ok || !nextCand || !advances(res.errorKind) || blocked) return out();
      // the chain moves on: remember the pause on THIS account now (a final limit is recorded by the caller's pause path instead)
      if (res.errorKind === 'limit') req.onLimit?.({ ...(res.limit ?? { resetsAt: null, message: res.error ?? 'limit' }), provider: cand.id, account: cand.account });
      hops.push({ from: ref, to: { provider: nextCand.id, id: nextCand.account }, kind: res.errorKind as Hop['kind'] });
      const nextWho = this.accountLabel(nextCand.id, nextCand.account);
      if (nextCand.id === cand.id) {
        const what = res.errorKind === 'limit' ? 'reached its usage limit' : res.errorKind === 'auth' ? 'is not signed in' : 'could not start';
        req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text: `${who} ${what} — continuing on ${nextWho}.` });
      } else {
        const what = res.errorKind === 'limit' ? 'usage limit reached' : res.errorKind === 'auth' ? 'is not signed in' : 'could not start';
        req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text: `${who} ${what} — falling back to ${nextWho} (read-only${tierNote(nextCand.tier)}) for this stage.` });
      }
    }
    /* unreachable: the loop always returns on the last candidate */
    return { ok: false, text: '', exitCode: null, errorKind: 'spawn', error: 'no provider ran', agent: head };
  }
}

/** A visible reminder when the stage runs on a provider with a weaker read-only isolation than Claude's fail-closed lock-down. */
function tierNote(tier: string): string {
  return tier === 'partial' ? ' — ask mode, without Claude\'s tool lock-down' : tier === 'unverified' ? ' — isolation not verified' : '';
}
