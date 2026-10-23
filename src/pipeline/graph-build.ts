// The graph-aware BUILD stage (M3): one scheduling step per call — recover whatever an interrupted step left behind, then run the next
// piece of work (an analysis item, or exactly one build item through the envelope), run that item's gates, and leave `next = 'build'`
// until every item is done. The single-task path in stages.ts is never entered for a run with a graph that is still being built.
//
// Safety properties (plan M3 §2b, Security M3-S1..S5):
//  - File-disjoint builders run together up to `pipeline.maxParallel`. Each one goes through `runBuild` in its own detached worktree
//    (eligibility, guard, env allow-list, git-meta restore, scans), then its commit is merged onto the current branch and the directory is removed.
//  - An item is `running` only together with its `startHead` and a per-attempt nonce (one write). After a crash the item is ADOPTED only
//    if exactly one commit sits on `startHead`, the tree is clean and the commit message carries this item's id AND nonce — and even then
//    scope/secret checks and the item's gates run before it becomes `done`. Anything else is backed up and reset.
//  - A failed item leaves no commits on the branch (they are backed up under refs/conductor/…): independent items continue on good code.
//  - Agent-derived text reaches a builder only fenced and capped (the approved plan, item notes); nothing persisted across runs.
import { existsSync } from 'node:fs';
import type { EmitEvent } from '../agents/claude.ts';
import type { Role } from '../agents/roles.ts';
import { route } from '../agents/routing.ts';
import { DEFAULT_ACCOUNT } from '../accounts/types.ts';
import { providerLabel } from '../agents/providers/registry.ts';
import type { AgentResult, GateComparison, GateDef, GateRun, ItemRun, LimitInfo, NextStep, Plan, RepoConfig, Run, StageName } from '../types.ts';
import * as W from '../git/worktree.ts';
import * as G from '../git/gates.ts';
import { git, gitOk } from '../git/exec.ts';
import { redact } from '../redact.ts';
import { truncate } from '../util.ts';
import type { PipelineCtx } from './context.ts';
import { exemptPaths, postBuildChecks, runBuild } from './envelope.ts';
import { effectiveFixtureRewrite } from '../policy/policy.ts';
import { ANALYSIS_ROLES, ancestorsOf, itemMarker, newNonce, parseItemMarker, pickReadyBuilds, propagateBlocked, readySet, sanitizeLine, stripInvisible } from './graph.ts';
import type { Hold } from './stages.ts';
import { fence, loadTemplate, planToMarkdown, preamble, render, taskBlock } from './prompts.ts';

const SHA_RE = /^[0-9a-f]{40}$/;
/** Caps for what an analysis item may hand to later items (plan §2b-7): summary ≤ 4 KB, details ≤ 12 KB, ≤ 10 decisions of ≤ 200 characters. */
const NOTE_SUMMARY_MAX = 4_096;
const NOTE_DETAILS_MAX = 12_000;
const NOTE_DECISIONS_MAX = 10;
const NOTE_DECISION_LEN = 200;
/** Total size of the prior-work notes in one build-item prompt. */
const NOTES_TOTAL_MAX = 16_000;

export interface ItemNote {
  summary: string;
  details: string;
  decisions: string[];
}

/** What the graph builder needs from the stage runner (an explicit, narrow interface — the stage's private members stay private). */
export interface GraphHost {
  c: PipelineCtx;
  run(key: string): Run;
  repo(run: Run): RepoConfig;
  patch(key: string, fn: (r: Run) => void): Run;
  note(key: string, stage: StageName | 'engine', text: string): void;
  toNeedsHuman(key: string, reason: string, origin: NextStep, comment?: string): Promise<void>;
  /** M8-3 `onLimitHit`: the account's pause, then a re-route under the limit rule (restart on the next account, or pause). */
  pauseForLimit(key: string, limit: LimitInfo, role?: Role): Promise<void>;
  finishSession(key: string, res: AgentResult): void;
  refundIfLimit(key: string, res: AgentResult): void;
  emitter(key: string, stage: StageName, loop: number, rev: number): (ev: EmitEvent) => void;
  runAllGates(key: string, repo: RepoConfig, defs: GateDef[], cwd?: string): Promise<GateRun>;
  reinstallIfLockChanged(key: string, stage: StageName, cwd?: string): Promise<void>;
  hasUncommitted(worktree: string): Promise<boolean>;
  writePromptAudit(key: string, name: string, text: string): void;
  runsLimit(run: Run): number;
  /**
   * A read-only agent call for an analysis item (validated; never moves the run itself — a call that cannot continue returns the hold it
   * wants, so that concurrent calls make ONE transition).
   */
  callAnalysis(key: string, prompt: string, role: Role, label: string): Promise<{ kind: 'ok'; json: unknown } | { kind: 'stop'; hold?: Hold }>;
  applyHold(key: string, hold: Hold | undefined): Promise<void>;
  looksOffline(res: AgentResult): Promise<boolean>;
  refundRun(key: string): Run;
  /** Fenced project-context blocks for a prompt (builder: facts only; read-only: facts + history). */
  projectBlocks(key: string, consumer: 'builder' | 'readonly', files?: string[]): Promise<{ projectFacts: string; projectHistory: string; projectNotes: string }>;
  /** One slot of the engine's single cap on concurrent analysis calls (null = the run was stopped while waiting). */
  analysisSlot(key: string): Promise<(() => void) | null>;
  /** One slot of `pipeline.maxParallel` for a build (shared by every run; null = the run was stopped while waiting). */
  buildSlot(key: string): Promise<(() => void) | null>;
  protectedPaths: string;
}

/** Cap a model-written note — the caps are applied by code, never trusted from the model. */
export function capNote(raw: unknown): ItemNote {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const decisions = Array.isArray(o.decisions) ? o.decisions.filter((d): d is string => typeof d === 'string') : [];
  return {
    summary: truncate(stripInvisible(o.summary), NOTE_SUMMARY_MAX),
    details: truncate(stripInvisible(o.details), NOTE_DETAILS_MAX),
    decisions: decisions.slice(0, NOTE_DECISIONS_MAX).map((d) => truncate(sanitizeLine(d, NOTE_DECISION_LEN), NOTE_DECISION_LEN)),
  };
}

export class GraphBuilder {
  private h: GraphHost;
  /** Per run, the land-order gates for the build wave that is in flight. Lower ids land first so the branch stays one commit per task. */
  private landGates = new Map<string, Map<string, Promise<void>>>();
  private landRelease = new Map<string, Map<string, () => void>>();
  constructor(host: GraphHost) {
    this.h = host;
  }

  private item(key: string, id: string): ItemRun {
    const it = this.h.run(key).graph?.items.find((x) => x.id === id);
    if (!it) throw new Error(`task ${id} is not part of the graph`);
    return it;
  }
  private setItem(key: string, id: string, fn: (it: ItemRun, r: Run) => void): void {
    this.h.patch(key, (r) => {
      const it = r.graph?.items.find((x) => x.id === id);
      if (it) fn(it, r);
    });
  }
  private aborted(key: string): boolean {
    return this.h.c.signal(key).aborted;
  }

  /** A progress comment on the item's subtask card (never throws; the card may be gone). */
  private async cardNote(key: string, id: string, what: string, body: string): Promise<void> {
    const run = this.h.run(key);
    const it = run.graph?.items.find((x) => x.id === id);
    const card = it?.key ? this.h.c.board.item(it.key) : undefined;
    if (!it || !card || card.parentId !== run.itemId) return;
    try {
      await this.h.c.effects.commentOn(key, `item:${run.graph!.rev}:${id}:${what}`, card.id, body);
    } catch {
      /* a progress note is never worth failing the run for */
    }
  }

  // ───────────────────────── the scheduling step ─────────────────────────
  async step(key: string, plan: Plan): Promise<void> {
    const h = this.h;
    if ((await this.recover(key, plan)) === 'stop') return;
    // blocked / unblocked follows the dependencies' states after every transition
    {
      const probe = structuredClone(h.run(key).graph!.items);
      if (propagateBlocked(probe)) h.patch(key, (r) => void propagateBlocked(r.graph!.items));
    }
    const items = h.run(key).graph!.items;
    // read-only analysis first, as many at once as the cap allows; then every ready build whose files do not overlap, up to maxParallel
    const analysis = readySet(items).filter((i) => ANALYSIS_ROLES.has(i.role)).slice(0, h.c.cfg().pipeline.readOnlyParallel);
    if (analysis.length) return this.runAnalysisWave(key, plan, analysis.map((i) => i.id));
    const builds = pickReadyBuilds(items, h.c.cfg().pipeline.maxParallel);
    if (builds.length) return this.runBuildWave(key, plan, builds.map((i) => i.id));
    if (items.every((i) => i.state === 'done')) return this.finalize(key);
    return this.endWithProblems(key);
  }

  private async finalize(key: string): Promise<void> {
    const h = this.h;
    const run = h.run(key);
    const head = await gitOk(run.worktree, ['rev-parse', 'HEAD']);
    const n = run.graph!.items.length;
    h.patch(key, (r) => {
      r.graph!.final = 'verifying';
      r.commitSha = head;
      r.commitNote = undefined;
      r.next = 'verify';
      r.history.push({ ts: h.c.clock.now(), text: `All ${n} tasks done — verifying the whole change` });
    });
  }

  /** Nothing can run and not everything is done: tell the person exactly what happened and what Retry will do. */
  private async endWithProblems(key: string): Promise<void> {
    const items = this.h.run(key).graph!.items;
    const failed = items.filter((i) => i.state === 'failed');
    const blocked = items.filter((i) => i.state === 'blocked');
    const done = items.filter((i) => i.state === 'done');
    const label = (i: ItemRun) => `${i.id} "${sanitizeLine(i.title, 80)}"`;
    const lines = [
      'Not every task could be completed:',
      ...failed.map((i) => `- ${label(i)} failed${i.note ? `: ${sanitizeLine(i.note, 400)}` : ''}`),
      ...blocked.map((i) => `- ${label(i)} was not started because ${i.dependsOn.filter((d) => ['failed', 'blocked'].includes(items.find((x) => x.id === d)?.state ?? '')).join(', ')} did not finish`),
      done.length ? `Finished and kept: ${done.map((i) => i.id).join(', ')}.` : '',
      'Retry runs the failed and blocked tasks again; the finished tasks and their commits are kept. Moving the card to To do does the same as Retry; to start over with a new plan, edit the card description (or stop the run, then Retry).',
    ].filter(Boolean);
    if (!failed.length && !blocked.length) {
      return this.h.toNeedsHuman(key, 'The task graph has no task that can run, but it is not complete. Move the card to To do to plan it again.', 'build');
    }
    return this.h.toNeedsHuman(key, lines.join('\n'), 'build');
  }

  // ───────────────────────── recovery (crash, restart, abort) ─────────────────────────
  private async recover(key: string, plan: Plan): Promise<'ok' | 'stop'> {
    for (const it of this.h.run(key).graph!.items.filter((i) => i.state === 'running')) {
      if (ANALYSIS_ROLES.has(it.role)) {
        // analysis has no side effects: simply run it again
        this.setItem(key, it.id, (x) => void (x.state = 'pending'));
        continue;
      }
      if ((await this.adoptOrReset(key, it.id, plan)) === 'stop') return 'stop';
    }
    return 'ok';
  }

  /**
   * An interrupted build item. ADOPT only what Conductor itself committed for exactly this attempt (one commit on `startHead`, clean
   * tree, id + nonce in the message) — then the usual checks decide whether it is `done`. Everything else is backed up and reset to
   * `startHead`; the item runs again with its loop counter preserved.
   */
  private async adoptOrReset(key: string, id: string, plan: Plan): Promise<'ok' | 'stop'> {
    const h = this.h;
    const run = h.run(key);
    const it = this.item(key, id);
    const wt = run.worktree;
    const head = await gitOk(wt, ['rev-parse', 'HEAD']);
    const dirty = await h.hasUncommitted(wt);
    const start = it.startHead && SHA_RE.test(it.startHead) ? it.startHead : undefined;
    if (start && head === start && !dirty) {
      this.setItem(key, id, (x) => void (x.state = 'pending'));
      h.note(key, 'build', `${id} was interrupted before it changed anything — starting it again.`);
      return 'ok';
    }
    if (start && head !== start && !dirty && it.nonce) {
      let adoptable = false;
      try {
        const count = Number(await gitOk(wt, ['rev-list', '--count', `${start}..${head}`]));
        const parent = await gitOk(wt, ['rev-parse', `${head}^`]);
        const marker = parseItemMarker(await gitOk(wt, ['log', '-1', '--format=%B', head]));
        adoptable = count === 1 && parent === start && marker?.itemId === id && marker.nonce === it.nonce;
      } catch {
        adoptable = false;
      }
      if (adoptable) {
        h.note(key, 'build', `Found the finished commit of ${id} from before a restart — checking it before it counts.`);
        const files = (await gitOk(wt, ['diff', '--name-only', '-z', start, head])).split('\0').filter(Boolean);
        return this.finishItem(key, id, head, files, plan, 'adopted', start);
      }
    }
    // not adoptable: a recoverable copy first, then back to where the attempt started
    let refs: Awaited<ReturnType<typeof W.backupRefs>>;
    try {
      refs = await W.backupRefs(wt, run.key, run.rev);
    } catch (e) {
      await h.toNeedsHuman(key, `Unfinished work on ${id} from before a restart could not be backed up (${truncate(String((e as Error)?.message ?? e), 160)}), so Conductor will not discard it. Check the worktree, then move the card to To do.`, 'build');
      return 'stop';
    }
    const target = start ?? run.commitSha ?? run.baseSha;
    if (await this.resetWouldDropDone(key, target)) {
      this.setItem(key, id, (x) => void (x.state = 'pending'));
      h.note(key, 'build', `${id} was interrupted. Its private directory is gone, and the current branch already has other finished tasks, so those commits stay.`);
      return 'ok';
    }
    await W.resetToCommit(wt, target);
    this.setItem(key, id, (x) => void (x.state = 'pending'));
    h.note(key, 'build', `Discarded the unfinished attempt at ${id} from before a restart${refs.stashRef ? ` (backup: ${refs.stashRef})` : ''}.`);
    return 'ok';
  }

  /** True when resetting the checkout to `target` would drop a commit that already belongs to a finished task. */
  private async resetWouldDropDone(key: string, target: string): Promise<boolean> {
    const run = this.h.run(key);
    for (const it of run.graph?.items ?? []) {
      if (it.state !== 'done' || !it.commitSha || !SHA_RE.test(it.commitSha)) continue;
      const anc = await git(run.worktree, ['merge-base', '--is-ancestor', it.commitSha, target]);
      if (anc.code !== 0) return true;
    }
    return false;
  }

  /** Ready build items run together. Each waits for a `maxParallel` slot. Results land on the current branch in id order. */
  private async runBuildWave(key: string, plan: Plan, ids: string[]): Promise<void> {
    const gates = new Map<string, Promise<void>>();
    const release = new Map<string, () => void>();
    for (const id of ids) {
      let done!: () => void;
      gates.set(id, new Promise<void>((r) => { done = r; }));
      release.set(id, done);
    }
    this.landGates.set(key, gates);
    this.landRelease.set(key, release);
    try {
      const settled = await Promise.allSettled(ids.map((id) => this.runBuildItem(key, plan, id)));
      const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (failure) throw failure.reason;
    } finally {
      for (const done of release.values()) done();
      this.landGates.delete(key);
      this.landRelease.delete(key);
    }
  }

  // ───────────────────────── analysis items (read-only, concurrent) ─────────────────────────
  /**
   * Ready analysis items run together (each waits for a slot of the engine's one cap). The wave settles COMPLETELY first; finished items keep
   * their results; items that could not continue go back to waiting; and the run then makes at most ONE transition — a person is needed
   * (needs-you) before a usage-limit pause.
   */
  private async runAnalysisWave(key: string, plan: Plan, ids: string[]): Promise<void> {
    const h = this.h;
    const rev = h.run(key).rev;
    h.patch(key, (r) => {
      for (const id of ids) {
        const it = r.graph!.items.find((x) => x.id === id);
        if (it) {
          it.state = 'running';
          it.agentRuns += 1;
        }
      }
    });
    const settled = await Promise.allSettled(ids.map((id) => this.analysisOne(key, plan, id)));
    let hold: Hold | undefined;
    let failure: { error: unknown } | undefined;
    const aborted = h.run(key).status === 'aborted';
    for (const [i, id] of ids.entries()) {
      const o = settled[i]!;
      if (o.status === 'rejected') {
        failure ??= { error: o.reason };
        this.setItem(key, id, (x) => void (x.state === 'running' && (x.state = 'pending')));
        continue;
      }
      const r = o.value;
      if (r.note) {
        await this.completeAnalysis(key, id, rev, r.note);
        continue;
      }
      if (!aborted) this.setItem(key, id, (x) => void (x.state === 'running' && (x.state = 'pending')));
      if (r.hold && (!hold || (hold.type === 'pause' && r.hold.type === 'human'))) hold = r.hold;
    }
    if (failure) throw failure.error;
    if (hold) await h.applyHold(key, hold);
  }

  private async analysisOne(key: string, plan: Plan, id: string): Promise<{ note?: ItemNote; hold?: Hold }> {
    const h = this.h;
    const release = await h.analysisSlot(key);
    if (!release) return {};
    try {
      const run = h.run(key);
      const it = this.item(key, id);
      const prompt = render(loadTemplate('item-analysis'), {
        ...(await h.projectBlocks(key, 'readonly', it.files)),
        preamble: preamble('plan'),
        key: run.key,
        itemId: it.id,
        role: it.role,
        item: this.itemBlock(it),
        others: this.othersBlock(run),
        doneNotes: this.priorWork(key, it),
        task: taskBlock({ key: run.key, title: run.title, description: run.description }),
        plan: fence('approved-plan', planToMarkdown(plan), 40_000),
      });
      const called = await h.callAnalysis(key, prompt, it.role as Role, `item-${it.id}`);
      if (called.kind === 'stop') return { hold: called.hold };
      const secrets = h.c.secretsFor(h.run(key));
      const note = capNote(called.json);
      note.summary = redact(note.summary, secrets);
      note.details = redact(note.details, secrets);
      note.decisions = note.decisions.map((d) => redact(d, secrets));
      return { note };
    } finally {
      release();
    }
  }

  private async completeAnalysis(key: string, id: string, rev: number, note: ItemNote): Promise<void> {
    const h = this.h;
    h.c.store.writeArtifact(key, `item-${rev}-${id}.json`, note);
    this.setItem(key, id, (x, r) => {
      x.state = 'done';
      x.note = truncate(note.summary, 600);
      r.history.push({ ts: h.c.clock.now(), text: `Analysis ${id} done` });
    });
    await this.cardNote(key, id, 'done', `✅ **${id} — analysis done**\n\n${note.summary}${note.decisions.length ? `\n\n**Decisions**\n${note.decisions.map((d) => `- ${d}`).join('\n')}` : ''}`);
  }

  /**
   * Complete auto, once per item: leave the item pending and the rewrite note on the run so the next step builds again.
   * A committed secret records `commitSha` so a later crash window does not treat that commit as finished work.
   */
  private queueFixtureRewrite(key: string, id: string, reason: string, commitSha?: string): boolean {
    const h = this.h;
    const rw = effectiveFixtureRewrite(h.c.cfg(), this.item(key, id).fixtureRewrites, reason);
    if (!rw) return false;
    h.patch(key, (r) => {
      const x = r.graph?.items.find((i) => i.id === id);
      if (x) {
        x.fixtureRewrites = rw.nextUsed;
        x.state = 'pending';
        x.startHead = undefined;
        x.nonce = undefined;
        x.note = truncate(rw.note, 600);
      }
      r.fixtureRewriteNote = rw.note;
      if (commitSha) r.commitSha = commitSha;
      r.next = 'build';
      r.history.push({ ts: h.c.clock.now(), text: `Complete auto: rewriting credential-shaped text in ${rw.paths.join(', ')} (local worktree only; nothing is pushed)` });
    });
    h.note(key, 'build', `Complete auto is rewriting credential-shaped text in ${rw.paths.join(', ')} (${id}). The change stays on this machine; nothing is pushed.`);
    return true;
  }

  // ───────────────────────── build items ─────────────────────────
  private async runBuildItem(key: string, plan: Plan, id: string): Promise<void> {
    const h = this.h;
    let run = h.run(key);
    const cfg = h.c.cfg();
    const repo = h.repo(run);
    const it = this.item(key, id);
    const limit = h.runsLimit(run);
    if (run.agentRuns + 1 > limit) return h.toNeedsHuman(key, `This card has used its limit of ${limit} agent runs.`, 'build');

    // 1) who builds it (nothing is recorded before this succeeds, so a refusal leaves the item pending)
    await h.c.freshHealth();
    const role: Role = it.loop > 1 ? 'debugging' : (it.role as Role);
    const rt = route({ role, complexity: run.complexity, roles: cfg.roles, states: h.c.routeStates(role), now: h.c.clock.now(), label: providerLabel, rule: h.c.limitRule() });
    if (!rt.ok) {
      if (rt.kind === 'paused') return h.pauseForLimit(key, { provider: rt.provider, account: rt.account, resetsAt: rt.pauseUntil, message: rt.reason }, role);
      return h.toNeedsHuman(key, rt.reason, 'build');
    }
    const cand = rt.candidates[0]!;
    const builder = h.c.agents.provider(cand.id);
    const account = { provider: cand.id, id: cand.account };

    // 2) one slot of the parallel cap, then a detached directory cut from the current branch tip.
    // The repository checkout is not written by the builder. The commit is merged onto it when the item succeeds.
    const release = await h.buildSlot(key);
    if (!release) return;
    const startHead = (await gitOk(run.worktree, ['rev-parse', 'HEAD'])).trim();
    const wt = W.detachedBuildPath(repo, run.key, id, cfg.worktreeRoot);
    const reuse = !!run.commitNote && existsSync(wt);
    try {
      if (!reuse) await W.openDetachedBuild(repo, wt, startHead);
    const nonce = newNonce();
    h.patch(key, (r) => {
      const x = r.graph!.items.find((i) => i.id === id)!;
      x.state = 'running';
      x.startHead = startHead;
      x.nonce = nonce;
      x.agentRuns += 1;
      if (!x.floor) x.floor = startHead;
      r.agentRuns += 1;
    });
    run = h.run(key);
    const cur = this.item(key, id);
    const rewriteNote = run.fixtureRewriteNote;
    if (rewriteNote) h.patch(key, (r) => void (r.fixtureRewriteNote = undefined));

    const baseline = h.c.store.readArtifact<GateRun | null>(key, 'baseline.json', null);
    const baselineFailing = baseline ? baseline.results.filter((g) => g.exitCode !== 0).map((g) => g.name).join(', ') : '';
    const prompt = render(loadTemplate('build-item'), {
      ...(await h.projectBlocks(key, 'builder', cur.files)),
      preamble: preamble('build'),
      key: run.key,
      itemId: cur.id,
      item: this.itemBlock(cur),
      others: this.othersBlock(run),
      doneNotes: this.priorWork(key, cur),
      task: taskBlock({ key: run.key, title: run.title, description: run.description }),
      plan: fence('approved-plan', planToMarkdown(plan), 40_000),
      branch: run.branch,
      protected: h.protectedPaths,
      gates: repo.gates.length ? repo.gates.map((g) => `\`${g.cmd}\``).join(', ') : '(none detected)',
      baselineFailing,
      gateFailures: cur.feedback ? fence('gate-output', cur.feedback, 4_000) : '',
      commitNote: [run.commitNote ? fence('commit-hook-output', run.commitNote, 4_000) : '', rewriteNote ? fence('fixture-rewrite', rewriteNote, 2_000) : ''].filter(Boolean).join('\n\n'),
    });
    h.writePromptAudit(key, `build-${id}-${cur.loop}`, prompt);

    const secrets = h.c.secretsFor(run);
    const subject = `${run.key}: ${truncate(sanitizeLine(run.title, 60), 60)} — ${cur.id}: ${sanitizeLine(cur.title, 80)}${cur.loop > 1 ? ` (fix, loop ${cur.loop})` : ''}`;
    // M8-2: the item role's model/effort for the tool that actually builds (B2 binding)
    const sel = h.c.agents.selectionFor(role, builder.id, { account: cand.account });
    h.c.noteCandidate(key, account);
    for (const n of sel.notes) h.note(key, 'build', redact(n, secrets));
    const out = await runBuild({
      provider: builder,
      ...(cand.account !== DEFAULT_ACCOUNT ? { account } : {}),
      sel,
      repoPath: repo.path,
      worktree: wt,
      baseSha: run.baseSha,
      subject,
      trailer: itemMarker(cur.id, nonce),
      rev: run.rev,
      prompt,
      name: `conductor ${run.key} build ${cur.id} ${cur.loop}`,
      onEvent: h.emitter(key, 'build', cur.loop, run.rev),
      signal: h.c.signal(key),
      secrets,
      planPaths: exemptPaths(run, plan),
      onPrepared: (prep) => {
        h.patch(key, (r) => {
          r.guardSha = prep.guardSha ?? undefined;
          r.guardEnvOnly = prep.envOnly;
        });
        if (prep.note) h.note(key, 'build', prep.note);
      },
      onResult: (res) => {
        h.c.agents.noteRunResult(builder.id, sel, res, cand.account);
        h.finishSession(key, res);
        h.refundIfLimit(key, res);
        if (res.ok) h.patch(key, (r) => void (r.buildFails = 0));
      },
    });

    switch (out.kind) {
      case 'held': {
        // a safety stop (guard, protected paths, git settings): the whole run waits for a person; the item is not failed, just not done.
        // Complete auto: credential-shaped text that is only in tests/fixtures gets one rewrite instead.
        if (this.queueFixtureRewrite(key, id, out.reason)) return;
        this.setItem(key, id, (x) => {
          x.state = 'pending';
          x.startHead = undefined;
          x.nonce = undefined;
          x.note = truncate(out.reason, 600);
        });
        return h.toNeedsHuman(key, out.reason, 'build');
      }
      case 'failed': {
        const res = out.res;
        if (res.errorKind === 'aborted') return; // stays `running`; recovery decides on the next start
        this.setItem(key, id, (x) => {
          x.state = 'pending';
          x.startHead = undefined;
          x.nonce = undefined;
        });
        if (res.errorKind === 'limit') return h.pauseForLimit(key, { ...(res.limit ?? { resetsAt: null, message: res.error ?? 'limit' }), provider: out.provider, account: cand.account }, role);
        if (res.errorKind === 'network') return h.applyHold(key, { type: 'offline', message: res.error ?? 'network unreachable' });
        if (res.errorKind === 'spawn') return h.toNeedsHuman(key, res.error ?? 'agent could not start', 'build');
        if (await h.looksOffline(res)) {
          h.refundRun(key);
          return h.applyHold(key, { type: 'offline', message: res.error ?? 'network unreachable' });
        }
        const tries = h.run(key).buildFails ?? 0;
        h.patch(key, (r) => {
          r.buildFails = tries + 1;
          r.history.push({ ts: h.c.clock.now(), text: `Build attempt at ${id} failed: ${truncate(res.error ?? 'error', 120)}` });
        });
        if (tries < 1) {
          h.note(key, 'build', `${providerLabel(out.provider)} failed (${truncate(res.error ?? '', 160)}) — retrying once.`);
          return;
        }
        h.patch(key, (r) => void (r.buildFails = 0));
        return this.failItem(key, id, `${providerLabel(out.provider)} failed twice: ${truncate(res.error ?? 'unknown error', 300)}`, wt);
      }
      case 'hook':
        h.patch(key, (r) => void (r.commitNote = truncate(out.detail, 4000)));
        return this.retryOrFail(key, id, 'The repository commit hook rejected the build', undefined, wt);
      case 'nothing': {
        // the builder may have committed by itself: accept real work (after the same checks) instead of calling it "no changes"
        const headNow = await gitOk(wt, ['rev-parse', 'HEAD']).catch(() => '');
        if (headNow && headNow !== startHead && !(await h.hasUncommitted(wt))) {
          const files = (await gitOk(wt, ['diff', '--name-only', '-z', startHead, headNow])).split('\0').filter(Boolean);
          h.note(key, 'build', `The builder committed ${id} by itself — keeping it after the usual checks.`);
          return void (await this.finishItem(key, id, headNow, files, plan, 'self', startHead, wt));
        }
        return this.failItem(key, id, 'The builder finished without changing any files. The task may need to be clarified.', wt);
      }
      case 'committed':
        return void (await this.finishItem(key, id, out.sha, out.files, plan, 'built', undefined, wt));
    }
    } finally {
      this.landRelease.get(key)?.get(id)?.();
      const after = h.run(key);
      const kept = after.graph?.items.find((i) => i.id === id);
      const keep = !!after.commitNote && kept?.state === 'pending';
      if (!keep) await W.removeDetachedBuild(repo.path, wt).catch(() => undefined);
      release();
    }
  }

  /**
   * A build item has a commit. (adopted/self-made commits get the scope + secret checks the envelope already ran for a live build)
   * Then the item's gates decide: no regression ⇒ `done`; a regression ⇒ another attempt, or `failed` when the item's loop budget is spent.
   */
  private async finishItem(key: string, id: string, sha: string, files: string[], plan: Plan, how: 'built' | 'adopted' | 'self', scopeSince?: string, wt?: string): Promise<'ok' | 'stop'> {
    const h = this.h;
    const run = h.run(key);
    const repo = h.repo(run);
    const dir = wt ?? run.worktree;
    if (how !== 'built') {
      const problem = await postBuildChecks(dir, run.baseSha, exemptPaths(run, plan), h.c.secretsFor(run), scopeSince);
      if (problem) {
        if (this.queueFixtureRewrite(key, id, problem, dir === run.worktree ? sha : undefined)) return 'stop';
        this.setItem(key, id, (x) => {
          x.state = 'pending';
          x.startHead = undefined;
          x.nonce = undefined;
          x.note = truncate(problem, 600);
        });
        await h.toNeedsHuman(key, problem, 'build');
        return 'stop';
      }
    }
    let regression: GateComparison | null = null;
    if (repo.gates.length) {
      await h.reinstallIfLockChanged(key, 'build', dir);
      const baseline = h.c.store.readArtifact<GateRun | null>(key, 'baseline.json', null);
      const current = await h.runAllGates(key, repo, repo.gates, dir);
      if (this.aborted(key)) return 'stop';
      const cmp = G.compareGates(baseline, current);
      h.c.store.writeArtifact(key, `gates-item-${id}-${this.item(key, id).loop}.json`, { run: current, comparison: cmp });
      if (cmp.regressions.length) regression = cmp;
    }
    if (regression) {
      const feedback = regression.regressions
        .map((r) => `- gate \`${r.gate}\`: ${r.newFailures.length ? r.newFailures.slice(0, 15).join('; ') : r.note ?? 'now failing'}`)
        .join('\n');
      await this.retryOrFail(key, id, `Quality gates regress (${regression.regressions.map((r) => r.gate).join(', ')})`, feedback, dir);
      return 'ok';
    }
    const peers = this.landGates.get(key);
    if (peers) {
      const n = Number(id.replace(/\D/g, '')) || 0;
      const lower = [...peers.keys()].filter((i) => (Number(i.replace(/\D/g, '')) || 0) < n);
      await Promise.all(lower.map((i) => peers.get(i)!));
    }
    const landed = await W.mergeOntoCurrent(repo.path, sha);
    if (!landed.ok) {
      let kept = '';
      try {
        const refs = await W.backupRefs(dir, run.key, run.rev);
        kept = ` The commit is kept as ${refs.headRef}.`;
      } catch {
        /* the private directory is removed after this; the message still tells the person what conflicted */
      }
      this.setItem(key, id, (x) => {
        x.state = 'pending';
        x.startHead = undefined;
        x.nonce = undefined;
        x.note = truncate(landed.detail, 600);
      });
      await h.toNeedsHuman(key, `${landed.detail}.${kept}`, 'build');
      return 'stop';
    }
    sha = landed.sha;
    void h.c.context.refresh(h.run(key), repo).then(() => h.c.context.refresh(h.run(key), repo)).catch(() => undefined);
    const title = this.item(key, id).title;
    h.patch(key, (r) => {
      const x = r.graph!.items.find((i) => i.id === id)!;
      x.state = 'done';
      x.commitSha = sha;
      x.startHead = undefined;
      x.nonce = undefined;
      x.feedback = undefined;
      x.floor = undefined;
      x.note = undefined;
      r.commitSha = sha;
      r.commitNote = undefined;
      r.buildFails = 0;
      r.history.push({ ts: h.c.clock.now(), text: `Task ${id} done: ${files.length} file(s) committed (${sha.slice(0, 7)})${how === 'adopted' ? ' — adopted after a restart' : ''}` });
    });
    await this.cardNote(key, id, 'done', `✅ **${id} done** — ${sanitizeLine(title, 120)}\n\nCommit \`${sha.slice(0, 12)}\` · ${files.length} file(s)${files.length ? `: ${files.slice(0, 8).map((f) => `\`${sanitizeLine(f, 80).replace(/`/g, "'")}\``).join(', ')}` : ''}`);
    return 'ok';
  }

  /** Another attempt at the item with the given feedback, or — when its loop budget is spent — the item fails. */
  private async retryOrFail(key: string, id: string, why: string, feedback: string | undefined, buildWt?: string): Promise<void> {
    const h = this.h;
    const it = this.item(key, id);
    if (it.loop >= it.loopBudget) return this.failItem(key, id, `${why}, and the attempt limit (${it.loopBudget}) for this task is reached.`, buildWt);
    this.setItem(key, id, (x, r) => {
      x.state = 'pending';
      x.loop += 1;
      x.startHead = undefined;
      x.nonce = undefined;
      x.feedback = feedback ? truncate(feedback, 4_000) : undefined;
      r.history.push({ ts: h.c.clock.now(), text: `${why} — task ${id} gets another attempt (${x.loop}/${x.loopBudget})` });
    });
    h.note(key, 'build', `${why} — ${id} gets another attempt.`);
  }

  /**
   * The item failed for good. Its commits are backed up and the branch goes back to where the item began, so independent items continue on
   * good code (a half-working item never poisons them); Retry runs it again from there.
   */
  private async failItem(key: string, id: string, reason: string, buildWt?: string): Promise<void> {
    const h = this.h;
    const run = h.run(key);
    const it = this.item(key, id);
    const wt = buildWt ?? run.worktree;
    const onBranch = wt === run.worktree;
    let backup = '';
    try {
      const head = (await gitOk(wt, ['rev-parse', 'HEAD'])).trim();
      const dirty = await h.hasUncommitted(wt);
      if (it.floor && SHA_RE.test(it.floor) && (head !== it.floor || dirty)) {
        const refs = await W.backupRefs(wt, run.key, run.rev);
        if (onBranch && !(await this.resetWouldDropDone(key, it.floor))) await W.resetToCommit(wt, it.floor);
        backup = ` Its work is kept as ${refs.headRef}${refs.stashRef ? ` and ${refs.stashRef}` : ''} in the repository.`;
      }
    } catch (e) {
      backup = ` (The work could not be backed up and reset: ${truncate(String((e as Error)?.message ?? e), 120)} — it is still on the branch.)`;
    }
    const secrets = h.c.secretsFor(h.run(key));
    this.setItem(key, id, (x, r) => {
      x.state = 'failed';
      x.startHead = undefined;
      x.nonce = undefined;
      x.feedback = undefined;
      x.note = truncate(redact(reason, secrets), 600);
      r.commitNote = undefined;
      r.history.push({ ts: h.c.clock.now(), text: `Task ${id} failed: ${truncate(redact(reason, secrets), 160)}` });
    });
    await this.cardNote(key, id, `failed:${this.item(key, id).agentRuns}`, `❌ **${id} failed** — ${truncate(redact(reason, secrets), 600)}${backup}`);
  }

  // ───────────────────────── prompt blocks ─────────────────────────
  private itemBlock(it: ItemRun): string {
    return fence(
      'task-item',
      [
        `Id: ${it.id}`,
        `Role: ${it.role}`,
        `Title: ${sanitizeLine(it.title, 160)}`,
        '',
        'Objective:',
        it.objective,
        '',
        `Files: ${it.files.join(', ') || '(none — read-only task)'}`,
        `Acceptance criteria: ${it.criteria.join(', ') || '(none)'}`,
        it.verification.length ? `Checks to run: ${it.verification.join('; ')}` : '',
      ]
        .filter((l, i, a) => l !== '' || a[i - 1] !== '')
        .join('\n'),
      4_000,
    );
  }
  private othersBlock(run: Run): string {
    const items = run.graph!.items;
    return fence('task-list', items.map((i) => `- ${i.id} [${i.role}, ${i.state}] ${sanitizeLine(i.title, 120)}${i.dependsOn.length ? ` (after ${i.dependsOn.join(', ')})` : ''}`).join('\n'), 3_000);
  }
  /** Results of the tasks this one builds on (transitively): commits for build tasks, the capped notes for analysis tasks. */
  private priorWork(key: string, it: ItemRun): string {
    const run = this.h.run(key);
    const lines: string[] = [];
    for (const a of ancestorsOf(run.graph!.items, it.id)) {
      if (a.state !== 'done') continue;
      if (ANALYSIS_ROLES.has(a.role)) {
        const n = this.h.c.store.readArtifact<ItemNote | null>(key, `item-${run.rev}-${a.id}.json`, null);
        if (!n) continue;
        const note = capNote(n);
        lines.push(`### ${a.id} (${a.role}) — ${sanitizeLine(a.title, 120)}`, note.summary, ...(note.decisions.length ? ['Decisions:', ...note.decisions.map((d) => `- ${d}`)] : []), '');
      } else {
        lines.push(`- ${a.id} "${sanitizeLine(a.title, 120)}" is already committed${a.commitSha ? ` (${a.commitSha.slice(0, 7)})` : ''} — build on it, do not redo it.`);
      }
    }
    return lines.length ? fence('earlier-task-notes', lines.join('\n'), NOTES_TOTAL_MAX) : '';
  }
}

