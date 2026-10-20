// The runtime face of the context engine (M4): what the pipeline calls. Every method is best-effort — a context problem is logged and the run
// carries on without it (it must never fail or block a run; plan §2.3 / M4-AC8).
import type { Board } from '../board/index.ts';
import type { Config, ProjectContextSettings, RepoConfig, Run } from '../types.ts';
import { logger } from '../log.ts';
import { errMsg } from '../util.ts';
import { git } from '../git/exec.ts';
import type { BoardFacts } from './pack.ts';
import { PACK_DEFAULT_BYTES, buildPack, historyBlock, noBoardFacts, type Consumer } from './pack.ts';
import { DEFAULT_STALE_DAYS, refreshContext, type RefreshResult } from './incremental.ts';
import { liveFacts } from './live.ts';
import { appendHistory, readHistory, type DigestStatus } from './history.ts';
import { SCAN_ENV, isObjectId } from './gitread.ts';
import { isIdent } from './facts.ts';
import { refreshSummaries, summariesBlock } from './summaries.ts';
import { loadContext } from './store.ts';

const log = logger('context');
const PACK_TIMEOUT_MS = 20_000;

export interface ContextBlocks {
  /** Deterministic facts (+ board-derived text), raw — the caller fences it. Empty when unavailable. */
  facts: string;
  /** Read-only stages only: previously completed tasks. Empty for a builder. */
  history: string;
  /** Read-only stages only, and only when the project opted in: still-valid module summaries. */
  notes: string;
}

/** What the stages need; the engine passes the real service, tests may pass a stub. */
export interface ContextLike {
  blocks(run: Run, repo: RepoConfig, consumer: Consumer, files?: string[]): Promise<ContextBlocks>;
  refresh(run: Run, repo: RepoConfig): Promise<RefreshResult | null>;
  digest(run: Run, repo: RepoConfig): Promise<string | null>;
}

export const projectKeyOf = (runKey: string): string | null => {
  const m = /^([A-Z]{2,6})-\d{1,9}$/.exec(runKey);
  return m ? m[1]! : null;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<null>((r) => (t = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(t));
}

export function boardFactsFor(board: Board, projectId: string, selfItemId: string): BoardFacts {
  const open = (lane: string): boolean => lane !== 'done' && lane !== 'canceled';
  return {
    milestones: board.milestones(projectId).filter((m) => m.status === 'open').slice(-8).map((m) => m.title),
    cards: board
      .items({ projectId, parentId: null })
      .filter((i) => i.id !== selfItemId && open(i.lane) && i.kind !== 'subtask' && i.kind !== 'bug')
      .slice(-30)
      .map((i) => ({ key: i.key, title: i.title, lane: i.lane, user: i.createdBy === 'user', kind: i.kind })),
    decisions: board.decisions(projectId).slice(-20).map((d) => ({ title: d.title, body: d.body, user: d.author === 'user' })),
    bugs: board.items({ projectId, kind: 'bug' }).filter((i) => open(i.lane)).slice(-15).map((i) => ({ key: i.key, title: i.title })),
  };
}

export class ContextService implements ContextLike {
  private board: Board;
  private getConfig: () => Config;
  private now: () => number;
  private summarise?: (prompt: string) => Promise<unknown | null>;
  constructor(deps: { board: Board; getConfig: () => Config; now?: () => number; summarise?: (prompt: string) => Promise<unknown | null> }) {
    this.summarise = deps.summarise;
    this.board = deps.board;
    this.getConfig = deps.getConfig;
    this.now = deps.now ?? Date.now;
  }

  settings(projectKey: string): ProjectContextSettings {
    const s = this.getConfig().projects?.[projectKey]?.context;
    return s ?? { summaries: false, staleDays: DEFAULT_STALE_DAYS, packBytes: PACK_DEFAULT_BYTES };
  }

  async blocks(run: Run, repo: RepoConfig, consumer: Consumer, files: string[] = []): Promise<ContextBlocks> {
    const empty: ContextBlocks = { facts: '', history: '', notes: '' };
    try {
      const projectKey = projectKeyOf(run.key);
      if (!projectKey || !isObjectId(run.baseSha)) return empty;
      const item = this.board.item(run.itemId);
      const live = await withTimeout(liveFacts({ name: repo.name, path: repo.path, baseBranch: repo.baseBranch, gates: repo.gates }, run.baseSha), PACK_TIMEOUT_MS);
      if (!live) return empty;
      const pack = buildPack({
        facts: live.facts,
        consumer,
        task: `${run.title}\n${run.description}`,
        files,
        budgetBytes: this.settings(projectKey).packBytes,
        commit: run.baseSha,
        branch: repo.baseBranch,
        board: item ? boardFactsFor(this.board, item.projectId, item.id) : noBoardFacts(),
      });
      let history = '';
      if (consumer === 'readonly') {
        try {
          history = historyBlock(readHistory(projectKey).filter((h) => h.key !== run.key));
        } catch (e) {
          log.warn(`${run.key}: history unreadable: ${errMsg(e)}`);
        }
      }
      let notes = '';
      if (consumer === 'readonly' && this.settings(projectKey).summaries) {
        const ctx = loadContext(projectKey);
        if (ctx.state === 'ok') notes = summariesBlock(projectKey, Object.fromEntries(ctx.manifest.tops.map((t) => [t.path, t.treeSha])));
      }
      return { facts: pack.text, history, notes };
    } catch (e) {
      log.warn(`${run.key}: context pack unavailable: ${errMsg(e)}`);
      return empty;
    }
  }

  async refresh(run: Run, repo: RepoConfig): Promise<RefreshResult | null> {
    const projectKey = projectKeyOf(run.key);
    if (!projectKey) return null;
    const r = await refreshContext(projectKey, { name: repo.name, path: repo.path, baseBranch: repo.baseBranch, gates: repo.gates }, { staleDays: this.settings(projectKey).staleDays, now: this.now });
    if (this.summarise && this.settings(projectKey).summaries && r.status.state === 'fresh') {
      void refreshSummaries(projectKey, { call: this.summarise, perDay: this.getConfig().pipeline.contextRunsPerDay, now: this.now() }).catch((e) => log.warn(`${projectKey}: summaries failed: ${errMsg(e)}`));
    }
    return r;
  }

  /** Append the run's outcome line when it rests (idempotent per `status:rev:loop`). Returns the mark, or null when nothing was due/possible. */
  async digest(run: Run, repo: RepoConfig): Promise<string | null> {
    const status = run.status as string;
    if (!['ready', 'finished', 'needs_human', 'aborted'].includes(status)) return null;
    const projectKey = projectKeyOf(run.key);
    if (!projectKey) return null;
    const mark = `${status}:${run.rev}:${run.loop}`;
    if (run.digestMark === mark) return null;
    try {
      let files: string[] = [];
      if (isObjectId(run.baseSha) && isObjectId(run.commitSha)) {
        const r = await git(repo.path, ['diff', '--name-only', '-z', run.baseSha, run.commitSha], { env: { ...SCAN_ENV }, timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
        if (r.code === 0) files = r.stdout.split('\0').filter((f) => f && isIdent(f)).slice(0, 50);
      }
      appendHistory(projectKey, {
        key: run.key,
        title: run.title,
        status: status as DigestStatus,
        at: this.now(),
        files,
        verdict: run.verdict,
        loops: run.loop,
        itemCount: run.graph?.items.length ?? 1,
        mark,
      });
      return mark;
    } catch (e) {
      log.warn(`${run.key}: could not record the outcome digest: ${errMsg(e)}`);
      return null;
    }
  }
}
