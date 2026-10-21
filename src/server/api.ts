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
import { applySettings, legacyModelNotices, normalizeConfig, toSettings } from '../config.ts';
import { ROLE_ROWS, modelsView, roleViews, toolDefaultSelection } from '../models/select.ts';
import { RolesPlanError, apiRolesForm, apiToolModels, planRoles } from './roles-plan.ts';
import { PROVIDER_IDS, isProviderId, providerLabel } from '../agents/providers/registry.ts';
import { COMPLEXITIES, ROLES, ROLE_NEEDS, isComplexity, isRole, type RoleConfig, type Roles } from '../agents/roles.ts';
import { validatePairing, type ProviderState } from '../agents/routing.ts';
import { redact } from '../redact.ts';
import { addRecord, buildVerificationInfo, canaryValidated, loadRecords } from '../agents/providers/verification.ts';
import type { CanaryReport } from '../agents/providers/canary.ts';
import { toDetail, toGraph, toSummary } from '../pipeline/view.ts';
import { CreateError, SAMPLE_KEY, SAMPLE_TASK, createProject, createSample } from '../onboarding/create.ts';
import { environmentReport } from '../onboarding/env.ts';
import { OFFLINE_OPERATIONS } from '../net/offline.ts';
import { contextStatus, refreshContext, DEFAULT_STALE_DAYS } from '../context/incremental.ts';
import { loadContext } from '../context/store.ts';
import { normalizeProjects } from '../config.ts';
import { AskError, type AskService } from '../asks/service.ts';
import { ASK_ID_RE } from '../asks/store.ts';
import { BriefError, type BriefService } from '../briefs/service.ts';
import { BRIEF_ID_RE, type ResearchCardView } from '../briefs/types.ts';
import { used as budgetUsed } from '../limits/budget.ts';
import { detectGates } from '../git/gates.ts';
import { inspectRepo } from '../git/worktree.ts';
import { errMsg, truncate } from '../util.ts';
import { OpenError, openRun, type ExecFn } from './open.ts';
import type { Auth } from './auth.ts';
import type { CatalogView } from '../models/types.ts';

export class ApiFail extends Error {
  status: number;
  code: string;
  /** M8-2 (B1e, S8): the control the refusal is about ("roles.<role>.<key>") — only ever allow-listed names. Omitted on the wire when unset. */
  field?: string;
  /** M8-6: extra structured details (e.g. retryAt). Never overrides code, message or field (http.ts drops those keys). */
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, field?: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiFail';
    this.status = status;
    this.code = code;
    if (field !== undefined) this.field = field;
    if (extra !== undefined) this.extra = extra;
  }
}

export interface ApiResult {
  status?: number;
  json?: unknown;
  /** Set to clear the session cookie. */
  logout?: boolean;
}

export interface ApiDeps {
  /** Quick Ask (M5). Absent ⇒ the ask endpoints answer 501. */
  asks?: AskService;
  /** "Design the work" + research briefs (M8-6). Absent ⇒ the brief endpoints answer 501. */
  briefs?: BriefService;
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
  /** Model discovery (M8-1). Absent ⇒ the /api/models endpoints answer 501. */
  models?: {
    viewAll(): CatalogView[];
    refresh(provider: ProviderId, trigger?: 'manual'): Promise<CatalogView>;
  };
}

/** N5: GET /api/roles without a model service (e.g. a test or demo wiring) — every tool shows "Tool default" only. */
const NO_MODELS_REASON = 'Model lists are not available in this mode.';
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
  codex: 'Install Codex (npm i -g @openai/codex), then sign in with Conductor\'s private home: CODEX_HOME=~/.conductor-v2/providers/codex-home codex login — the credential is stored as a file in that folder, not in your OS keychain. Conductor never runs either command for you.',
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
      ...(this.d.briefs ? { home: this.homeState(cfg) } : {}),
    };
  }

  /** M8-6 C1: feature flags + the counters the Home composer shows (the server enforces them anyway). */
  private homeState(cfg: Config): NonNullable<ApiState['home']> {
    return {
      design: true,
      researchBrief: !!this.d.asks,
      limits: { designPerHour: cfg.pipeline.designPerHour, designUsed: budgetUsed('designPerHour'), researchPerDay: cfg.pipeline.researchPerDay, researchUsed: budgetUsed('researchPerDay') },
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
      const state: ApiProvider['state'] = !h ? 'ok' : h.state === 'broken-install' ? 'broken-install' : !h.found ? 'missing' : h.ok ? 'ok' : h.loggedIn === false ? 'not-logged-in' : 'unknown';
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
    return { verdict: last.verdict, at: last.at, current: last.verdict === 'blocked' || tier === 'partial', trusted: canaryValidated() };
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
    const cat = (t: ProviderId) => this.catalogFor(t);
    const models = {} as ApiRoles['models'];
    for (const t of PROVIDER_IDS) models[t] = modelsView(t, cat(t), { toolDefault: toolDefaultSelection(cfg, t), noCatalogReason: NO_MODELS_REASON });
    return {
      roles: apiRolesForm(cfg.roles),
      choices,
      needs: Object.fromEntries(ROLES.map((r) => [r, { ...ROLE_NEEDS[r] }])),
      toolModels: apiToolModels(cfg.toolModels),
      roleViews: roleViews(cfg, cat),
      rows: ROLE_ROWS.map((r) => ({ id: r.id, roles: [...r.roles] })),
      legacyNotices: legacyModelNotices(cfg),
      models,
    };
  }

  /** M8-2: the synchronous, memory-only catalog view (never refreshes, never spawns). No model service (N5) ⇒ null ⇒ tool defaults. */
  private catalogFor(t: ProviderId): CatalogView | null {
    if (!this.d.models) return null;
    try {
      return this.d.models.viewAll().find((v) => v.provider === t) ?? null;
    } catch {
      return null;
    }
  }

  /** PUT /api/roles and POST /api/roles/preview: one pure plan (S2). PUT turns every problem into a refusal; preview reports them. */
  private planRolesFor(body: unknown, mode: 'put' | 'preview') {
    try {
      return planRoles({ body, cfg: this.d.getConfig(), states: this.d.engine.routeStates(), catalog: (t) => this.catalogFor(t), mode, egress: (id) => EGRESS[id] });
    } catch (e) {
      if (e instanceof RolesPlanError) throw new ApiFail(e.status, e.code, e.message, e.field);
      throw e;
    }
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

  /** A board project key → its repository, validated before anything touches a path. */
  private contextTarget(key: string): { key: string; repo: { name: string; path: string; baseBranch: string; gates: any[] } } {
    if (!/^[A-Z]{2,6}$/.test(key)) throw new ApiFail(404, 'not_found', 'Unknown project.');
    const project = this.d.board.projects().find((p) => p.key === key);
    const repo = project && this.d.getConfig().repos.find((r) => r.name === project.repo);
    if (!project || !repo) throw new ApiFail(404, 'not_found', 'Unknown project or it has no repository yet.');
    return { key, repo };
  }

  private modelsSvc(): NonNullable<ApiDeps['models']> {
    if (!this.d.models) throw new ApiFail(501, 'not_available', 'Model discovery is not available here.');
    return this.d.models;
  }

  private briefsSvc(): BriefService {
    if (!this.d.briefs) throw new ApiFail(501, 'not_available', 'Design the work is not available here.');
    return this.d.briefs;
  }

  /** S12: a strict JSON body — a plain object (prototype check) whose own keys are all in `allowed`. */
  private strict(body: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!isPlain(body) || Object.getPrototypeOf(body) !== Object.prototype) throw new ApiFail(400, 'bad_request', 'The request body must be an object.');
    for (const k of Object.getOwnPropertyNames(body)) if (!allowed.includes(k)) throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
    return body;
  }

  private asksSvc(): AskService {
    if (!this.d.asks) throw new ApiFail(501, 'not_available', 'Quick Ask is not available here.');
    return this.d.asks;
  }

  runDetail(key: string): ApiRunDetail {
    if (!KEY_RE.test(key)) throw new ApiFail(404, 'not_found', 'Unknown run.');
    const run = this.d.store.get(key);
    if (!run) throw new ApiFail(404, 'not_found', 'Unknown run.');
    const notes = this.d.board.comments(run.itemId).map((c) => ({ id: c.id, author: c.author, body: c.body, ts: c.ts }));
    return { ...toDetail(this.d.store, run, this.d.getConfig(), Date.now()), notes };
  }

  /**
   * Everything the board view needs: projects + top-level items (children are fetched with the item). M8-6 (additive): items made by
   * `design` carry `design{briefId, part, parts}` (parsed only from a strict idemKey, S15), and `research` is the READ-ONLY projection of
   * research asks (Q3: not board items, never journalled, no move/claim/edit).
   */
  boardView(): { projects: ReturnType<Board['projects']>; items: (ReturnType<Board['items']>[number] & { design?: { briefId: string; part: number; parts: number } })[]; milestones: ReturnType<Board['milestones']>; research: ResearchCardView[] } {
    const briefs = this.d.briefs;
    const items = this.d.board.items().slice(-2000).map((i) => {
      const o = briefs ? briefs.designOrigin(i) : undefined;
      return o ? { ...i, design: o } : i;
    });
    return { projects: this.d.board.projects(), items, milestones: this.d.board.milestones(), research: this.d.asks ? this.d.asks.researchCards() : [] };
  }

  itemView(key: string) {
    if (!KEY_RE.test(key)) throw new ApiFail(404, 'not_found', 'Unknown card.');
    const item = this.d.board.item(key);
    if (!item) throw new ApiFail(404, 'not_found', 'Unknown card.');
    const run = this.d.store.get(item.key);
    return {
      item,
      comments: this.d.board.comments(item.id),
      children: this.d.board.children(item.id),
      decisions: this.d.board.decisions(item.projectId).filter((d) => !d.itemId || d.itemId === item.id),
      graph: run ? toGraph(run) : null,
      // M8-6 N3 (additive): dependencies that are not Done yet, so the UI can say "waiting for KEY" / "waiting for a canceled card"
      blockedBy: item.dependsOn.map((d) => this.d.board.item(d)).filter((d): d is NonNullable<typeof d> => !!d && d.lane !== 'done').map((d) => ({ key: d.key, lane: d.lane })),
    };
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
      if (e instanceof AskError) throw new ApiFail(e.status, e.code, e.message);
      if (e instanceof BriefError) throw new ApiFail(e.status, e.code, e.message, undefined, e.extra);
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
      if (path === '/api/models') return { json: { providers: this.modelsSvc().viewAll() } };
      if (path === '/api/asks') return { json: { asks: this.asksSvc().list() } };
      if (path === '/api/briefs') return { json: { briefs: this.briefsSvc().list() } };
      if ((m = /^\/api\/briefs\/([^/]+)$/.exec(path))) {
        const id = safeDecode(m[1]!);
        const rec = BRIEF_ID_RE.test(id) ? this.briefsSvc().get(id) : null; // the id is checked before any path is built
        if (!rec) throw new ApiFail(404, 'not_found', 'Unknown brief.');
        return { json: rec };
      }
      if ((m = /^\/api\/asks\/([^/]+)$/.exec(path))) {
        const id = safeDecode(m[1]!);
        const rec = ASK_ID_RE.test(id) ? this.asksSvc().get(id) : null;
        if (!rec) throw new ApiFail(404, 'not_found', 'Unknown question.');
        return { json: rec };
      }
      if ((m = /^\/api\/projects\/([^/]+)\/context$/.exec(path))) {
        const { key, repo } = this.contextTarget(safeDecode(m[1]!));
        const status = await contextStatus(key, repo, { staleDays: this.d.getConfig().projects?.[key]?.context?.staleDays ?? DEFAULT_STALE_DAYS });
        const l = loadContext(key);
        const f = l.state === 'ok' ? l.facts : null;
        return { json: { key, status, summaries: this.d.getConfig().projects?.[key]?.context?.summaries === true, facts: f && { languages: f.languages, frameworks: f.frameworks, packageManagers: f.packageManagers, tests: f.tests, modules: f.modules.length, files: f.counts.files, truncated: f.counts.truncated } } };
      }
      if (path === '/api/setup/environment') return { json: environmentReport() };
      if (path === '/api/offline') return { json: { online: (await this.d.engine.probe.check()) !== 'offline', checkedAt: this.d.engine.probe.last()?.at ?? null, operations: OFFLINE_OPERATIONS } };
      if ((m = /^\/api\/items\/([^/]+)$/.exec(path))) return { json: this.itemView(safeDecode(m[1]!)) };
      if ((m = /^\/api\/runs\/([^/]+)\/log$/.exec(path))) {
        return { json: this.runLog(safeDecode(m[1]!), Number(q.get('after') ?? 0), Number(q.get('limit') ?? 500)) };
      }
      throw new ApiFail(404, 'not_found', 'No such endpoint.');
    }

    if ((m = /^\/api\/projects\/([^/]+)\/context\/scan$/.exec(path)) && method === 'POST') {
      for (const k of Object.keys(body)) if (k !== 'full') throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
      if (body.full !== undefined && typeof body.full !== 'boolean') throw new ApiFail(400, 'bad_request', '"full" must be true or false.');
      const { key, repo } = this.contextTarget(safeDecode(m[1]!));
      const r = await refreshContext(key, repo, { full: body.full === true, staleDays: this.d.getConfig().projects?.[key]?.context?.staleDays ?? DEFAULT_STALE_DAYS });
      return { json: { action: r.action, rescanned: r.rescanned, reused: r.reused, status: r.status, error: r.error ?? null } };
    }
    if ((m = /^\/api\/projects\/([^/]+)\/settings$/.exec(path)) && method === 'PUT') {
      const { key } = this.contextTarget(safeDecode(m[1]!));
      for (const k of Object.keys(body)) if (!['policy', 'confirmFullAuto'].includes(k)) throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
      if (!['full-auto', 'approve-plan', 'approve-risky', 'manual-stages'].includes(body.policy)) throw new ApiFail(400, 'bad_request', '"policy" must be full-auto, approve-plan, approve-risky or manual-stages.');
      if (body.policy === 'full-auto' && body.confirmFullAuto !== true) throw new ApiFail(400, 'confirm_required', 'Full automation needs "confirmFullAuto": true — plans will run without asking (large changes, protected files and unverified sources still wait for you).');
      const cfg = this.d.getConfig();
      const prev = cfg.projects?.[key] ?? {};
      cfg.projects = { ...(cfg.projects ?? {}), [key]: { ...prev, policy: body.policy } };
      this.d.saveConfig(cfg);
      return { json: { ok: true, policy: body.policy } };
    }
    if ((m = /^\/api\/projects\/([^/]+)\/context\/settings$/.exec(path)) && method === 'PUT') {
      const { key } = this.contextTarget(safeDecode(m[1]!));
      for (const k of Object.keys(body)) if (!['summaries', 'staleDays', 'packBytes'].includes(k)) throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
      if (body.summaries !== undefined && typeof body.summaries !== 'boolean') throw new ApiFail(400, 'bad_request', '"summaries" must be true or false.');
      for (const k of ['staleDays', 'packBytes']) if (body[k] !== undefined && (typeof body[k] !== 'number' || !Number.isFinite(body[k]))) throw new ApiFail(400, 'bad_request', `"${k}" must be a number.`);
      const cfg = this.d.getConfig();
      const cur = cfg.projects?.[key]?.context ?? { summaries: false, staleDays: 14, packBytes: 8192 };
      const next = normalizeProjects({ [key]: { context: { ...cur, ...body } } });
      cfg.projects = { ...(cfg.projects ?? {}), [key]: { ...(cfg.projects?.[key] ?? {}), context: next[key]!.context } }; // keep everything else of the project (its policy!)
      this.d.saveConfig(cfg);
      return { json: { ok: true, context: cfg.projects[key]!.context, notice: cfg.projects[key]!.context!.summaries ? 'Directory summaries spend model quota (a small number of calls per day, see pipeline.contextRunsPerDay).' : undefined } };
    }
    if (method === 'POST' && path === '/api/ask') {
      const allowed = new Set(['question', 'repo', 'allowChange', 'mode']);
      if (body.mode !== undefined && body.mode !== 'quick' && body.mode !== 'research') throw new ApiFail(400, 'bad_request', '"mode" must be quick or research.');
      if (body.mode === 'research') {
        for (const k of Object.keys(body)) if (!['question', 'repo', 'mode'].includes(k)) throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
        return { status: 202, json: await this.asksSvc().startResearch({ question: body.question, repo: body.repo }) };
      }
      for (const k of Object.keys(body)) if (!allowed.has(k)) throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
      if (body.allowChange !== undefined && typeof body.allowChange !== 'boolean') throw new ApiFail(400, 'bad_request', '"allowChange" must be true or false.');
      return { status: 202, json: this.asksSvc().start({ question: body.question, repo: body.repo, allowChange: body.allowChange }) };
    }
    // ── M8-6: "Design the work" / research briefs (strict bodies, ids by regex before any path; CSRF/Host/Sec-Fetch in http.ts) ──
    if (method === 'POST' && path === '/api/briefs') {
      const b = this.strict(body, ['kind', 'line', 'repo']);
      return { status: 202, json: this.briefsSvc().start({ kind: b.kind, line: b.line, repo: b.repo }) };
    }
    if ((m = /^\/api\/briefs\/([^/]+)\/(cancel|send)$/.exec(path)) && method === 'POST') {
      const id = safeDecode(m[1]!);
      if (!BRIEF_ID_RE.test(id)) throw new ApiFail(404, 'not_found', 'Unknown brief.');
      const svc = this.briefsSvc();
      if (m[2] === 'cancel') {
        this.strict(body, []);
        const v = svc.cancel(id);
        if (!v) throw new ApiFail(404, 'not_found', 'Unknown brief.');
        return { json: v };
      }
      const r = await svc.send(id, this.strict(body, ['parts', 'depth']));
      return { status: r.status, json: r.json };
    }
    if ((m = /^\/api\/briefs\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const id = safeDecode(m[1]!);
      if (!BRIEF_ID_RE.test(id) || !this.briefsSvc().remove(id)) throw new ApiFail(404, 'not_found', 'Unknown brief.');
      return { json: { ok: true } };
    }
    if ((m = /^\/api\/asks\/([^/]+)\/dismiss$/.exec(path)) && method === 'POST') {
      const id = safeDecode(m[1]!);
      if (!ASK_ID_RE.test(id)) throw new ApiFail(404, 'not_found', 'Unknown question.');
      this.strict(body, []);
      return { json: this.asksSvc().dismiss(id) };
    }
    if ((m = /^\/api\/asks\/([^/]+)\/convert$/.exec(path)) && method === 'POST') {
      const id = safeDecode(m[1]!);
      if (!ASK_ID_RE.test(id)) throw new ApiFail(404, 'not_found', 'Unknown question.');
      return { status: 201, json: this.asksSvc().convert(id) };
    }
    if ((m = /^\/api\/asks\/([^/]+)\/cancel$/.exec(path)) && method === 'POST') {
      const id = safeDecode(m[1]!);
      const rec = ASK_ID_RE.test(id) ? this.asksSvc().cancel(id) : null;
      if (!rec) throw new ApiFail(404, 'not_found', 'Unknown question.');
      return { json: rec };
    }
    if ((m = /^\/api\/asks\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const id = safeDecode(m[1]!);
      if (!ASK_ID_RE.test(id)) throw new ApiFail(404, 'not_found', 'Unknown question.');
      this.asksSvc().remove(id);
      return { json: { ok: true } };
    }
    if (method === 'POST' && path === '/api/auth/logout') return { json: { ok: true }, logout: true };
    if (method === 'POST' && path === '/api/models/refresh') {
      // S13: strict — a plain object whose only own key may be `provider`, a registry id; an empty body means every provider
      const svc = this.modelsSvc();
      if (!isPlain(body) || Object.getPrototypeOf(body) !== Object.prototype) throw new ApiFail(400, 'bad_request', 'The request body must be an object.');
      for (const k of Object.getOwnPropertyNames(body)) if (k !== 'provider') throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
      const has = Object.hasOwn(body, 'provider');
      if (has && !isProviderId(body.provider)) throw new ApiFail(400, 'bad_request', '"provider" must be claude, cursor or codex.');
      const targets: ProviderId[] = has ? [body.provider as ProviderId] : [...PROVIDER_IDS];
      // started, never awaited: a hung discovery cannot hold the request (the client polls GET /api/models while `refreshing`)
      for (const p of targets) void svc.refresh(p, 'manual').catch(() => undefined);
      return { status: 202, json: { providers: svc.viewAll() } };
    }

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
          this.d.engine.approve(key, 'human', body.rev, body.confirmRisks === true);
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
      const plan = this.planRolesFor(body, 'put');
      const next = normalizeConfig({ ...this.d.getConfig(), roles: plan.roles, toolModels: plan.toolModels }); // the load-time filters run again
      this.d.saveConfig(next); // only after the whole plan passed: nothing is saved on any 4xx (S8)
      this.d.engine.invalidate();
      const cat = (t: ProviderId) => this.catalogFor(t);
      return { json: { ok: true, roles: apiRolesForm(next.roles), toolModels: apiToolModels(next.toolModels), roleViews: roleViews(next, cat), notices: plan.notices } };
    }

    if (method === 'POST' && path === '/api/roles/preview') {
      // S2: plan only — no save, no backup, no refresh, no noteUnknownModel, no bin resolution, no spawn; catalogs via the memory view
      const plan = this.planRolesFor(body, 'preview');
      const draft = { roles: plan.roles, toolModels: plan.toolModels };
      const cat = (t: ProviderId) => this.catalogFor(t);
      return { json: { roles: apiRolesForm(plan.roles), toolModels: apiToolModels(plan.toolModels), roleViews: roleViews(draft, cat), notices: plan.notices, problems: plan.problems.map((p) => ({ field: p.field, code: p.code, message: p.message })) } };
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
      this.canaryLast.set(id, Date.now()); // the cool-down starts BEFORE the run: a canary that throws cannot be re-triggered at once
      try {
        if (id === 'codex') {
          const rep = await this.d.canary!('codex');
          if (rep.binding) addRecord({ provider: 'codex', kind: 'readOnly', verdict: rep.verdict, source: 'canary', binding: rep.binding, at: rep.ranAt, items: rep.items.map((i) => ({ id: i.id, outcome: i.outcome })) });
          this.healthCache = null;
          this.d.engine.invalidate();
          return { json: { ok: rep.verdict === 'pass', level, verdict: rep.verdict, items: rep.items.map((i) => ({ id: i.id, outcome: i.outcome, detail: truncate(redact(i.detail, []), 300) })) } };
        }
        const r = await this.d.probe(id as 'claude' | 'cursor');
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

    if (method === 'POST' && path === '/api/setup/project/create') {
      for (const k of Object.keys(body)) if (!['parent', 'name', 'identity'].includes(k)) throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
      let created: { path: string };
      try {
        created = createProject({ parent: body.parent, name: body.name, identity: body.identity });
      } catch (e) {
        if (e instanceof CreateError) throw new ApiFail(400, 'bad_project', e.message);
        throw e;
      }
      return this.route('POST', '/api/setup/repo', q, { path: created.path, name: String(body.name) });
    }
    if (method === 'POST' && path === '/api/setup/sample') {
      for (const k of Object.keys(body)) throw new ApiFail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
      let sample: { path: string; created: boolean };
      try {
        sample = createSample();
      } catch (e) {
        if (e instanceof CreateError) throw new ApiFail(409, 'sample_unavailable', e.message);
        throw e;
      }
      await this.route('POST', '/api/setup/repo', q, { path: sample.path, name: 'conductor-sample' });
      let project = this.d.board.projects().find((p) => p.key === SAMPLE_KEY);
      if (!project) project = this.d.board.createProject({ key: SAMPLE_KEY, name: 'Conductor sample', repo: 'conductor-sample' });
      let card = this.d.board.items({ projectId: project.id }).find((i) => i.title === SAMPLE_TASK.title);
      // never starts by itself: it waits in Backlog until the user presses Start (which spends plan quota — said in the UI)
      if (!card) card = this.d.board.user.createItem({ projectId: project.id, title: SAMPLE_TASK.title, description: SAMPLE_TASK.description, lane: 'backlog' });
      return { json: { ok: true, created: sample.created, key: card.key, path: sample.path } };
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
