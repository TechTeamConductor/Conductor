// Quick Ask (M5): a question about a project answered from a read-only SNAPSHOT of its base branch, in one agent call. Fails fast (never
// queued, never auto-retried); results are untrusted data stored in the ask record. Limits: asks per hour (persisted accounting module),
// at most two running at once.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agents } from '../agents/provider.ts';
import { callAgent } from '../agents/caller.ts';
import { validateSchema } from '../agents/json.ts';
import type { States } from '../agents/routing.ts';
import { providerLabel } from '../agents/providers/registry.ts';
import type { Config, RepoConfig } from '../types.ts';
import { GitReader } from '../context/gitread.ts';
import { liveFacts } from '../context/live.ts';
import { buildPack } from '../context/pack.ts';
import { refund, take, takeKeyed, type CounterId } from '../limits/budget.ts';
import { advances, route } from '../agents/routing.ts';
import type { Role } from '../agents/roles.ts';
import { effectiveLimitRule, type LimitRule } from '../accounts/limit-rule.ts';
import { DEFAULT_ACCOUNT, accountKey, type AccountRef } from '../accounts/types.ts';
import type { AgentResult } from '../types.ts';
import { redact } from '../redact.ts';
import { ASK_SCHEMA } from '../pipeline/schemas.ts';
import { fence, loadTemplate, preamble, render } from '../pipeline/prompts.ts';
import { errMsg, truncate } from '../util.ts';
import { cleanCommand } from '../context/facts.ts';
import { logger } from '../log.ts';
import { ASK_ID_RE, ASK_LIMITS, HISTORY_LIMITS, deleteAsk, loadAsk, listAsks, newAskId, saveAsk, validateAsk, type AskRecord } from './store.ts';
import { RESEARCH_SCHEMA, buildReport } from './research.ts';
import { renderResearchBrief, shapeResearchBrief } from '../briefs/schemas.ts';
import type { ResearchBrief, ResearchCardView } from '../briefs/types.ts';
import { sanitizeLine } from '../pipeline/graph.ts';

/** S6a: the research-brief fence, from the stored shaped record only (exported so a test can compare it byte for byte). */
export const researchBriefFence = (b: ResearchBrief): string => fence('research-brief', renderResearchBrief(b), 12_000);
import { buildSnapshot, removeSnapshot, SnapshotTooLarge } from './snapshot.ts';

const log = logger('asks');
export class AskError extends Error {
  code: string;
  status: number;
  /** M8-3: allow-listed extra response fields (`retryAt` only). */
  extra?: { retryAt: number | null };
  constructor(code: string, message: string, status = 400, extra?: { retryAt: number | null }) {
    super(message);
    this.code = code;
    this.status = status;
    if (extra) this.extra = { retryAt: extra.retryAt };
  }
}
const MAX_CONCURRENT = 2;

export interface AskDeps {
  getConfig: () => Config;
  agents: Agents;
  routeStates: (role?: Role) => States;
  freshHealth: () => Promise<void>;
  secrets?: () => string[];
  now?: () => number;
  /** M8-3: Home never queues — the engine's pure route over current states (`paused` ⇒ 409 limited + retryAt, BEFORE any counter). */
  accountsGate?: (role: Role) => { ok: true } | { ok: false; kind: 'paused' | 'ineligible'; retryAt: number | null; reason: string };
  /** M8-3 (C1): `effectiveLimitRule(cfg)`. */
  limitRule?: () => LimitRule;
  /** M8-3: record a usage-limit pause on the account a research hop left. */
  accountPause?: (ref: AccountRef, until: number, reason: string) => void;
  /** M8-3 (B3a): one notify per research limit episode (no board comment — research is not a card). */
  notify?: (title: string, message: string) => void;
  /** Creates a board card for a repository with a SERVER-assigned actor (never from a request body). */
  /** True when a fast-path run of this repository is still in progress (at most one at a time). */
  fastPathBusy?: (repo: string) => boolean;
  /** The connectivity probe (Deep Research needs the internet). */
  networkState?: () => Promise<'online' | 'offline' | 'unknown'>;
  cards?: { create(i: { repo: string; title: string; description: string; actor: 'user-ask' | 'ask-convert' | 'research'; idemKey: string }): { key: string } };
}

export class AskService {
  private d: AskDeps;
  private running = new Map<string, { ac: AbortController; promise: Promise<void>; account?: string }>();
  /** Write generation + scan counter for the research projection cache (N8; the counter is read by a test). */
  private gen = 0;
  scans = 0;
  private projection: { gen: number; cards: ResearchCardView[] } | null = null;
  constructor(deps: AskDeps) {
    this.d = deps;
  }
  /** The earlier answered quick asks this one may continue, newest first: walks the `follow` chain with a visited set and a depth limit and stops at the first unusable record. */
  private historyPairs(follow: string | undefined, repoName: string | undefined): { question: string; answer: string; basis: string }[] {
    const pairs: { question: string; answer: string; basis: string }[] = [];
    const seen = new Set<string>();
    let id = follow;
    while (id && pairs.length < HISTORY_LIMITS.pairs && !seen.has(id) && ASK_ID_RE.test(id)) {
      seen.add(id);
      const r = loadAsk(id);
      if (!r || r.mode !== 'quick' || r.status !== 'done' || !r.result || r.dismissedAt !== undefined || r.repo !== repoName) break;
      pairs.push({ question: r.question, answer: r.result.answer, basis: r.basis ?? '' });
      id = r.follow;
    }
    return pairs;
  }

  /** The fenced history block: one JSON object per line (so no earlier text can fake a turn), capped per item and in total, redacted, assembled once. */
  private historyBlock(pairs: { question: string; answer: string; basis: string }[], secrets: readonly string[]): string {
    const kept: string[] = [];
    let total = 0;
    for (const p of pairs) {
      // redact each field BEFORE it is JSON-escaped (a secret containing a quote, backslash or newline would not match its escaped form)
      const item = { question: redact(truncate(p.question, HISTORY_LIMITS.question), secrets), answer: redact(truncate(p.answer, HISTORY_LIMITS.answer), secrets), basis: redact(truncate(p.basis, HISTORY_LIMITS.basis), secrets) };
      let line = JSON.stringify(item);
      // even the newest pair stays inside the total budget (JSON escaping can inflate it): shrink its answer until it fits
      for (let guard = 0; line.length > HISTORY_LIMITS.total && guard < 10; guard++) {
        item.answer = truncate(item.answer, Math.max(100, item.answer.length - (line.length - HISTORY_LIMITS.total) - 20));
        line = JSON.stringify(item);
      }
      if (kept.length && total + line.length > HISTORY_LIMITS.total) break;
      kept.push(line);
      total += line.length;
    }
    const chronological = kept.reverse().map((line, i) => `{"turn":${i + 1},${line.slice(1)}`);
    return fence('earlier-conversation', redact(chronological.join('\n'), secrets), HISTORY_LIMITS.total + 400);
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Validate, count, record, and start. Returns the new record at once; the answer arrives later. */
  start(input: { question: unknown; repo?: unknown; allowChange?: unknown; follow?: unknown }): AskRecord {
    const q = typeof input.question === 'string' ? input.question.trim() : '';
    if (!q) throw new AskError('bad_request', '"question" is required.');
    if (q.length > ASK_LIMITS.question) throw new AskError('bad_request', `"question" is too long (max ${ASK_LIMITS.question} characters).`);
    const cfg = this.d.getConfig();
    let repo: RepoConfig | undefined;
    if (input.repo !== undefined && input.repo !== '') {
      if (typeof input.repo !== 'string') throw new AskError('bad_request', '"repo" must be a registered repository name.');
      repo = cfg.repos.find((r) => r.name === input.repo);
      if (!repo) throw new AskError('bad_request', 'Unknown repository.');
    } else if (cfg.repos.length === 1) repo = cfg.repos[0];
    // A follow-up: validate the id first, then look the earlier asks up in OUR store (never trust client-supplied history text).
    // An unusable `follow` (missing, deleted, another repository, not an answered quick ask) never fails the ask: it just has no history.
    let follow: string | undefined;
    let historyCount = 0;
    if (input.follow !== undefined && input.follow !== '') {
      if (typeof input.follow !== 'string' || !ASK_ID_RE.test(input.follow)) throw new AskError('bad_request', '"follow" must be the id of an earlier question.');
      const pairs = this.historyPairs(input.follow, repo?.name);
      if (pairs.length) { follow = input.follow; historyCount = pairs.length; }
    }
    if (cfg.agents.claude.isolation !== 'safe-mode') throw new AskError('isolation', 'Quick Ask needs Claude\'s safe-mode isolation (project settings and hooks would be loaded from the snapshot otherwise).', 409);
    if (this.running.size >= MAX_CONCURRENT) throw new AskError('busy', 'Two questions are already being answered — try again in a moment.', 429);
    this.gate('context'); // M8-3: BEFORE the counter (no record, no counter on 409 limited)
    const t = takeKeyed('asksPerHour', cfg.pipeline.asksPerHour, { now: this.now() });
    if (!t.ok) throw new AskError('limit', `You reached the limit of ${cfg.pipeline.asksPerHour} questions per hour.`, 429);
    const rec: AskRecord = { schemaVersion: 1, id: newAskId(), mode: 'quick', repo: repo?.name, question: q, createdAt: this.now(), updatedAt: this.now(), status: 'running', events: input.follow !== undefined && input.follow !== '' && !follow ? ['Earlier context was not available, so this question was answered on its own.'] : [], ...(follow ? { follow, historyCount } : {}), allowChange: input.allowChange === true, takenKey: t.key };
    this.save(rec);
    const ac = new AbortController();
    const promise = this.run(rec.id, repo, ac).catch((e) => log.warn(`${rec.id}: ${errMsg(e)}`)).finally(() => void this.running.delete(rec.id));
    this.running.set(rec.id, { ac, promise });
    return rec;
  }

  /** Deep Research: web-only Claude session in an empty scratch directory; asks fail fast like Quick Ask. (The HTTP shape is unchanged.) */
  async startResearch(input: { question: unknown; repo?: unknown }): Promise<AskRecord> {
    return this.beginResearch(input, {});
  }

  /**
   * M8-6 F4 (N2): research started from a REVIEWED, stored brief. Only `BriefService` calls this, with the re-validated stored record —
   * the HTTP handler cannot reach it (static test), and `/api/ask` rejects `brief`/`depth`/`briefId`. The brief is re-shaped here once more.
   */
  async startResearchFromBrief(input: { question: string; repo?: string | null; brief: ResearchBrief; depth: 'standard' | 'deep'; briefId: string }): Promise<AskRecord> {
    const brief = shapeResearchBrief(input.brief);
    if (!brief || !/^brf-[0-9a-f]{16}$/.test(input.briefId)) throw new AskError('bad_request', 'That research brief is not valid.');
    return this.beginResearch({ question: input.question, repo: input.repo ?? undefined }, { brief, depth: input.depth === 'deep' ? 'deep' : 'standard', briefId: input.briefId });
  }

  /** The ask a brief started (B2d adoption on replay/boot), if any. */
  findByBriefId(briefId: string): AskRecord | null {
    if (!/^brf-[0-9a-f]{16}$/.test(briefId)) return null;
    return this.allAsks().find((r) => r.briefId === briefId) ?? null;
  }

  private async beginResearch(input: { question: unknown; repo?: unknown }, extra: { brief?: ResearchBrief; depth?: 'standard' | 'deep'; briefId?: string }): Promise<AskRecord> {
    const q = typeof input.question === 'string' ? input.question.trim() : '';
    if (!q) throw new AskError('bad_request', '"question" is required.');
    if (q.length > ASK_LIMITS.question) throw new AskError('bad_request', `"question" is too long (max ${ASK_LIMITS.question} characters).`);
    const cfg = this.d.getConfig();
    let repo: string | undefined;
    if (input.repo !== undefined && input.repo !== '') {
      if (typeof input.repo !== 'string' || !cfg.repos.some((r) => r.name === input.repo)) throw new AskError('bad_request', 'Unknown repository.');
      repo = input.repo;
    }
    if (cfg.agents.claude.isolation !== 'safe-mode') throw new AskError('isolation', "Deep Research needs Claude's safe-mode isolation.", 409);
    if ((await this.d.networkState?.()) === 'offline') throw new AskError('offline', 'Deep Research needs the internet, and there is no network right now. Quick Ask and your board still work offline.', 409);
    if ([...this.running.keys()].some((id) => loadAsk(id)?.mode === 'research')) throw new AskError('busy', 'A research run is already in progress.', 429);
    const n = extra.depth === 'deep' ? 2 : 1; // Q-B: Deep counts 2 against the daily cap
    this.gate('research'); // M8-3: the gate and the run use the same route (B2)
    const t = takeKeyed('researchPerDay', cfg.pipeline.researchPerDay, { now: this.now(), n });
    if (!t.ok) throw new AskError('limit', n === 2 ? `researchPerDay: Deep research counts 2 of today's ${cfg.pipeline.researchPerDay} research runs, and there is not enough left.` : `researchPerDay: you reached today's limit of ${cfg.pipeline.researchPerDay} research runs.`, 429);
    const rec: AskRecord = {
      schemaVersion: 1, id: newAskId(), mode: 'research', repo, question: q, createdAt: this.now(), updatedAt: this.now(), status: 'running', events: [], basis: 'web research (no repository access)', takenKey: t.key,
      ...(extra.brief ? { brief: extra.brief } : {}), ...(extra.depth === 'deep' ? { depth: 'deep' as const } : extra.brief ? { depth: 'standard' as const } : {}), ...(extra.briefId ? { briefId: extra.briefId } : {}),
    };
    this.save(rec); // the FIRST save carries briefId (B2d)
    const ac = new AbortController();
    const promise = this.runResearch(rec.id, ac).catch((e) => log.warn(`${rec.id}: ${errMsg(e)}`)).finally(() => void this.running.delete(rec.id));
    this.running.set(rec.id, { ac, promise });
    return rec;
  }

  /** C1: the injected rule source, else `effectiveLimitRule` of the current config — never a silent 'switch'. */
  private limitRule(): LimitRule {
    return this.d.limitRule ? this.d.limitRule() : effectiveLimitRule(this.d.getConfig());
  }
  /** M8-3: Home requests never queue — refused BEFORE a record or a counter when every account the role may use is at its limit. */
  private gate(role: Role): void {
    const g = this.d.accountsGate?.(role);
    if (g && !g.ok && g.kind === 'paused') throw new AskError('limited', `${truncate(g.reason, 300)} — try again after the limit resets.`, 409, { retryAt: g.retryAt });
  }
  /** The earliest time an account the role may use is free again (null = unknown). */
  private retryAt(role: Role, fallback: number | null): number | null {
    const g = this.d.accountsGate?.(role);
    return g && !g.ok && g.kind === 'paused' ? g.retryAt : fallback;
  }
  /** Mid-call exhaustion: `failed` + `limited` + `retryAt`, and the counter this ask took is refunded ONCE (S11). */
  private failLimited(id: string, counter: CounterId, n: number, why: string, retryAt: number | null, secrets: string[], events?: string[]): void {
    this.patch(id, (r) => {
      r.status = 'failed';
      r.error = truncate(redact(why, secrets), 500);
      r.errorKind = 'limited';
      if (retryAt !== null) r.retryAt = retryAt;
      if (events) r.events = events;
      if (r.takenKey && !r.refunded) {
        refund(counter, { key: r.takenKey, n });
        r.refunded = true;
      }
    });
  }
  private pauseFromLimit(ref: AccountRef, res: AgentResult): void {
    const now = this.now();
    const at = res.limit?.resetsAt;
    this.d.accountPause?.(ref, at && at > now ? at : now + 15 * 60_000, res.limit?.message ?? res.error ?? 'usage limit');
  }

  /**
   * M8-3 S8 step 2: abort every in-flight ask/research on a removed account; each ends `failed` "the account was removed", counter refunded.
   * Resolves once those calls have finished (their children were reaped, N3).
   */
  async abortAccount(ref: AccountRef): Promise<number> {
    const k = accountKey(ref);
    const hit = [...this.running.entries()].filter(([, v]) => v.account === k);
    for (const [id, v] of hit) {
      this.removedAccount.add(id);
      v.ac.abort();
    }
    await Promise.allSettled(hit.map(([, v]) => v.promise));
    return hit.length;
  }
  private removedAccount = new Set<string>();
  private endRemoved(id: string, counter: CounterId, n: number, events?: string[]): boolean {
    if (!this.removedAccount.delete(id)) return false;
    this.patch(id, (r) => {
      r.status = 'failed';
      r.error = 'The account this was running on was removed. Ask again to run it on another account.';
      if (events) r.events = events;
      if (r.takenKey && !r.refunded) {
        refund(counter, { key: r.takenKey, n });
        r.refunded = true;
      }
    });
    return true;
  }

  private async runResearch(id: string, ac: AbortController): Promise<void> {
    const secrets = this.d.secrets?.() ?? [];
    const scratch = mkdtempSync(join(tmpdir(), 'conductor-research-'));
    const n = loadAsk(id)?.depth === 'deep' ? 2 : 1;
    try {
      const rec = loadAsk(id)!;
      const claude = this.d.agents.provider('claude');
      if (!claude.runResearch) throw new Error('Claude is not available for research.');
      await this.d.freshHealth();
      const events: string[] = [];
      const push = (t: string) => { if (events.length < ASK_LIMITS.events) events.push(redact(t, secrets).replace(/\s+/g, ' ').slice(0, ASK_LIMITS.eventChars)); };
      // M8-3 (B2): research is ROUTED — only Claude passes the research gate, so the candidates are Claude accounts in order. A route that is
      // ineligible (e.g. research left out of the roles) keeps today's behaviour: Claude's main sign-in, exactly as before.
      const cfg = this.d.getConfig();
      const rt = route({ role: 'research', roles: cfg.roles, states: this.d.routeStates('research'), now: this.now(), label: providerLabel, rule: this.limitRule() });
      if (!rt.ok && rt.kind === 'paused') {
        this.failLimited(id, 'researchPerDay', n, `${truncate(rt.reason, 300)} — try again after the limit resets.`, rt.pauseUntil, secrets, events);
        return;
      }
      const today = [{ account: DEFAULT_ACCOUNT, crossOnLimit: true }];
      const routed = rt.ok ? rt.candidates.filter((c) => c.id === 'claude').map((c) => ({ account: c.account, crossOnLimit: c.crossOnLimit })) : [];
      const cands: { account: string; crossOnLimit: boolean }[] = routed.length ? routed : today;
      // S6a: the brief block is built ONLY from the stored, shaped record; Standard without a brief renders byte-identical to before M8-6
      const depth = rec.depth === 'deep' ? 'deep' : 'standard';
      const basePrompt = render(loadTemplate('research'), { preamble: preamble('plan'), question: fence('user-question', rec.question, ASK_LIMITS.question + 100), brief: rec.brief ? researchBriefFence(rec.brief) : '', deep: depth === 'deep' ? 'yes' : '' });
      let res: AgentResult = { ok: false, text: '', exitCode: null, errorKind: 'spawn', error: 'Research did not start.' };
      let errs: string[] = [];
      let modelBasis = '';
      let limitHops = 0;
      let firstLimited = '';
      let ranOn = '';
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i]!;
        const ref: AccountRef = { provider: 'claude', id: c.account };
        const who = this.d.agents.accountLabel('claude', c.account);
        const entry = this.running.get(id);
        if (entry) entry.account = accountKey(ref);
        // M8-2 (S11, B3a): the research row's model/effort — still Claude, still runResearch with the research profile; notes are visible
        const sel = this.d.agents.selectionFor('research', 'claude', { account: c.account });
        for (const note of sel.notes) push(`conductor: ${note}`);
        modelBasis = sel.fallback ? `; model: tool default (${sel.fallback.replace(/-/g, ' ')})` : '';
        const acct = c.account !== DEFAULT_ACCOUNT ? { account: ref } : {};
        let prompt = basePrompt;
        res = await claude.runResearch({ cwd: scratch, prompt, schema: RESEARCH_SCHEMA, name: `conductor research ${id}`, secrets, signal: ac.signal, sel, ...acct, ...(depth === 'deep' ? { depth } : {}), onEvent: (ev) => { if (ev.text && ev.kind !== 'thinking') push(`${ev.agent}: ${ev.text}`); } });
        this.d.agents.noteRunResult('claude', sel, res, c.account);
        errs = res.ok ? validateSchema(RESEARCH_SCHEMA, res.json) : [];
        if (res.ok && errs.length) {
          // the corrective re-ask stays on the account that answered
          prompt += `\n\n## Your previous reply was rejected\n${errs.slice(0, 6).map((e) => `- ${e}`).join('\n')}\nReturn a corrected JSON object.`;
          res = await claude.runResearch({ cwd: scratch, prompt, schema: RESEARCH_SCHEMA, name: `conductor research ${id}`, secrets, signal: ac.signal, sel, ...acct, ...(depth === 'deep' ? { depth } : {}), onEvent: () => undefined });
          this.d.agents.noteRunResult('claude', sel, res, c.account);
          errs = res.ok ? validateSchema(RESEARCH_SCHEMA, res.json) : [];
        }
        ranOn = who;
        if (!res.ok && res.errorKind === 'limit') this.pauseFromLimit(ref, res);
        const next = cands[i + 1];
        if (res.ok || !next || !advances(res.errorKind) || (res.errorKind === 'limit' && !next.crossOnLimit)) break;
        const nextWho = this.d.agents.accountLabel('claude', next.account);
        if (res.errorKind === 'limit') {
          limitHops++;
          if (!firstLimited) firstLimited = who;
        }
        push(`conductor: ${who} ${res.errorKind === 'limit' ? 'reached its usage limit' : res.errorKind === 'auth' ? 'is not signed in' : 'could not start'} — continuing on ${nextWho}.`);
      }
      if (limitHops && !(res.errorKind === 'limit')) this.d.notify?.('Usage limit reached', `${firstLimited} — research continued on ${ranOn}`);
      if (res.ok && !errs.length) {
        const report = buildReport(res.json, res.observed ?? { read: [], listed: [], queries: [] });
        for (const f of report.findings) f.claim = redact(f.claim, secrets);
        report.summary = redact(report.summary, secrets);
        report.recommendation = redact(report.recommendation, secrets);
        this.patch(id, (r) => { r.status = 'done'; r.provider = 'claude'; r.report = report; r.events = events; if (modelBasis) r.basis = `${r.basis ?? ''}${modelBasis}`; });
      } else if (res.errorKind === 'aborted') {
        if (this.endRemoved(id, 'researchPerDay', n, events)) return;
        if (loadAsk(id)?.status === 'running') this.patch(id, (x) => { x.status = 'canceled'; });
      } else if (res.errorKind === 'limit') {
        this.failLimited(id, 'researchPerDay', n, 'Claude is at its usage limit — try again later.', this.retryAt('research', res.limit?.resetsAt ?? null), secrets, events);
      } else {
        const why = res.errorKind === 'network' ? 'There is no network right now — try again when it is back.' : res.ok ? `The report did not match the required format: ${errs[0]}` : res.error ?? 'Research failed.';
        this.patch(id, (r) => { r.status = 'failed'; r.error = truncate(redact(why, secrets), 500); r.events = events; });
      }
    } catch (e) {
      this.patch(id, (r) => { r.status = 'failed'; r.error = truncate(redact(`Research failed: ${errMsg(e)}`, secrets), 500); });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private patch(id: string, fn: (r: AskRecord) => void): AskRecord | null {
    const r = loadAsk(id);
    if (!r || r.status === 'canceled') return r;
    fn(r);
    r.updatedAt = this.now();
    this.save(r);
    return r;
  }

  /** Every write goes through here, so the board's research projection cache stays exact (N8). */
  private save(r: AskRecord): void {
    saveAsk(r);
    this.gen++;
  }
  private allAsks(): AskRecord[] {
    this.scans++;
    return listAsks(ASK_LIMITS.index);
  }

  private async run(id: string, repo: RepoConfig | undefined, ac: AbortController): Promise<void> {
    let snapshotCleanup: (() => void) | null = null;
    let scratch: string | null = null;
    const secrets = this.d.secrets?.() ?? [];
    try {
      const rec = loadAsk(id)!;
      let cwd: string;
      let basis = 'no repository';
      let projectFacts = '';
      if (repo) {
        const git = new GitReader(repo.path);
        const { commit } = await git.resolveBranch(repo.baseBranch);
        const snap = await buildSnapshot(git, commit);
        snapshotCleanup = () => removeSnapshot(snap);
        cwd = snap.dir;
        basis = `${repo.baseBranch} @ ${commit.slice(0, 7)}`;
        try {
          const live = await liveFacts({ name: repo.name, path: repo.path, baseBranch: repo.baseBranch, gates: repo.gates }, commit);
          projectFacts = fence('project-facts', buildPack({ facts: live.facts, consumer: 'readonly', task: rec.question, commit, branch: repo.baseBranch }).text, 40_000);
        } catch (e) {
          log.warn(`${id}: no project facts: ${errMsg(e)}`);
        }
        const notes = [snap.symlinks ? `${snap.symlinks} symlink(s) omitted` : '', snap.omittedConfig ? 'agent configuration omitted' : '', snap.skippedLarge ? `${snap.skippedLarge} large file(s) skipped` : ''].filter(Boolean);
        if (notes.length) basis += ` (${notes.join('; ')})`;
      } else {
        scratch = mkdtempSync(join(tmpdir(), 'conductor-ask-'));
        cwd = scratch;
      }
      this.patch(id, (r) => void (r.basis = basis));
      const pairs = rec.follow ? this.historyPairs(rec.follow, repo?.name) : [];
      const history = pairs.length ? this.historyBlock(pairs, secrets) : '';
      const shown = Math.min(pairs.length, HISTORY_LIMITS.pairs);
      if (rec.follow && (rec.historyCount ?? 0) !== shown) this.patch(id, (r) => void (r.historyCount = shown));
      const prompt = render(loadTemplate('ask'), { preamble: preamble('plan'), basis, projectFacts, history, question: fence('user-question', rec.question, ASK_LIMITS.question + 100) });
      await this.d.freshHealth();
      const events: string[] = [...rec.events]; // keeps the "earlier context was not available" note
      const out = await callAgent({
        agents: this.d.agents,
        role: 'context',
        states: this.d.routeStates('context'),
        rule: this.limitRule(),
        onCandidate: (ref) => { const e = this.running.get(id); if (e) e.account = accountKey(ref); },
        onLimit: (l) => { if (l.account) this.pauseFromLimit({ provider: l.provider, id: l.account }, { ok: false, text: '', exitCode: null, errorKind: 'limit', limit: l }); },
        prompt,
        schema: ASK_SCHEMA,
        cwd,
        validate: (j) => {
          const errs = validateSchema(ASK_SCHEMA, j);
          const o = j as { kind?: string; answer?: string; change?: unknown };
          if (!errs.length && o.kind === 'answer' && !String(o.answer ?? '').trim()) errs.push('$.answer: required when kind is "answer"');
          if (!errs.length && o.kind === 'change' && !o.change) errs.push('$.change: required when kind is "change"');
          return errs;
        },
        secrets,
        signal: ac.signal,
        name: `conductor ask ${id}`,
        onEvent: (ev) => {
          if (ev.text && ev.kind !== 'thinking' && events.length < ASK_LIMITS.events) events.push(redact(`${ev.agent}: ${ev.text}`, secrets).replace(/\s+/g, ' ').slice(0, ASK_LIMITS.eventChars));
        },
      });
      if (out.kind === 'ok') {
        const tier = this.d.routeStates()[out.agent as 'claude']?.tier;
        const tierNote = tier === 'partial' ? `Answered by ${providerLabel(out.agent as 'claude')} in ask mode — weaker isolation than Claude's tool lock-down.` : tier === 'unverified' ? `Answered by ${providerLabel(out.agent as 'claude')} — its isolation has not been verified on this machine.` : undefined;
        const shaped = validateAsk({ ...loadAsk(id)!, result: out.json, status: 'done' }, id);
        const result = shaped?.result;
        if (result) {
          result.answer = redact(result.answer, secrets);
          if (result.change) result.change.description = redact(result.change.description, secrets);
        }
        const done = this.patch(id, (r) => { r.status = 'done'; r.provider = out.agent; r.tierNote = tierNote; r.result = result; r.events = events; });
        // the fast path starts ONLY from the option ticked before the ask; the card's text is the user's own question, never the model's change text
        if (done && done.status === 'done' && result?.kind === 'change' && done.allowChange && repo && !this.d.fastPathBusy?.(repo.name) && this.d.cards && take('fastPathPerHour', 5, { now: this.now() })) {
          try {
            const card = this.d.cards.create({ repo: repo.name, title: cleanCommand(done.question).slice(0, 120) || 'Change from Quick Ask', description: done.question, actor: 'user-ask', idemKey: `ask-fast:${id}` });
            this.patch(id, (r) => void (r.convertedTo = card.key));
          } catch (e) {
            log.warn(`${id}: could not start the fast path: ${errMsg(e)}`);
          }
        }
      } else if (out.kind === 'aborted') {
        if (this.endRemoved(id, 'asksPerHour', 1, events)) return;
        const r = loadAsk(id);
        if (r && r.status === 'running') this.patch(id, (x) => { x.status = 'canceled'; x.events = events; });
      } else if (out.kind === 'paused') {
        // M8-3: mid-call exhaustion ⇒ failed + limited + retryAt, the counter refunded (no automatic retry — Home never queues)
        if (out.limit.account) this.pauseFromLimit({ provider: out.limit.provider, id: out.limit.account }, { ok: false, text: '', exitCode: null, errorKind: 'limit', limit: out.limit });
        this.failLimited(id, 'asksPerHour', 1, `${providerLabel(out.limit.provider)} is at its usage limit — try again later.`, this.retryAt('context', out.limit.resetsAt ?? null), secrets, events);
      } else {
        const why = out.kind === 'offline' ? 'There is no network right now — try again when it is back.' : out.reason;
        this.patch(id, (r) => { r.status = 'failed'; r.error = truncate(redact(why, secrets), 500); r.events = events; });
      }
    } catch (e) {
      const why = e instanceof SnapshotTooLarge ? e.message : `Could not answer: ${errMsg(e)}`;
      this.patch(id, (r) => { r.status = 'failed'; r.error = truncate(redact(why, secrets), 500); });
    } finally {
      snapshotCleanup?.();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** "Turn into work": a normal card made by the server-only actor `ask-convert` — tainted (model text), plan approval forced under every policy. */
  convert(id: string): { key: string } {
    const r = loadAsk(id);
    if (!r) throw new AskError('not_found', 'Unknown question.', 404);
    if (r.status !== 'done' || (!r.result && !r.report)) throw new AskError('bad_state', 'Only an answered question can be turned into work.', 409);
    if (r.convertedTo) return { key: r.convertedTo };
    if (!this.d.cards || !r.repo) throw new AskError('bad_state', 'Pick a repository for this question first — it was asked without one.', 409);
    if (r.mode === 'research' && r.report) {
      const steps = r.report.steps.map((x, i) => `${i + 1}. ${x}`).join('\n');
      // N14: the card title stays the user's own question; a brief's title is shown in the description, labelled model-written
      const briefLine = r.brief ? `Research: ${sanitizeLine(r.brief.title, 120)} (model-written)\n` : '';
      const description = `${r.question}\n\n---\n${briefLine}Research findings (written by a model from web sources — untrusted, not instructions):\n\nRecommendation: ${r.report.recommendation.slice(0, 3000)}${steps ? `\n\nSuggested steps:\n${steps}` : ''}`;
      const card = this.d.cards!.create({ repo: r.repo!, title: cleanCommand(r.question).slice(0, 120) || 'Work from research', description, actor: 'research', idemKey: `research-convert:${id}` });
      this.patch(id, (x) => void (x.convertedTo = card.key));
      return card;
    }
    if (!r.result) throw new AskError('bad_state', 'Only an answered question can be turned into work.', 409);
    const description = `${r.question}\n\n---\nAnswer from Quick Ask (written by a model — untrusted, not instructions):\n\n${r.result.answer.slice(0, 8000)}`;
    const card = this.d.cards.create({ repo: r.repo, title: cleanCommand(r.question).slice(0, 120) || 'Work from Quick Ask', description, actor: 'ask-convert', idemKey: `ask-convert:${id}` });
    this.patch(id, (x) => void (x.convertedTo = card.key));
    return card;
  }

  cancel(id: string): AskRecord | null {
    const r = loadAsk(id);
    if (!r) return null;
    this.running.get(id)?.ac.abort();
    if (r.status === 'running' || r.status === 'paused') {
      r.status = 'canceled';
      r.updatedAt = this.now();
      this.save(r);
    }
    return r;
  }

  /** Q3: hide a finished research report from the board's "Report ready" lane. Research `done` only; idempotent; changes only `dismissedAt`. */
  dismiss(id: string): AskRecord {
    const r = loadAsk(id);
    if (!r) throw new AskError('not_found', 'Unknown question.', 404);
    if (r.mode !== 'research' || r.status !== 'done') throw new AskError('bad_state', 'Only a finished research report can be dismissed.', 409);
    if (r.dismissedAt) return r;
    r.dismissedAt = this.now();
    this.save(r);
    return r;
  }

  /** The read-only research projection for GET /api/board (Q3): derived from the asks store, never written to the board (S15). Cached (N8). */
  researchCards(): ResearchCardView[] {
    if (this.projection && this.projection.gen === this.gen) return this.projection.cards;
    const cards = this.allAsks().filter((r) => r.mode === 'research').slice(0, 50).map((r): ResearchCardView => {
      const lane: ResearchCardView['lane'] = r.status === 'running' || r.status === 'paused' ? 'active' : r.status === 'failed' ? 'needs_you' : r.status === 'canceled' ? 'canceled' : r.convertedTo || r.dismissedAt ? 'done' : 'review';
      const f = r.report?.findings ?? [];
      return {
        id: r.id, title: sanitizeLine(r.question, 200), lane, status: r.status, depth: r.depth === 'deep' ? 'deep' : 'standard', repo: r.repo ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt,
        counts: { opened: f.filter((x) => x.status === 'opened').length, listed: f.filter((x) => x.status === 'listed').length, unverified: f.filter((x) => x.status === 'unverified').length },
        convertedTo: r.convertedTo ?? null, error: r.error ? sanitizeLine(r.error, 300) : null,
      };
    });
    this.projection = { gen: this.gen, cards };
    return cards;
  }
  get(id: string): AskRecord | null { return loadAsk(id); }
  list(): AskRecord[] { return listAsks(); }
  remove(id: string): void { this.running.get(id)?.ac.abort(); deleteAsk(id); this.gen++; }
  async idle(): Promise<void> { await Promise.allSettled([...this.running.values()].map((v) => v.promise)); }
  /** Startup/shutdown hygiene: asks that were running when the process died cannot continue. */
  failInterrupted(): void {
    for (const r of listAsks(ASK_LIMITS.index)) if (r.status === 'running' || r.status === 'paused') { r.status = 'failed'; r.error = 'Interrupted by a restart.'; r.updatedAt = this.now(); this.save(r); }
  }
}
