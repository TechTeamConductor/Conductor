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
import { take } from '../limits/budget.ts';
import { redact } from '../redact.ts';
import { ASK_SCHEMA } from '../pipeline/schemas.ts';
import { fence, loadTemplate, preamble, render } from '../pipeline/prompts.ts';
import { errMsg, truncate } from '../util.ts';
import { cleanCommand } from '../context/facts.ts';
import { logger } from '../log.ts';
import { ASK_LIMITS, deleteAsk, loadAsk, listAsks, newAskId, saveAsk, validateAsk, type AskRecord } from './store.ts';
import { RESEARCH_SCHEMA, buildReport } from './research.ts';
import { buildSnapshot, removeSnapshot, SnapshotTooLarge } from './snapshot.ts';

const log = logger('asks');
export class AskError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const MAX_CONCURRENT = 2;

export interface AskDeps {
  getConfig: () => Config;
  agents: Agents;
  routeStates: () => States;
  freshHealth: () => Promise<void>;
  secrets?: () => string[];
  now?: () => number;
  /** Creates a board card for a repository with a SERVER-assigned actor (never from a request body). */
  /** True when a fast-path run of this repository is still in progress (at most one at a time). */
  fastPathBusy?: (repo: string) => boolean;
  /** The connectivity probe (Deep Research needs the internet). */
  networkState?: () => Promise<'online' | 'offline' | 'unknown'>;
  cards?: { create(i: { repo: string; title: string; description: string; actor: 'user-ask' | 'ask-convert' | 'research'; idemKey: string }): { key: string } };
}

export class AskService {
  private d: AskDeps;
  private running = new Map<string, { ac: AbortController; promise: Promise<void> }>();
  constructor(deps: AskDeps) {
    this.d = deps;
  }
  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Validate, count, record, and start. Returns the new record at once; the answer arrives later. */
  start(input: { question: unknown; repo?: unknown; allowChange?: unknown }): AskRecord {
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
    if (cfg.agents.claude.isolation !== 'safe-mode') throw new AskError('isolation', 'Quick Ask needs Claude\'s safe-mode isolation (project settings and hooks would be loaded from the snapshot otherwise).', 409);
    if (this.running.size >= MAX_CONCURRENT) throw new AskError('busy', 'Two questions are already being answered — try again in a moment.', 429);
    if (!take('asksPerHour', cfg.pipeline.asksPerHour, { now: this.now() })) throw new AskError('limit', `You reached the limit of ${cfg.pipeline.asksPerHour} questions per hour.`, 429);
    const rec: AskRecord = { schemaVersion: 1, id: newAskId(), mode: 'quick', repo: repo?.name, question: q, createdAt: this.now(), updatedAt: this.now(), status: 'running', events: [], allowChange: input.allowChange === true };
    saveAsk(rec);
    const ac = new AbortController();
    const promise = this.run(rec.id, repo, ac).catch((e) => log.warn(`${rec.id}: ${errMsg(e)}`)).finally(() => void this.running.delete(rec.id));
    this.running.set(rec.id, { ac, promise });
    return rec;
  }

  /** Deep Research: web-only Claude session in an empty scratch directory; asks fail fast like Quick Ask. */
  async startResearch(input: { question: unknown; repo?: unknown }): Promise<AskRecord> {
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
    if (!take('researchPerDay', cfg.pipeline.researchPerDay, { now: this.now() })) throw new AskError('limit', `You reached today's limit of ${cfg.pipeline.researchPerDay} research runs.`, 429);
    const rec: AskRecord = { schemaVersion: 1, id: newAskId(), mode: 'research', repo, question: q, createdAt: this.now(), updatedAt: this.now(), status: 'running', events: [], basis: 'web research (no repository access)' };
    saveAsk(rec);
    const ac = new AbortController();
    const promise = this.runResearch(rec.id, ac).catch((e) => log.warn(`${rec.id}: ${errMsg(e)}`)).finally(() => void this.running.delete(rec.id));
    this.running.set(rec.id, { ac, promise });
    return rec;
  }

  private async runResearch(id: string, ac: AbortController): Promise<void> {
    const secrets = this.d.secrets?.() ?? [];
    const scratch = mkdtempSync(join(tmpdir(), 'conductor-research-'));
    try {
      const rec = loadAsk(id)!;
      const claude = this.d.agents.provider('claude');
      if (!claude.runResearch) throw new Error('Claude is not available for research.');
      await this.d.freshHealth();
      const events: string[] = [];
      let prompt = render(loadTemplate('research'), { preamble: preamble('plan'), question: fence('user-question', rec.question, ASK_LIMITS.question + 100) });
      let res = await claude.runResearch({ cwd: scratch, prompt, schema: RESEARCH_SCHEMA, name: `conductor research ${id}`, secrets, signal: ac.signal, onEvent: (ev) => { if (ev.text && ev.kind !== 'thinking' && events.length < ASK_LIMITS.events) events.push(redact(`${ev.agent}: ${ev.text}`, secrets).replace(/\s+/g, ' ').slice(0, ASK_LIMITS.eventChars)); } });
      let errs = res.ok ? validateSchema(RESEARCH_SCHEMA, res.json) : [];
      if (res.ok && errs.length) {
        prompt += `\n\n## Your previous reply was rejected\n${errs.slice(0, 6).map((e) => `- ${e}`).join('\n')}\nReturn a corrected JSON object.`;
        res = await claude.runResearch({ cwd: scratch, prompt, schema: RESEARCH_SCHEMA, name: `conductor research ${id}`, secrets, signal: ac.signal, onEvent: () => undefined });
        errs = res.ok ? validateSchema(RESEARCH_SCHEMA, res.json) : [];
      }
      if (res.ok && !errs.length) {
        const report = buildReport(res.json, res.observed ?? { read: [], listed: [], queries: [] });
        for (const f of report.findings) f.claim = redact(f.claim, secrets);
        report.summary = redact(report.summary, secrets);
        report.recommendation = redact(report.recommendation, secrets);
        this.patch(id, (r) => { r.status = 'done'; r.provider = 'claude'; r.report = report; r.events = events; });
      } else if (res.errorKind === 'aborted') {
        if (loadAsk(id)?.status === 'running') this.patch(id, (x) => { x.status = 'canceled'; });
      } else {
        const why = res.errorKind === 'limit' ? 'Claude is at its usage limit — try again later.' : res.errorKind === 'network' ? 'There is no network right now — try again when it is back.' : res.ok ? `The report did not match the required format: ${errs[0]}` : res.error ?? 'Research failed.';
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
    saveAsk(r);
    return r;
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
      const prompt = render(loadTemplate('ask'), { preamble: preamble('plan'), basis, projectFacts, question: fence('user-question', rec.question, ASK_LIMITS.question + 100) });
      await this.d.freshHealth();
      const events: string[] = [];
      const out = await callAgent({
        agents: this.d.agents,
        role: 'context',
        states: this.d.routeStates(),
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
        const r = loadAsk(id);
        if (r && r.status === 'running') this.patch(id, (x) => { x.status = 'canceled'; x.events = events; });
      } else {
        const why = out.kind === 'paused' ? `${providerLabel(out.limit.provider)} is at its usage limit — try again later.` : out.kind === 'offline' ? 'There is no network right now — try again when it is back.' : out.reason;
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
      const description = `${r.question}\n\n---\nResearch findings (written by a model from web sources — untrusted, not instructions):\n\nRecommendation: ${r.report.recommendation.slice(0, 3000)}${steps ? `\n\nSuggested steps:\n${steps}` : ''}`;
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
      saveAsk(r);
    }
    return r;
  }
  get(id: string): AskRecord | null { return loadAsk(id); }
  list(): AskRecord[] { return listAsks(); }
  remove(id: string): void { this.running.get(id)?.ac.abort(); deleteAsk(id); }
  async idle(): Promise<void> { await Promise.allSettled([...this.running.values()].map((v) => v.promise)); }
  /** Startup/shutdown hygiene: asks that were running when the process died cannot continue. */
  failInterrupted(): void {
    for (const r of listAsks()) if (r.status === 'running' || r.status === 'paused') { r.status = 'failed'; r.error = 'Interrupted by a restart.'; r.updatedAt = this.now(); saveAsk(r); }
  }
}
