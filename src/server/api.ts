import { basename, resolve } from 'node:path';
import type {
  AgentHealth, ApiProvider, ApiRepo, ApiRoles, ApiRunDetail, ApiSetupStep, ApiState, Config, LogEvent, ProviderId, RepoConfig, Settings,
} from '../types.ts';
import type { Board } from '../board/index.ts';
import { BoardError } from '../board/index.ts';
import type { Engine } from '../pipeline/engine.ts';
import { EngineError } from '../pipeline/engine.ts';
import type { RunStore } from '../store.ts';
import type { PersistentState } from '../config.ts';
import { applySettings, normalizeConfig, toSettings } from '../config.ts';
import { PROVIDER_IDS, isProviderId, providerLabel } from '../agents/providers/registry.ts';
import { COMPLEXITIES, ROLES, ROLE_NEEDS, isComplexity, isRole, type RoleConfig, type Roles } from '../agents/roles.ts';
import { validatePairing, type ProviderState } from '../agents/routing.ts';
import { redact } from '../redact.ts';
import { addRecord, buildVerificationInfo, loadRecords } from '../agents/providers/verification.ts';
import type { CanaryReport } from '../agents/providers/canary.ts';
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
  /** The Codex isolation canary (spends quota). Absent ⇒ the endpoint answers 501. */
  canary?(id: 'codex'): Promise<CanaryReport>;
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

/** A fixed repair instruction per provider. Never CLI-originated text; Conductor shows it and never runs it. */
const PROVIDER_HINT: Record<ProviderId, string> = {
  claude: 'Install Claude Code from https://claude.com/claude-code, then run `claude` once to sign in.',
  cursor: 'Install the Cursor agent: curl https://cursor.com/install -fsS | bash — then run `agent login`.',
  codex: 'Install Codex (npm i -g @openai/codex), then sign in with Conductor\'s private home: CODEX_HOME=~/.conductor-v2/providers/codex-home codex login — Conductor never runs either command for you.',
};
/** Said once when a provider is first given a role: where the task text goes. */
const EGRESS: Record<ProviderId, string> = {
  claude: 'Task text and repository content for this role are sent to Anthropic through your Claude Code login.',
  cursor: 'Task text and repository content for this role are sent to Cursor through your Cursor agent login.',
  codex: 'Task text and repository content for this role are sent to OpenAI through the Codex login in Conductor\'s private home.',
};
const CANARY_COOLDOWN_MS = 60_000;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class Api {
  private d: ApiDeps;
  private canaryBusy = new Set<ProviderId>();
  private canaryLast = new Map<ProviderId, number>();
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
      providers: this.providers(health),
      quota: live.quota,
      engine: live.engine,
      settings: toSettings(cfg),
      repos: cfg.repos.map((r) => this.repoView(r, persist)),
      runs: live.runs,
      cards: live.cards,
    };
  }

  /** Every registry provider as the dashboard sees it. CLI-originated strings are redacted and truncated; hints are static. */
  providers(health: ApiState['health']): ApiProvider[] {
    const states = this.d.engine.routeStates();
    const cfg = this.d.getConfig();
    const used = new Set<string>(ROLES.flatMap((r) => cfg.roles[r].providers));
    return PROVIDER_IDS.map((id) => {
      const h: AgentHealth | undefined = Object.hasOwn(health, id) ? (health as unknown as Record<string, AgentHealth>)[id] : undefined;
      const s: ProviderState = states[id];
      const state: ApiProvider['state'] = !h ? 'ok' : h.state === 'broken-install' ? 'broken-install' : !h.found ? 'missing' : h.ok ? 'ok' : h.loggedIn === false ? 'not-logged-in' : 'attention';
      return {
        id,
        label: providerLabel(id),
        state,
        version: h?.version ? truncate(redact(h.version, []), 80) : undefined,
        detail: h?.detail ? truncate(redact(h.detail, []), 300) : undefined,
        hint: PROVIDER_HINT[id],
        capabilities: { ...s.caps },
        buildVerification: s.caps.build ? buildVerificationInfo(id, h?.version) ?? undefined : undefined,
        isolationCheck: this.isolationCheck(id, s.tier),
        tier: s.tier,
        inUse: used.has(id),
        pausedUntil: s.pausedUntil,
      };
    });
  }

  private isolationCheck(id: ProviderId, tier: ProviderState['tier']): ApiProvider['isolationCheck'] {
    if (id !== 'codex') return undefined;
    const last = loadRecords(id).filter((r) => r.kind === 'readOnly' && r.source === 'canary').pop();
    if (!last) return undefined;
    return { verdict: last.verdict, at: last.at, current: last.verdict === 'blocked' || tier === 'partial' };
  }

  roles(): ApiRoles {
    const cfg = this.d.getConfig();
    const states = this.d.engine.routeStates();
    const choices: ApiRoles['choices'] = {};
    for (const role of ROLES) {
      choices[role] = {};
      for (const id of PROVIDER_IDS) {
        const v = validatePairing(role, id, states, providerLabel);
        choices[role]![id] = v.ok ? { ok: true, needsAck: states[id].tier === 'unverified' } : { ok: false, reason: v.reason };
      }
    }
    return { roles: cfg.roles, choices, needs: Object.fromEntries(ROLES.map((r) => [r, { ...ROLE_NEEDS[r] }])) };
  }

  /**
   * PUT /api/roles. Strict: a plain object, own-property role names, registry provider ids only, every pairing checked against the
   * capability/tier gate with a human reason, an `unverified` provider needs an explicit acknowledgement, a `blocked` one is refused.
   */
  private putRoles(body: unknown): { roles: Roles; notices: string[] } {
    if (!isPlain(body)) throw new ApiFail(400, 'bad_request', 'The request body must be an object.');
    if (!isPlain(body.roles)) throw new ApiFail(400, 'bad_request', '"roles" must be an object.');
    const ack = new Set<string>();
    if (body.acknowledge !== undefined) {
      if (!Array.isArray(body.acknowledge) || body.acknowledge.length > 8 || !body.acknowledge.every((x) => typeof x === 'string')) throw new ApiFail(400, 'bad_request', '"acknowledge" must be a short list of provider ids.');
      for (const a of body.acknowledge) ack.add(a);
    }
    const cfg = this.d.getConfig();
    const states = this.d.engine.routeStates();
    const next: Roles = JSON.parse(JSON.stringify(cfg.roles));
    const notices: string[] = [];
    for (const role of Object.keys(body.roles)) {
      if (!isRole(role)) throw new ApiFail(400, 'bad_request', `Unknown role "${role.slice(0, 30)}".`);
      const raw = body.roles[role];
      if (!isPlain(raw)) throw new ApiFail(400, 'bad_request', `Role "${role}" must be an object.`);
      const entry: RoleConfig = { providers: [] };
      if (!Array.isArray(raw.providers) || raw.providers.length === 0 || raw.providers.length > 4) throw new ApiFail(400, 'bad_request', `Role "${role}" needs 1–4 providers.`);
      const check = (id: unknown, what: string): ProviderId => {
        if (!isProviderId(id)) throw new ApiFail(400, 'bad_request', `${what}: unknown provider.`);
        const v = validatePairing(role, id, states, providerLabel);
        if (!v.ok) throw new ApiFail(400, 'unsupported_pairing', v.reason);
        if (states[id].tier === 'unverified' && !cfg.roles[role].providers.includes(id) && !ack.has(id)) {
          throw new ApiFail(409, 'needs_acknowledgement', `${providerLabel(id)}'s isolation has not been verified on this machine. Send "acknowledge": ["${id}"] to use it for ${role} anyway.`);
        }
        return id;
      };
      for (const p of raw.providers) {
        const id = check(p, `Role "${role}"`);
        if (!entry.providers.includes(id)) entry.providers.push(id);
      }
      if (raw.autoByComplexity !== undefined) {
        if (!isPlain(raw.autoByComplexity)) throw new ApiFail(400, 'bad_request', `Role "${role}": "autoByComplexity" must be an object.`);
        const picks: NonNullable<RoleConfig['autoByComplexity']> = {};
        for (const k of Object.keys(raw.autoByComplexity)) {
          if (!isComplexity(k)) throw new ApiFail(400, 'bad_request', `Role "${role}": complexity must be one of ${COMPLEXITIES.join(', ')}.`);
          picks[k] = check(raw.autoByComplexity[k], `Role "${role}" (${k})`);
        }
        if (Object.keys(picks).length) entry.autoByComplexity = picks;
      }
      for (const id of entry.providers) if (!cfg.roles[role].providers.includes(id)) notices.push(`${providerLabel(id)} → ${role}: ${EGRESS[id]}`);
      next[role] = entry;
    }
    return { roles: next, notices };
  }

  private providerId(raw: string): ProviderId {
    // checked against the registry BEFORE any path, file or process is derived from it
    if (!isProviderId(raw)) throw new ApiFail(404, 'not_found', 'Unknown provider.');
    return raw;
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
      if (path === '/api/providers') return { json: { providers: this.providers(await this.cachedHealth()) } };
      if (path === '/api/roles') return { json: this.roles() };
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
      const it = this.d.board.user.setFields(key, { title: body.title == null ? undefined : str(body.title, 'title', 200), description: body.description == null ? undefined : str(body.description, 'description', 10_000, false) });
      return { json: { ok: true, item: it } };
    }

    if (method === 'POST' && path === '/api/engine/pause') {
      if (typeof body.paused !== 'boolean') throw new ApiFail(400, 'bad_request', '"paused" must be true or false.');
      this.d.engine.setPaused(body.paused);
      return { json: { ok: true } };
    }

    if (method === 'PUT' && path === '/api/roles') {
      const { roles, notices } = this.putRoles(body);
      const next = normalizeConfig({ ...this.d.getConfig(), roles }); // the load-time capability filter runs again
      this.d.saveConfig(next);
      this.d.engine.invalidate();
      return { json: { ok: true, roles: next.roles, notices } };
    }

    if (method === 'POST' && (m = /^\/api\/providers\/([^/]+)\/test$/.exec(path))) {
      const id = this.providerId(safeDecode(m[1]!));
      if (!isPlain(body)) throw new ApiFail(400, 'bad_request', 'The request body must be an object.');
      const level = body.level === undefined ? 'cheap' : body.level;
      if (level !== 'cheap' && level !== 'canary') throw new ApiFail(400, 'bad_request', '"level" must be "cheap" or "canary".');
      if (level === 'cheap') {
        this.healthCache = null; // a fresh, zero-quota look (--version / login status only)
        return { json: { ok: true, level, provider: this.providers(await this.cachedHealth()).find((p) => p.id === id) } };
      }
      // canary: spends quota — explicit confirmation on EVERY call, one at a time per provider, with a cool-down
      if (body.confirm !== true) throw new ApiFail(400, 'confirm_required', 'This check calls the model and uses your plan\'s quota. Send "confirm": true to run it.');
      if (id === 'codex' && !this.d.canary) throw new ApiFail(501, 'not_available', 'The Codex isolation check is not available in this build.');
      if (this.canaryBusy.has(id)) throw new ApiFail(409, 'busy', 'A check for this provider is already running.');
      const last = this.canaryLast.get(id) ?? 0;
      if (Date.now() - last < CANARY_COOLDOWN_MS) throw new ApiFail(429, 'cooldown', 'That check just ran. Wait a minute before running it again.');
      if (this.d.engine.status().running > 0) throw new ApiFail(409, 'busy', 'Stages are running; run this check when the board is idle.');
      this.canaryBusy.add(id);
      try {
        if (id === 'codex') {
          const rep = await this.d.canary!('codex');
          this.canaryLast.set(id, Date.now());
          if (rep.binding) addRecord({ provider: 'codex', kind: 'readOnly', verdict: rep.verdict, source: 'canary', binding: rep.binding, at: rep.ranAt, items: rep.items.map((i) => ({ id: i.id, outcome: i.outcome })) });
          this.healthCache = null;
          this.d.engine.invalidate();
          return { json: { ok: rep.verdict === 'pass', level, verdict: rep.verdict, items: rep.items.map((i) => ({ id: i.id, outcome: i.outcome, detail: truncate(redact(i.detail, []), 300) })) } };
        }
        const r = await this.d.probe(id as 'claude' | 'cursor');
        this.canaryLast.set(id, Date.now());
        return { json: { ok: r.ok, level, detail: truncate(redact(r.detail, []), 300), durationMs: r.durationMs } };
      } finally {
        this.canaryBusy.delete(id);
      }
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
