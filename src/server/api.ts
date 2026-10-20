import { basename, resolve } from 'node:path';
import type {
  ApiRepo, ApiRunDetail, ApiSetupStep, ApiState, Config, LogEvent, RepoConfig, Settings,
} from '../types.ts';
import type { Board } from '../board/index.ts';
import { BoardError } from '../board/index.ts';
import type { Engine } from '../pipeline/engine.ts';
import { EngineError } from '../pipeline/engine.ts';
import type { RunStore } from '../store.ts';
import type { PersistentState } from '../config.ts';
import { applySettings, toSettings } from '../config.ts';
import { toDetail, toSummary } from '../pipeline/view.ts';
import { detectGates } from '../git/gates.ts';
import { inspectRepo } from '../git/worktree.ts';
import { errMsg, truncate } from '../util.ts';
import { OpenError, openRun, type ExecFn } from './open.ts';
import type { Auth } from './auth.ts';

export class ApiFail extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiFail';
    this.status = status;
    this.code = code;
  }
}

export interface ApiResult {
  status?: number;
  json?: unknown;
  /** Set to clear the session cookie. */
  logout?: boolean;
}

export interface ApiDeps {
  engine: Engine;
  store: RunStore;
  board: Board;
  auth: Auth;
  version: string;
  getConfig(): Config;
  saveConfig(cfg: Config): void;
  persistent(): PersistentState;
  health(): Promise<ApiState['health']>;
  probe(target: 'claude' | 'cursor'): Promise<{ ok: boolean; detail: string; durationMs: number }>;
  openExec?: ExecFn;
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;
// L5: a name is used as a path segment — it must start with a letter/digit (no `.`, `..`, `-x`)
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** L8: a malformed %-escape must be a 400, not an exception. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new ApiFail(400, 'bad_request', 'Malformed URL.');
  }
}

function boardStatus(code: string): number {
  if (code === 'not_found') return 404;
  if (code.startsWith('forbidden')) return 403;
  if (code === 'storage_failed' || code === 'closed') return 503;
  if (code === 'exists' || code === 'cycle' || code === 'archived' || code === 'read_only' || code === 'full') return 409;
  return 400;
}

function str(v: unknown, name: string, max: number, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiFail(400, 'bad_request', `"${name}" is required.`);
    return '';
  }
  if (typeof v !== 'string') throw new ApiFail(400, 'bad_request', `"${name}" must be text.`);
  if (v.length > max) throw new ApiFail(400, 'bad_request', `"${name}" is too long (max ${max} characters).`);
  return v;
}

export class Api {
  private d: ApiDeps;
  private healthCache: { at: number; value: ApiState['health'] } | null = null;

  constructor(deps: ApiDeps) {
    this.d = deps;
  }

  // ───────────────────────── reads ─────────────────────────
  /** Cards that have no run yet (Backlog / To do …) — part of the live feed so a card never shows twice while it is being claimed. */
  private cards(ignored: { key: string; reason: string }[] | undefined): ApiState['cards'] {
    const why = new Map((ignored ?? []).map((i) => [i.key, i.reason]));
    return this.d.board
      .items({ parentId: null })
      .filter((i) => !this.d.store.has(i.key) && i.kind !== 'bug' && i.kind !== 'subtask' && ['backlog', 'todo', 'active', 'needs_you', 'review'].includes(i.lane))
      .map((i) => ({ key: i.key, title: i.title, lane: i.lane, kind: i.kind, createdAt: i.createdAt, updatedAt: i.updatedAt, note: why.get(i.key) }));
  }

  live(): { now: number; runs: ApiState['runs']; engine: ApiState['engine']; quota: ApiState['quota']; cards: ApiState['cards'] } {
    const cfg = this.d.getConfig();
    const now = Date.now();
    const st = this.d.engine.status();
    // Say WHICH Claude is limited: Conductor uses the `claude` CLI login, which can differ from the Claude desktop app's account.
    const providerPause = { ...st.providerPause };
    const claudeHealth = this.healthCache?.value.claude;
    if (providerPause.claude && claudeHealth?.found && claudeHealth.detail) {
      providerPause.claude = {
        ...providerPause.claude,
        reason: `${providerPause.claude.reason} — Conductor uses the "claude" command-line tool (${claudeHealth.detail}). That login can be a different plan from the Claude desktop app. To switch it run: claude auth logout && claude auth login`,
      };
    }
    return {
      now,
      runs: this.d.store.list().map((r) => toSummary(r, cfg, now)),
      engine: {
        paused: st.paused,
        pauseReason: st.pauseReason,
        providerPause,
        running: st.running,
        maxParallel: st.maxParallel,
        lastPollAt: st.lastPollAt,
        lastPollError: st.lastPollError,
        pollSeconds: st.pollSeconds,
        ignored: st.ignored,
        storageProblem: st.storageProblem,
      },
      quota: st.quota,
      cards: this.cards(st.ignored),
    };
  }

  private async cachedHealth(): Promise<ApiState['health']> {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.at < 30_000) return this.healthCache.value;
    const value = await this.d.health();
    this.healthCache = { at: now, value };
    return value;
  }

  async state(): Promise<ApiState> {
    const cfg = this.d.getConfig();
    const health = await this.cachedHealth();
    const persist = this.d.persistent();
    const steps: ApiSetupStep[] = [
      { id: 'agents', label: 'Claude and Cursor are installed and signed in', ok: health.claude.ok && health.cursor.ok, detail: [health.claude.ok ? undefined : `Claude: ${health.claude.detail}`, health.cursor.ok ? undefined : `Cursor: ${health.cursor.detail}`].filter(Boolean).join(' · ') || undefined },
      { id: 'repo', label: 'A repository is registered', ok: cfg.repos.length > 0, detail: cfg.repos.length ? cfg.repos.map((r) => r.name).join(', ') : undefined },
    ];
    const live = this.live();
    return {
      now: live.now,
      version: this.d.version,
      csrf: this.d.auth.csrf,
      // Agent health is a banner, not a gate: a Claude sign-out must not send a configured user back to the wizard.
      setup: { complete: steps.filter((s) => s.id !== 'agents').every((s) => s.ok), steps },
      health,
      quota: live.quota,
      engine: live.engine,
      settings: toSettings(cfg),
      repos: cfg.repos.map((r) => this.repoView(r, persist)),
      runs: live.runs,
      cards: live.cards,
    };
  }

  private repoView(r: RepoConfig, persist: PersistentState): ApiRepo {
    return {
      name: r.name,
      path: r.path,
      baseBranch: r.baseBranch,
      gates: r.gates,
      approvedPlans: persist.repos[r.name]?.approvedPlans ?? 0,
      noGates: r.gates.length === 0,
      warnings: r.gates.length === 0 ? ['No test/lint/typecheck commands detected — runs will be flagged "unverified".'] : [],
    };
  }

  runDetail(key: string): ApiRunDetail {
    if (!KEY_RE.test(key)) throw new ApiFail(404, 'not_found', 'Unknown run.');
    const run = this.d.store.get(key);
    if (!run) throw new ApiFail(404, 'not_found', 'Unknown run.');
    const notes = this.d.board.comments(run.itemId).map((c) => ({ id: c.id, author: c.author, body: c.body, ts: c.ts }));
    return { ...toDetail(this.d.store, run, this.d.getConfig(), Date.now()), notes };
  }

  /** Everything the board view needs: projects + top-level items (children are fetched with the item). */
  boardView(): { projects: ReturnType<Board['projects']>; items: ReturnType<Board['items']>; milestones: ReturnType<Board['milestones']> } {
    return { projects: this.d.board.projects(), items: this.d.board.items().slice(-2000), milestones: this.d.board.milestones() };
  }

  itemView(key: string) {
    if (!KEY_RE.test(key)) throw new ApiFail(404, 'not_found', 'Unknown card.');
    const item = this.d.board.item(key);
    if (!item) throw new ApiFail(404, 'not_found', 'Unknown card.');
    return { item, comments: this.d.board.comments(item.id), children: this.d.board.children(item.id), decisions: this.d.board.decisions(item.projectId).filter((d) => !d.itemId || d.itemId === item.id) };
  }

  runLog(key: string, after: number, limit: number): { events: LogEvent[]; next: number } {
    if (!KEY_RE.test(key) || !this.d.store.get(key)) throw new ApiFail(404, 'not_found', 'Unknown run.');
    return this.d.store.readEvents(key, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 500);
  }

  // ───────────────────────── mutations ─────────────────────────
  async handle(method: string, path: string, query: URLSearchParams, body: any): Promise<ApiResult> {
    try {
      return await this.route(method, path, query, body ?? {});
    } catch (e) {
      if (e instanceof ApiFail) throw e;
      if (e instanceof EngineError) throw new ApiFail(e.code === 'missing' ? 404 : e.code === 'bad_lane' || e.code === 'bad_repo' ? 400 : 409, e.code, e.message);
      if (e instanceof BoardError) throw new ApiFail(boardStatus(e.code), e.code, e.message);
      if (e instanceof OpenError) throw new ApiFail(e.code === 'bad_target' ? 400 : 409, e.code, e.message);
      throw e;
    }
  }

  private async route(method: string, path: string, q: URLSearchParams, body: any): Promise<ApiResult> {
    let m: RegExpExecArray | null;
    if (method === 'GET') {
      if (path === '/api/state') return { json: await this.state() };
      if ((m = /^\/api\/runs\/([^/]+)$/.exec(path))) return { json: this.runDetail(safeDecode(m[1]!)) };
      if (path === '/api/board') return { json: this.boardView() };
      if ((m = /^\/api\/items\/([^/]+)$/.exec(path))) return { json: this.itemView(safeDecode(m[1]!)) };
      if ((m = /^\/api\/runs\/([^/]+)\/log$/.exec(path))) {
        return { json: this.runLog(safeDecode(m[1]!), Number(q.get('after') ?? 0), Number(q.get('limit') ?? 500)) };
      }
      throw new ApiFail(404, 'not_found', 'No such endpoint.');
    }

    if (method === 'POST' && path === '/api/auth/logout') return { json: { ok: true }, logout: true };

    if (method === 'POST' && path === '/api/tasks') {
      const title = str(body.title, 'title', 200).trim();
      if (!title) throw new ApiFail(400, 'bad_request', '"title" is required.');
      const description = str(body.description, 'description', 10_000, false);
      const repo = str(body.repo, 'repo', 64, false);
      const r = await this.d.engine.createTask({ title, description, repo: repo || undefined });
      return { status: 201, json: { ok: true, key: r.key, url: r.url } };
    }

    if ((m = /^\/api\/runs\/([^/]+)\/(approve|retry|resume|abort|cleanup|open)$/.exec(path)) && method === 'POST') {
      const key = safeDecode(m[1]!);
      if (!KEY_RE.test(key) || !this.d.store.get(key)) throw new ApiFail(404, 'not_found', 'Unknown run.');
      switch (m[2]) {
        case 'approve':
          if (typeof body.rev !== 'number' || !Number.isInteger(body.rev)) throw new ApiFail(400, 'bad_request', '"rev" (the plan revision you are approving) is required.');
          this.d.engine.approve(key, 'human', body.rev);
          break;
        case 'retry':
          await this.d.engine.retry(key);
          break;
        case 'resume':
          this.d.engine.resume(key);
          break;
        case 'abort':
          await this.d.engine.abort(key);
          break;
        case 'cleanup':
          await this.d.engine.cleanup(key);
          break;
        case 'open': {
          const r = await openRun(this.d.store.get(key)!, this.d.getConfig(), String(body.target ?? ''), this.d.openExec);
          return { json: { ok: true, detail: r.detail } };
        }
      }
      return { json: { ok: true } };
    }

    // ───────── board (the ONLY write surface for request bodies is board.user / engine commands — authorship is server-side) ─────────
    if (method === 'POST' && path === '/api/projects') {
      const p = this.d.board.user.createProject({ key: str(body.key, 'key', 6), name: str(body.name, 'name', 120), repo: str(body.repo, 'repo', 64, false) });
      return { status: 201, json: { ok: true, project: p } };
    }
    if ((m = /^\/api\/items\/([^/]+)\/(move|comment|edit)$/.exec(path)) && method === 'POST') {
      const key = safeDecode(m[1]!);
      if (!KEY_RE.test(key) || !this.d.board.item(key)) throw new ApiFail(404, 'not_found', 'Unknown card.');
      if (m[2] === 'move') {
        await this.d.engine.applyHumanMove(key, str(body.lane, 'lane', 20)); // cards with a run go through the engine (K2); the lane is never written directly
        return { json: { ok: true } };
      }
      if (m[2] === 'comment') {
        const c = this.d.board.user.comment(key, str(body.body, 'body', 20_000));
        this.d.engine.tickSoon();
        return { status: 201, json: { ok: true, comment: c } };
      }
      const it = this.d.board.user.setFields(key, { title: body.title === undefined ? undefined : str(body.title, 'title', 200), description: body.description === undefined ? undefined : str(body.description, 'description', 10_000, false) });
      return { json: { ok: true, item: it } };
    }

    if (method === 'POST' && path === '/api/engine/pause') {
      if (typeof body.paused !== 'boolean') throw new ApiFail(400, 'bad_request', '"paused" must be true or false.');
      this.d.engine.setPaused(body.paused);
      return { json: { ok: true } };
    }

    if (method === 'PUT' && path === '/api/settings') {
      const next = applySettings(this.d.getConfig(), body as Partial<Settings>);
      this.d.saveConfig(next);
      this.d.engine.invalidate();
      return { json: { ok: true, settings: toSettings(next) } };
    }

    // ───────── setup wizard ─────────
    if (method === 'POST' && path === '/api/setup/repo') {
      const raw = str(body.path, 'path', 1000).trim();
      if (/[\x00-\x1f\x7f]/.test(raw)) throw new ApiFail(400, 'bad_request', 'That path contains control characters.'); // L7
      if (!raw.startsWith('/') && !raw.startsWith('~')) throw new ApiFail(400, 'bad_request', 'Enter the full folder path, e.g. /Users/you/code/my-app');
      const p = raw.startsWith('~') ? resolve(process.env.HOME ?? '/', raw.slice(2)) : resolve(raw);
      let info: Awaited<ReturnType<typeof inspectRepo>>;
      try {
        info = await inspectRepo(p);
      } catch (e) {
        throw new ApiFail(400, 'bad_repo', errMsg(e));
      }
      const cfg = this.d.getConfig();
      let name = str(body.name, 'name', 64, false) || basename(info.root).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'repo';
      if (!REPO_NAME_RE.test(name)) throw new ApiFail(400, 'bad_request', 'Name may only contain letters, numbers, dots, dashes and underscores.');
      if (cfg.repos.some((r) => r.name.toLowerCase() === name.toLowerCase() && r.path !== info.root)) name = `${name}-${cfg.repos.length + 1}`;
      const gates = await detectGates(info.root);
      const repo: RepoConfig = { name, path: info.root, baseBranch: info.defaultBranch, gates, copyFiles: ['.env', '.env.local'], envPassthrough: [] };
      const repos = [...cfg.repos.filter((r) => r.path !== info.root), repo];
      this.d.saveConfig({ ...cfg, repos });
      this.healthCache = null;
      return { json: { ok: true, repo: this.repoView(repo, this.d.persistent()) } };
    }

    if (method === 'DELETE' && (m = /^\/api\/setup\/repo\/([^/]+)$/.exec(path))) {
      const name = safeDecode(m[1]!);
      const cfg = this.d.getConfig();
      if (!cfg.repos.some((r) => r.name === name)) throw new ApiFail(404, 'not_found', 'Unknown repository.');
      if (this.d.store.list().some((r) => r.repo === name && !['finished', 'aborted', 'ready'].includes(r.status))) {
        throw new ApiFail(409, 'in_use', 'This repository has active runs. Abort or finish them first.');
      }
      this.d.saveConfig({ ...cfg, repos: cfg.repos.filter((r) => r.name !== name) });
      return { json: { ok: true } };
    }

    if (method === 'POST' && path === '/api/setup/probe') {
      const t = body.target;
      if (t !== 'claude' && t !== 'cursor') throw new ApiFail(400, 'bad_request', '"target" must be claude or cursor.');
      const r = await this.d.probe(t);
      return { json: { ok: r.ok, detail: r.detail, durationMs: r.durationMs } };
    }

    throw new ApiFail(404, 'not_found', 'No such endpoint.');
  }
}
