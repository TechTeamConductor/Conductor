/* Conductor dashboard (vanilla JS, no build step, no dependencies).
 * Contract: docs/API.md + src/types.ts. CSP-safe: no inline script/style, no HTML-string sinks,
 * server strings are only ever written with textContent / text nodes.
 */
(() => {
'use strict';

/* Pure helpers (ui/modes.js, loaded first). Without them the dashboard would half-work, so say so instead. */
const M = window.ConductorModes;
if (!M) {
  const v = document.getElementById('view');
  if (v) {
    const p = document.createElement('p');
    p.className = 'boot';
    p.setAttribute('role', 'alert');
    p.textContent = 'The dashboard did not load completely (modes.js is missing). Reload the page; if it persists, restart Conductor.';
    v.setAttribute('aria-busy', 'false');
    v.replaceChildren(p);
  }
  return;
}

/* ───────────────────────── constants ───────────────────────── */
const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_LOG_NODES = 1500;
const STATE_POLL_MS = 60000;
const SSE_DEAD_MS = 50000;
const LOG_PAGE = 2000;

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', icon: 'archive', hint: 'Parked: nothing runs until you start it', cards: true },
  { id: 'todo', label: 'To do', icon: 'clipboard', hint: 'Starts by itself', cards: true },
  { id: 'queued', label: 'Queued', icon: 'clock', hint: 'Waiting for a free slot' },
  { id: 'planning', label: 'Planning', icon: 'pen', hint: 'Claude writes the plan' },
  { id: 'plan_ready', label: 'Plan ready', icon: 'clipboard', hint: 'Waiting for your approval', ask: true },
  { id: 'building', label: 'Building', icon: 'code', hint: 'Cursor writes the code' },
  { id: 'verifying', label: 'Verifying', icon: 'shield', hint: 'Gates, then Claude checks' },
  { id: 'needs_human', label: 'Needs you', icon: 'alert', hint: 'Blocked until you act', attn: true },
  { id: 'paused', label: 'Paused', icon: 'pause', hint: 'On hold, resumes by itself' },
  { id: 'ready', label: 'Ready for review', icon: 'check', hint: 'Verified. You review and merge' },
];
const MOBILE_ORDER = ['needs_human', 'plan_ready', 'paused', 'ready', 'building', 'verifying', 'planning', 'queued', 'todo', 'backlog'];
const COL_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));
const WORKING_COLUMNS = ['planning', 'building', 'verifying'];
const WAITING_COLUMNS = ['plan_ready', 'needs_human', 'ready'];

const STATUS_LABEL = {
  queued: 'Queued', running: 'Running', awaiting_approval: 'Plan ready', needs_human: 'Needs you', paused: 'Paused',
  parked: 'Parked', ready: 'Ready for review', aborted: 'Aborted', failed: 'Failed', finished: 'Finished',
};
const COLUMN_ICON = {
  backlog: 'archive', todo: 'clipboard', queued: 'clock', planning: 'pen', plan_ready: 'clipboard', building: 'code', verifying: 'shield',
  needs_human: 'alert', paused: 'pause', ready: 'check', closed: 'archive',
};
const AGENT_LABEL = { claude: 'Claude', cursor: 'Cursor', conductor: 'Conductor' };
const AGENT_ICON = { claude: 'claude', cursor: 'cursor', conductor: 'diamond' };
const STAGE_LABEL = { plan: 'Plan', plan_review: 'Plan review', build: 'Build', verify: 'Verify', setup: 'Setup', engine: 'Engine' };
const TABS = [
  ['overview', 'Overview'], ['log', 'Live log'], ['plan', 'Plan'], ['tasks', 'Tasks'],
  ['verification', 'Verification'], ['sessions', 'Sessions'], ['timeline', 'Timeline'],
];
const OPEN_LABEL = {
  cursor: 'Opened the worktree in Cursor', 'terminal-claude': 'Opened Claude in Terminal',
  'terminal-cursor': 'Opened Cursor in Terminal', 'claude-desktop': 'Opened in the Claude app',
  finder: 'Shown in Finder',
};

/* ───────────────────────── app state ───────────────────────── */
const S = {
  state: null, offset: 0, csrf: '',
  route: { view: 'home', key: null, tab: 'overview' },
  baseView: null, // 'home' | 'board': the view under the run drawer (a direct run link shows the board)
  detail: null, detailKey: null, detailSig: '', detailError: null,
  verLoop: null,
  sse: { es: null, ok: false, everOpen: false, dropped: false, lastMsg: 0, attempts: 0, timer: 0, downSince: 0 },
  expired: false,
  busy: new Set(),
  dismissed: new Set(),
  isMobile: false,
  view: null, // 'home' | 'board' | 'wizard' | 'error'
  loadFailed: false,
  roles: null, rolesErr: null, // GET /api/roles (who does each job); null until loaded
};
let uidN = 0;
const uid = (p) => `${p || 'id'}-${++uidN}`;

/* ───────────────────────── dom helpers ───────────────────────── */
const $ = (sel, root) => (root || document).querySelector(sel);
const enc = encodeURIComponent;

function appendKids(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) appendKids(el, k);
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
  return el;
}
/** Create an element. Text only ever becomes text nodes; never HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'data') { for (const d of Object.keys(v)) if (v[d] !== null && v[d] !== undefined) el.dataset[d] = String(v[d]); }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') el[k] = v;
      else { const sv = M.safeAttr(k, v); if (sv !== null) el.setAttribute(k, sv); } // no handler strings, no style, URLs only in-app or http(s)
    }
  }
  return appendKids(el, kids);
}
function icon(name, cls) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVGNS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}
function setText(el, text) {
  const t = text === null || text === undefined ? '' : String(text);
  if (el.textContent !== t) el.textContent = t;
}
function toggleHidden(el, hidden) { if (el.hidden !== !!hidden) el.hidden = !!hidden; }
function sr(text) { return h('span', { class: 'sr-only' }, text); }
function btn(label, opts) {
  const o = opts || {};
  const el = h('button', {
    type: o.type || 'button', class: 'btn' + (o.cls ? ' ' + o.cls : ''), disabled: o.disabled,
    'aria-label': o.aria, title: o.title, onclick: o.onclick, data: o.data,
  }, o.icon ? icon(o.icon) : null, label ? h('span', { class: o.labelCls || null }, label) : null);
  return el;
}
function reduceMotion() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }

/* ───────────────────────── formatting ───────────────────────── */
const pad2 = (n) => String(n).padStart(2, '0');
const nowMs = () => Date.now() + S.offset;
function fmtDur(ms) {
  if (!(ms >= 0)) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + pad2(s % 60) + 's';
  const hr = Math.floor(m / 60);
  if (hr < 48) return hr + 'h ' + pad2(m % 60) + 'm';
  return Math.floor(hr / 24) + 'd ' + (hr % 24) + 'h';
}
function fmtAgo(ts) {
  const d = nowMs() - ts;
  if (d < 5000) return 'just now';
  if (d < 60000) return Math.floor(d / 1000) + 's ago';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}
const tfTime = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const tfDay = new Intl.DateTimeFormat([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const tfDate = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const n = new Date(nowMs());
  if (d.toDateString() === n.toDateString()) return tfTime.format(d);
  if (Math.abs(ts - nowMs()) < 6 * 864e5) return tfDay.format(d);
  return tfDate.format(d);
}
const fmtFull = (ts) => (ts ? new Date(ts).toLocaleString() : '');
function fmtClock(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
/** Quota values may be a 0..1 fraction or a 0..100 percentage (contract does not say): treat <=1 as a fraction. */
function pctOf(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const p = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(p)));
}
const safeHttp = M.safeHttp;
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
const ELAPSED_TAIL = /\s*[·•|–—-]\s*(?=\d)(?:\d+d\s*)?(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?\s*$/;
/** The server's activity sentence, minus the live timer, and minus any copy of the needs-human reason (shown separately). */
function activitySentence(r, live) {
  let t = live ? (r.activity || '').replace(ELAPSED_TAIL, '') : (r.activity || '');
  const reason = r.needsHuman && r.needsHuman.reason ? String(r.needsHuman.reason) : '';
  if (reason && t.toLowerCase().includes(reason.slice(0, 24).toLowerCase())) t = 'Blocked, waiting for you';
  return t || runLabel(r);
}
function runLabel(run) { return run.status === 'awaiting_approval' ? 'Plan ready' : (STATUS_LABEL[run.status] || run.status); }
function statusClass(run) {
  if (run.column === 'closed') return 'st-' + (run.status === 'failed' ? 'failed' : run.status === 'finished' ? 'finished' : 'aborted');
  return 'st-' + run.column;
}
function statusIcon(run) { return run.status === 'failed' ? 'warn' : (COLUMN_ICON[run.column] || 'info'); }
function runByKey(key) { return (S.state && S.state.runs.find((r) => r.key === key)) || null; }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = h('textarea', { class: 'sr-only', 'aria-hidden': 'true', tabindex: '-1', readonly: true });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
function storeGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function storeSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } }

/* ───────────────────────── toasts ───────────────────────── */
function toast(level, text, opts) {
  const o = opts || {};
  const isErr = level === 'error';
  const host = $(isErr ? '#toasts-alert' : '#toasts');
  const tone = { info: '', warn: 't-warn', error: 't-error', good: 't-good' }[level] || '';
  const ic = { info: 'info', warn: 'warn', error: 'warn', good: 'tick' }[level] || 'info';
  let timer = 0;
  const el = h('div', { class: 'toast ' + tone });
  const close = () => { clearTimeout(timer); el.remove(); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(close, isErr || level === 'warn' ? 12000 : 6000); };
  const href = o.href ? safeHttp(o.href) : null;
  el.append(
    icon(ic),
    h('p', null, String(text), href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, o.hrefLabel || 'Open') : null),
    h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Dismiss notification', onclick: close }, icon('x')),
  );
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  arm();
}

/* ───────────────────────── api client ───────────────────────── */
class ApiFail extends Error {
  /** `info` = the server's whole error object (M8-6: `retryAt`, `repos`, `cards`; M8-2: `field`). Data only — rendered as text. */
  constructor(status, code, message, info) { super(message); this.status = status; this.code = code; this.info = info && typeof info === 'object' ? info : null; }
}
async function api(method, path, body, retried) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Conductor-CSRF'] = S.csrf || '';
    init.body = JSON.stringify(body === undefined ? {} : body);
  }
  let res;
  try { res = await fetch(path, init); } catch {
    throw new ApiFail(0, 'network', "Can't reach Conductor. Is it still running? Start it with `conductor start`.");
  }
  if (res.status === 401) {
    showExpired();
    throw new ApiFail(401, 'unauthorized', 'Session expired. Run `conductor open` in a terminal.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = data && data.error ? data.error : null;
    if (res.status === 403 && method !== 'GET' && !retried) {
      // Stale CSRF value (server restarted?): refresh state once and retry.
      try { const st = await api('GET', '/api/state'); applyState(st, true); return api(method, path, body, true); } catch (err) { if (err instanceof ApiFail && err.status === 401) throw err; }
    }
    throw new ApiFail(res.status, e ? e.code : 'http_' + res.status, e && e.message ? e.message : `Request failed (${res.status}).`, e);
  }
  return data;
}

function showExpired() {
  if (S.expired) return;
  S.expired = true;
  closeSSE();
  for (const d of document.querySelectorAll('dialog[open]')) { try { d.close(); } catch { /* noop */ } }
  for (const id of ['topbar', 'banners', 'main']) { const el = document.getElementById(id); if (el) el.inert = true; }
  dropHome();
  leaveBoard();
  closeHomeMenus(false);
  $('#view').replaceChildren();
  S.view = null;
  $('#expired').hidden = false;
  const retry = $('#expired-retry');
  if (retry) retry.focus();
}

/* ───────────────────────── routing ───────────────────────── */
/** #/ Home · #/board Board · #/setup wizard · #/run/:key[/tab] the drawer over the base view (Board for a direct link). */
function parseHash() {
  const hsh = location.hash;
  const m = /^#\/run\/([^/?]+)(?:\/([a-z]+))?/.exec(hsh);
  if (m) {
    let key = m[1];
    try { key = decodeURIComponent(key); } catch { /* keep raw */ }
    const tab = TABS.some((t) => t[0] === m[2]) ? m[2] : 'overview';
    return { view: S.baseView || 'board', key, tab };
  }
  if (/^#\/setup/.test(hsh)) return { view: 'setup', key: null, tab: 'overview' };
  if (/^#\/board(?:$|[/?])/.test(hsh)) return { view: 'board', key: null, tab: 'overview' };
  return { view: 'home', key: null, tab: 'overview' };
}
const baseHash = () => (S.baseView === 'home' ? '#/' : '#/board');
function applyRoute() {
  S.route = parseHash();
  if (S.route.view === 'home' || S.route.view === 'board') S.baseView = S.route.view;
  if (!S.route.key) S.pushedRun = false;
  if (S.state) renderAll();
}
function navigate(hash) {
  if (location.hash === hash) { applyRoute(); return; }
  location.hash = hash;
}
function openRun(key, tab) {
  S.pushedRun = true;
  navigate('#/run/' + enc(key) + (tab && tab !== 'overview' ? '/' + tab : ''));
}
function closeRoute() {
  if (S.pushedRun) { S.pushedRun = false; history.back(); return; }
  history.replaceState(null, '', baseHash());
  applyRoute();
}

/* ───────────────────────── state loading ───────────────────────── */
/** Fill in anything optional or missing so rendering never throws on a partial payload. */
function normalizeState(d) {
  d.runs = Array.isArray(d.runs) ? d.runs : [];
  d.repos = Array.isArray(d.repos) ? d.repos : [];
  d.setup = d.setup && Array.isArray(d.setup.steps) ? d.setup : { complete: false, steps: [] };
  d.health = d.health || {};
  d.health.claude = d.health.claude || { found: false, ok: false };
  d.health.cursor = d.health.cursor || { found: false, ok: false };
  d.cards = Array.isArray(d.cards) ? d.cards : [];
  // providers beyond the two built-in names (e.g. Codex): labels and icons come from the server, never from a hard-coded list
  d.providers = Array.isArray(d.providers) ? d.providers : [];
  for (const p of d.providers) { if (p && typeof p.id === 'string') { if (!AGENT_LABEL[p.id]) AGENT_LABEL[p.id] = String(p.label || p.id); if (!AGENT_ICON[p.id]) AGENT_ICON[p.id] = 'diamond'; } }
  d.health.warnings = Array.isArray(d.health.warnings) ? d.health.warnings : [];
  d.quota = d.quota || {};
  d.engine = Object.assign({ paused: false, providerPause: {}, running: 0, maxParallel: 0, lastPollAt: null, lastPollError: null, storageProblem: null, pollSeconds: 5 }, d.engine || {});
  d.engine.providerPause = d.engine.providerPause || {};
  d.settings = Object.assign({ planApproval: 'auto', planReview: 'auto', maxLoops: 3, maxParallel: 2, onClaudeLimit: 'wait', noGates: 'warn' }, d.settings || {});
  d.settings.stages = Object.assign({ plan: 'claude', review: 'claude', verify: 'claude' }, d.settings.stages || {});
  // M8-3: feature-detected — an older server has no `accounts`
  d.accounts = Array.isArray(d.accounts) ? d.accounts.filter((a) => a && typeof a.id === 'string' && typeof a.provider === 'string') : null;
  return d;
}
function normalizeDetail(d) {
  d.sessions = Array.isArray(d.sessions) ? d.sessions : [];
  d.verdicts = Array.isArray(d.verdicts) ? d.verdicts : [];
  d.bugs = Array.isArray(d.bugs) ? d.bugs : [];
  d.timeline = Array.isArray(d.timeline) ? d.timeline : [];
  d.gates = d.gates || {};
  d.gates.loops = Array.isArray(d.gates.loops) ? d.gates.loops : [];
  if (d.gates.baseline && !Array.isArray(d.gates.baseline.results)) d.gates.baseline.results = [];
  for (const g of d.gates.loops) { g.run = g.run || { results: [] }; if (!Array.isArray(g.run.results)) g.run.results = []; }
  if (d.plan) {
    for (const k of ['acceptanceCriteria', 'filesToChange', 'steps', 'assumptions', 'risks']) if (!Array.isArray(d.plan[k])) d.plan[k] = [];
    d.plan.testing = d.plan.testing || { commands: [], cases: [] };
  }
  for (const v of d.verdicts) { if (v.verdict) { v.verdict.acceptance = v.verdict.acceptance || []; v.verdict.bugs = v.verdict.bugs || []; } }
  if (d.graph) {
    d.graph.items = Array.isArray(d.graph.items) ? d.graph.items : [];
    for (const it of d.graph.items) for (const k of ['dependsOn', 'files', 'criteria']) if (!Array.isArray(it[k])) it[k] = [];
  } else d.graph = null;
  return d;
}
function applyState(data, quiet) {
  normalizeState(data);
  const provChanged = S.state && providersSig(S.state.providers) !== providersSig(data.providers);
  S.state = data;
  if (provChanged || (!S.roles && !rolesLoading && !S.rolesErr)) loadRoles();
  S.offset = (data.now || Date.now()) - Date.now();
  S.csrf = data.csrf || S.csrf;
  S.loadFailed = false;
  if (!quiet) renderAll();
}
async function loadState() { applyState(await api('GET', '/api/state')); }

const isWizard = () => !S.state.setup.complete || S.route.view === 'setup';

function renderAll() {
  if (!S.state) return;
  const wizard = isWizard();
  $('#view').setAttribute('aria-busy', 'false');
  updateHeader(wizard);
  renderBanners(wizard);
  if (wizard) {
    if (S.view !== 'wizard') { closeDrawerSilently(); if (S.view === 'home') leaveHome(); if (S.view === 'board') leaveBoard(); S.view = 'wizard'; $('#view').replaceChildren(); W.sig = ''; }
    renderWizard();
  } else {
    const v = S.route.view === 'board' ? 'board' : 'home';
    if (S.view !== v) {
      if (S.view === 'home') leaveHome();
      if (S.view === 'board') leaveBoard();
      S.view = v;
      if (v === 'board') buildBoardView(); else buildHomeView();
    }
    if (v === 'board') updateBoard(); else updateHome();
    syncDrawer();
  }
  updateTitle();
  tick();
}
/** Cheap refresh for SSE `state` events: never rebuilds the wizard or the drawer's tab panels. */
function renderLive() {
  if (!S.state) return;
  const wizard = isWizard();
  updateHeader(wizard);
  renderBanners(wizard);
  if (!wizard && S.view === 'board') { updateBoard(); updateDrawerLive(); }
  else if (!wizard && S.view === 'home') { updateHome(); updateDrawerLive(); }
  updateTitle();
  tick();
}
const needYouCount = () => (S.state ? S.state.runs.filter((r) => r.column === 'needs_human' || r.column === 'plan_ready').length : 0);
function updateTitle() {
  const n = needYouCount();
  const t = (n ? `(${n}) ` : '') + 'Conductor';
  if (document.title !== t) document.title = t;
}

/* ───────────────────────── live updates (SSE) ───────────────────────── */
function closeSSE() {
  const es = S.sse.es;
  if (es) { es.onopen = null; es.onerror = null; es.close(); }
  S.sse.es = null;
  S.sse.ok = false;
  clearTimeout(S.sse.timer);
  S.sse.timer = 0;
}
function connectSSE() {
  if (S.expired) return;
  closeSSE();
  let es;
  try { es = new EventSource('/api/events'); } catch { scheduleReconnect(); return; }
  S.sse.es = es;
  S.sse.lastMsg = Date.now();
  es.onopen = () => {
    S.sse.lastMsg = Date.now();
    const resync = S.sse.dropped;
    S.sse.ok = true; S.sse.dropped = false; S.sse.attempts = 0; S.sse.downSince = 0; S.sse.everOpen = true;
    renderConn();
    renderLive();
    if (resync) resyncAfterDrop();
  };
  es.onerror = () => {
    S.sse.ok = false;
    S.sse.dropped = true;
    if (!S.sse.downSince) S.sse.downSince = Date.now();
    renderConn();
    setTimeout(() => { if (!S.sse.ok) renderLive(); }, 3200);
    if (es.readyState === EventSource.CLOSED) { S.sse.es = null; scheduleReconnect(); }
  };
  const on = (name, fn) => es.addEventListener(name, (ev) => {
    S.sse.lastMsg = Date.now();
    let d = null;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d) fn(d);
  });
  on('state', onStateEvent);
  on('log', (d) => { if (d.key && d.event) logPush(d.key, d.event); });
  on('toast', (d) => toast(['info', 'warn', 'error'].includes(d.level) ? d.level : 'info', String(d.text || '')));
  on('ping', (d) => { if (d.now) S.offset = d.now - Date.now(); });
}
function scheduleReconnect() {
  if (S.expired || S.sse.timer) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(S.sse.attempts++, 5)) + Math.random() * 400;
  S.sse.timer = setTimeout(async () => {
    S.sse.timer = 0;
    try { await loadState(); connectSSE(); } catch { if (!S.expired) scheduleReconnect(); }
  }, delay);
}
async function resyncAfterDrop() {
  try { await loadState(); } catch { return; }
  if (S.detailKey) { fetchDetail(); logResync(); }
}
function onStateEvent(d) {
  if (!S.state) return;
  if (Array.isArray(d.runs)) S.state.runs = d.runs;
  if (Array.isArray(d.cards)) S.state.cards = d.cards;
  if (d.engine) { S.state.engine = Object.assign({}, S.state.engine, d.engine); S.state.engine.providerPause = S.state.engine.providerPause || {}; }
  if (d.quota) S.state.quota = d.quota;
  if (Array.isArray(d.accounts)) S.state.accounts = d.accounts;
  if (d.now) S.offset = d.now - Date.now();
  renderLive();
  if (S.view === 'board') boardPoke(false);
}
function renderConn() {
  if (!HDR.conn) return;
  const up = S.sse.ok;
  HDR.conn.classList.toggle('is-off', !up && S.sse.everOpen);
  HDR.conn.hidden = !S.sse.everOpen && !up;
  HDR.connIcon.replaceChildren();
  setText(HDR.connLbl, up ? 'Live' : 'Reconnecting');
  HDR.conn.title = up ? 'Live updates connected' : 'Live updates disconnected. Retrying automatically.';
}

/* ───────────────────────── header ───────────────────────── */
const HDR = {};
function buildHeader() {
  const top = $('#topbar');
  HDR.version = h('small');
  const brand = h('a', { class: 'brand', href: '#/', 'aria-label': 'Conductor, home' },
    h('span', { class: 'brand-mark' }, icon('baton')), h('span', { class: 'brand-name' }, 'Conductor'), HDR.version);
  HDR.badge = h('span', { class: 'nav-badge', hidden: true });
  HDR.navHome = h('a', { class: 'nav-tab', href: '#/' }, 'Home');
  HDR.navBoard = h('a', { class: 'nav-tab', href: '#/board' }, 'Board', HDR.badge);
  HDR.nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, HDR.navHome, HDR.navBoard);
  HDR.pill = h('span', { class: 'st st-ready' });
  HDR.pillSig = '';
  HDR.pauseBtn = h('button', { type: 'button', class: 'btn', onclick: toggleEngine });
  HDR.pauseSig = '';
  HDR.engine = h('div', { class: 'engine' }, HDR.pill, HDR.pauseBtn);
  HDR.qLabel = h('span'); HDR.qPct = h('b'); HDR.qFill = h('span');
  HDR.meter = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Claude usage' }, HDR.qFill);
  HDR.qSub = h('div', { class: 'quota-sub' });
  HDR.quota = h('div', { class: 'quota', hidden: true }, h('div', { class: 'quota-top' }, HDR.qLabel, HDR.qPct), HDR.meter, HDR.qSub);
  HDR.connIcon = h('span', { class: 'dot' });
  HDR.connLbl = h('span', { class: 'conn-label' });
  HDR.conn = h('span', { class: 'conn', hidden: true }, HDR.connIcon, HDR.connLbl);
  HDR.newBtn = h('button', { type: 'button', class: 'btn btn-primary', 'aria-label': 'New task', onclick: () => openNewTask() }, icon('plus'), h('span', { class: 'btn-label-hide' }, 'New task'));
  HDR.setBtn = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Settings', title: 'Settings', onclick: () => openSettings() }, icon('sliders'));
  // M8-3: accounts popover (labels and states only — never an email or a path)
  HDR.acctN = h('span', { class: 'nav-badge', hidden: true });
  HDR.acctBtn = h('button', { type: 'button', class: 'btn btn-icon acct-btn', 'aria-label': 'Accounts', title: 'Accounts', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', hidden: true, onclick: () => toggleAcctPop() }, icon('lock'), HDR.acctN);
  HDR.acctPop = h('div', { class: 'acct-pop', role: 'dialog', 'aria-label': 'Accounts', hidden: true });
  top.append(brand, HDR.nav, HDR.engine, HDR.quota, h('span', { class: 'tb-spacer' }), HDR.conn, HDR.newBtn, HDR.acctBtn, HDR.setBtn, HDR.acctPop);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !HDR.acctPop.hidden) closeAcctPop(true); });
  document.addEventListener('click', (e) => { if (!HDR.acctPop.hidden && !HDR.acctPop.contains(e.target) && !HDR.acctBtn.contains(e.target)) closeAcctPop(false); });
}
/* ───────────────────────── M8-3 accounts ───────────────────────── */
const ACCT_STATUS = { ready: 'Ready', 'in-use': 'In use', 'at-limit': 'At its limit', 'not-signed-in': 'Not signed in', 'not-installed': 'Not installed', checking: 'Checking…', unknown: 'Unknown', unavailable: 'Unavailable' };
const ACCT_CLS = { ready: 'st-ready', 'in-use': 'st-building', 'at-limit': 'st-paused', 'not-signed-in': 'st-needs', 'not-installed': 'st-needs', checking: 'st-planning', unknown: '', unavailable: 'st-needs' };
const accountsOf = (tool) => ((S.state && S.state.accounts) || []).filter((a) => a.provider === tool);
/** "Claude" with one sign-in; "Claude · Work" with several (the server's own rule). */
function acctLabel(a) { return a.isDefault && accountsOf(a.provider).length <= 1 ? (AGENT_LABEL[a.provider] || a.provider) : (AGENT_LABEL[a.provider] || a.provider) + ' · ' + a.name; }
function acctStatusNode(a) {
  const until = a.status === 'at-limit' && a.until ? [' until ', fmtWhen(a.until)] : [];
  return h('span', { class: 'st st-sm ' + (ACCT_CLS[a.status] || '') }, ACCT_STATUS[a.status] || a.status, ...until);
}
/** Codex is listed only while it holds a job (its accounts are dormant). */
const acctShown = (a) => a.provider !== 'codex' || ((S.state.providers || []).find((p) => p.id === 'codex') || {}).inUse === true;
function toggleAcctPop() { if (HDR.acctPop.hidden) openAcctPop(); else closeAcctPop(true); }
function openAcctPop() {
  const list = (S.state && S.state.accounts) || [];
  HDR.acctPop.replaceChildren(
    h('h3', null, 'Accounts'),
    h('ul', { class: 'acct-list' }, list.filter(acctShown).map((a) => h('li', { class: 'acct-row' }, h('span', { class: 'acct-name' }, acctLabel(a)), acctStatusNode(a)))),
    h('p', { class: 'muted' }, M.LIMIT_RULE_HINT[(S.state.settings && S.state.settings.limitRuleEffective) || 'switch'] || ''),
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { closeAcctPop(false); openSettings('accounts'); } }, icon('sliders'), h('span', null, 'Manage accounts')));
  HDR.acctPop.hidden = false;
  HDR.acctBtn.setAttribute('aria-expanded', 'true');
  const b = HDR.acctPop.querySelector('button'); if (b) b.focus();
}
function closeAcctPop(focus) { HDR.acctPop.hidden = true; HDR.acctBtn.setAttribute('aria-expanded', 'false'); if (focus) HDR.acctBtn.focus(); }
function updateAcctButton(wizard) {
  const list = S.state.accounts;
  toggleHidden(HDR.acctBtn, wizard || !list);
  if (!list) return;
  const lim = list.filter((a) => a.status === 'at-limit').length;
  toggleHidden(HDR.acctN, !lim);
  setText(HDR.acctN, lim || '');
  HDR.acctBtn.title = lim ? (lim === 1 ? '1 account is at its usage limit' : lim + ' accounts are at their usage limit') : 'Accounts';
}
function engineView(eng) {
  const pp = eng.providerPause || {};
  const waiting = Object.keys(pp).filter((a) => pp[a]);
  if (eng.paused) {
    return { cls: 'st-paused', icon: 'pause', label: 'Paused', title: eng.pauseReason || 'No new work starts. Running stages finish.' };
  }
  if (waiting.length) {
    const names = waiting.map((a) => AGENT_LABEL[a] || a).join(' and ');
    return { cls: 'st-planning', icon: 'clock', label: 'Waiting for ' + names, title: waiting.map((a) => pp[a].reason).filter(Boolean).join('\n') || 'Usage limit reached' };
  }
  const busy = eng.maxParallel ? ` · ${eng.running || 0}/${eng.maxParallel} busy` : '';
  const polled = eng.lastPollAt ? 'Last checked the board ' + fmtAgo(eng.lastPollAt) : 'Waiting for the first check';
  return { cls: 'st-ready', icon: 'check', label: 'Running' + busy, pulse: (eng.running || 0) > 0, title: polled };
}
function updateHeader(wizard) {
  const st = S.state;
  updateAcctButton(wizard);
  toggleHidden(HDR.version, !st.version);
  setText(HDR.version, st.version ? 'v' + st.version : '');
  toggleHidden(HDR.engine, wizard);
  toggleHidden(HDR.nav, !st.setup.complete);
  const onHome = !wizard && S.route.view === 'home';
  const onBoard = !wizard && S.route.view === 'board';
  toggleHidden(HDR.newBtn, !onBoard);
  toggleHidden(HDR.setBtn, wizard);
  for (const [el, on] of [[HDR.navHome, onHome], [HDR.navBoard, onBoard]]) {
    el.classList.toggle('is-on', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  }
  const need = needYouCount();
  toggleHidden(HDR.badge, !need);
  setText(HDR.badge, need || '');
  HDR.badge.setAttribute('aria-label', need === 1 ? '1 needs you' : need + ' need you');

  const ev = engineView(st.engine);
  const sig = ev.cls + '|' + ev.label + '|' + (ev.pulse ? 1 : 0);
  if (sig !== HDR.pillSig) {
    HDR.pillSig = sig;
    HDR.pill.className = 'st ' + ev.cls;
    HDR.pill.replaceChildren(ev.pulse ? h('span', { class: 'dot pulse' }) : icon(ev.icon), ev.label);
  }
  HDR.pill.title = ev.title || '';

  const paused = !!st.engine.paused;
  const busy = S.busy.has('engine:pause');
  const psig = paused + '|' + busy;
  if (psig !== HDR.pauseSig) {
    HDR.pauseSig = psig;
    HDR.pauseBtn.className = 'btn' + (paused ? ' btn-primary' : '') + (busy ? ' is-busy' : '');
    HDR.pauseBtn.disabled = busy;
    HDR.pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause-bars'), h('span', { class: 'btn-label-hide' }, paused ? 'Resume' : 'Pause'));
    HDR.pauseBtn.setAttribute('aria-label', paused ? 'Resume the engine' : 'Pause the engine');
    HDR.pauseBtn.title = paused ? 'Let Conductor start new work again' : 'Stop starting new work. Running stages finish.';
  }

  const c = !wizard && st.quota ? st.quota.claude : null;
  const p7 = c ? pctOf(c.utilization7d) : null;
  const p5 = c ? pctOf(c.utilization5h) : null;
  const show = !!c && (p7 !== null || p5 !== null || c.rejected);
  toggleHidden(HDR.quota, !show);
  if (show) {
    const main = p7 !== null ? p7 : p5 !== null ? p5 : 100;
    const crit = c.rejected || main >= 95;
    setText(HDR.qLabel, p7 !== null || c.rejected ? 'Claude 7-day' : 'Claude 5-hour');
    setText(HDR.qPct, main + '%');
    HDR.meter.setAttribute('aria-valuenow', String(main));
    HDR.meter.setAttribute('aria-valuetext', `${main} percent used${c.rejected ? ', limit reached' : ''}`);
    HDR.meter.className = 'meter' + (crit ? ' m-crit' : main >= 80 ? ' m-warn' : '');
    HDR.qFill.style.setProperty('--pct', main + '%');
    const bits = [];
    if (c.rejected) bits.push('Limit reached');
    if (c.resetsAt) bits.push('resets ' + fmtWhen(c.resetsAt));
    if (p5 !== null && p7 !== null) bits.push('5h ' + p5 + '%');
    setText(HDR.qSub, bits.join(' · '));
    HDR.quota.title = 'Claude plan usage. Conductor pauses Claude stages at the limit and resumes automatically.';
  }
}
function toggleEngine() {
  const paused = !S.state.engine.paused;
  return runAction('engine', 'pause', () => api('POST', '/api/engine/pause', { paused }),
    paused ? 'Engine paused. Running stages finish, nothing new starts.' : 'Engine resumed.');
}

/** Run a mutation, then always trust server state (refetch). Returns true on success. */
async function runAction(scope, name, call, okMsg) {
  const id = scope + ':' + name;
  if (S.busy.has(id)) return false;
  S.busy.add(id);
  renderLive();
  let ok = false;
  try { await call(); ok = true; if (okMsg) toast('good', okMsg); }
  catch (e) { if (!(e instanceof ApiFail && e.status === 401)) toast('error', (e && e.message) || 'Something went wrong.'); }
  S.busy.delete(id);
  try { await loadState(); } catch { renderLive(); }
  if (S.detailKey) fetchDetail();
  return ok;
}

/* ───────────────────────── banners ───────────────────────── */
let bannerSig = '';
function computeBanners(wizard) {
  const st = S.state; const out = [];
  if (wizard) return out;
  const eng = st.engine; const pp = eng.providerPause || {};
  for (const a of Object.keys(pp)) {
    const p = pp[a];
    if (!p) continue;
    const lines = [];
    if (p.reason) lines.push(p.reason);
    lines.push(a === 'claude' && st.settings && st.settings.onClaudeLimit === 'cursor'
      ? 'Read-only stages run on Cursor meanwhile. Everything else continues.'
      : `Stages that need ${AGENT_LABEL[a] || a} wait. Nothing is lost, runs resume by themselves.`);
    out.push({ id: 'pp-' + a, cls: 'b-limit', icon: 'clock', title: `${AGENT_LABEL[a] || a} usage limit`, text: ' — resuming automatically at ' + fmtWhen(p.until), until: p.until, lines });
  }
  // M8-3: one account at its limit while the tool still has a free one ⇒ work continues elsewhere (labels only)
  for (const tool of ['claude', 'cursor', 'codex']) {
    if (pp[tool]) continue;
    const lim = accountsOf(tool).filter((a) => a.status === 'at-limit');
    if (!lim.length) continue;
    const soonest = Math.min(...lim.map((a) => a.until || Infinity));
    out.push({ id: 'acct-lim-' + tool, cls: 'b-info', icon: 'clock', title: lim.map(acctLabel).join(', ') + (lim.length === 1 ? ' is at its usage limit' : ' are at their usage limit'),
      text: ' — work continues on the next account the limit rule allows.', until: Number.isFinite(soonest) ? soonest : undefined });
  }
  const broken = ((st.accounts) || []).filter((a) => a.status === 'unavailable' && !a.isDefault && a.provider !== 'codex');
  if (broken.length) out.push({ id: 'acct-bad', cls: 'b-error', icon: 'warn', title: broken.length === 1 ? 'An account cannot be used' : broken.length + ' accounts cannot be used', text: '', lines: broken.map((a) => acctLabel(a) + ': ' + (a.note || 'Unavailable.')), list: true, action: { label: 'Accounts', href: '#/', onclick: () => openSettings('accounts') } });
  const cardKeys = new Set((st.cards || []).map((c) => c.key));
  const hidden = (eng.ignored || []).filter((i) => !cardKeys.has(i.key));
  if (hidden.length) {
    out.push({ id: 'ignored', cls: 'b-error', icon: 'warn', title: hidden.length === 1 ? 'One card is being ignored' : `${hidden.length} cards are being ignored`, text: '', lines: hidden.slice(0, 8).map((i) => `${i.key}: ${i.reason}`), list: true });
  }
  if (eng.offline) {
    out.push({ id: 'offline', cls: 'b-limit', icon: 'clock', title: 'Offline', text: ' — no network.', lines: ['Still working offline: the board, notes, history, project context and quality gates. Planning, review, verification and builds wait for the network and resume by themselves.'] });
  }
  if (eng.storageProblem || eng.lastPollError) {
    out.push({ id: 'storage', cls: 'b-error', icon: 'warn', title: 'The board cannot be saved right now', text: ' ' + (eng.storageProblem || eng.lastPollError), lines: ['Check free disk space and permissions on the data folder. Conductor keeps retrying; running stages are not affected.'] });
  }
  const hl = st.health || {};
  const agents = [['claude', 'Claude Code'], ['cursor', 'Cursor agent']];
  for (const [id, name] of agents) {
    const a = hl[id];
    if (a && !a.ok) {
      out.push({ id: 'h-' + id, cls: 'b-error', icon: 'warn', title: `${name} needs attention`, text: ' ' + (a.detail || (a.found === false ? 'Not found on your PATH.' : a.loggedIn === false ? 'Not signed in.' : 'The last health check failed.')), action: { label: 'Open setup', href: '#/setup' } });
    }
  }
  // any other provider that is actually assigned to a role and is not healthy (Codex, …): shown with the server's label and its fixed hint
  for (const p of st.providers || []) {
    if (!p || p.id === 'claude' || p.id === 'cursor' || !p.inUse || p.state === 'ok') continue;
    out.push({ id: 'h-' + p.id, cls: 'b-error', icon: 'warn', title: `${p.label} needs attention`, text: ' ' + (p.detail || p.state), lines: p.hint ? [p.hint] : [] });
  }
  if (Array.isArray(hl.warnings) && hl.warnings.length) {
    const key = 'warn:' + hl.warnings.join('\n');
    if (!S.dismissed.has(key) && !storeGet('dismiss:' + key)) {
      out.push({ id: 'warnings', cls: '', icon: 'warn', title: hl.warnings.length === 1 ? 'Heads up' : `${hl.warnings.length} things to check`, text: '', lines: hl.warnings.slice(), list: true, dismiss: key });
    }
  }
  if (S.sse.everOpen && !S.sse.ok && S.sse.downSince && Date.now() - S.sse.downSince > 3000) {
    out.push({ id: 'sse', cls: 'b-info', icon: 'wifi-off', title: 'Live updates paused', text: ' — reconnecting automatically. The board may be out of date.' });
  }
  return out;
}
function renderBanners(wizard) {
  const items = computeBanners(wizard);
  const sig = JSON.stringify(items);
  if (sig === bannerSig) return;
  bannerSig = sig;
  const host = $('#banners');
  host.replaceChildren(...items.map((b) => {
    const body = h('div', { class: 'banner-body' }, h('p', null, h('b', null, b.title), b.text || '',
      b.until ? [' (in ', h('span', { class: 'num', data: { t1: b.until } }, ''), ')'] : null));
    if (b.lines && b.lines.length) {
      if (b.list) body.appendChild(h('ul', null, b.lines.map((l) => h('li', null, l))));
      else for (const l of b.lines) body.appendChild(h('p', { class: 'muted-line' }, l));
    }
    return h('div', { class: 'banner ' + b.cls, role: 'group', 'aria-label': b.title, data: { id: b.id } },
      icon(b.icon), body,
      b.action ? (b.action.onclick ? h('button', { type: 'button', class: 'btn btn-sm', onclick: b.action.onclick }, b.action.label) : h('a', { class: 'btn btn-sm', href: b.action.href }, b.action.label)) : null,
      b.dismiss ? h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Dismiss: ' + b.title, data: { dismiss: b.dismiss }, onclick: () => {
        S.dismissed.add(b.dismiss); storeSet('dismiss:' + b.dismiss, '1'); renderBanners(isWizard()); tick();
      } }, icon('x')) : null);
  }));
}

/* ───────────────────────── timers ───────────────────────── */
function tickEl(el) {
  const d = el.dataset;
  if (d.t0) setText(el, fmtDur(nowMs() - Number(d.t0)));
  else if (d.t1) { const r = Number(d.t1) - nowMs(); setText(el, r > 1000 ? fmtDur(r) : 'any moment'); }
  else if (d.ago) setText(el, fmtAgo(Number(d.ago)));
}
function tick() { for (const el of document.querySelectorAll('[data-t0],[data-t1],[data-ago]')) tickEl(el); tickLogAgo(); }

/* ───────────────────────── run actions (cards + drawer) ───────────────────────── */
const runUrl = (key, what) => `/api/runs/${enc(key)}/${what}`;
const runRev = (key) => { if (S.detail && S.detail.key === key && Number.isFinite(S.detail.rev)) return S.detail.rev; const r = S.state && S.state.runs.find((x) => x.key === key); return r ? r.rev : 0; };
const actApprove = async (key) => {
  const d = S.detail && S.detail.key === key ? S.detail : null;
  const risks = (d && d.risks) || [];
  let confirmRisks = false;
  if (risks.length) {
    confirmRisks = await confirmDialog({ title: `Approve ${key}?`, body: 'This plan includes risky steps: ' + risks.map((x) => x.rule + ' (' + x.detail + ')').join('; ') + '. Conductor cannot stop a builder from running its own commands — only approve if you understand what this plan runs.', confirmLabel: 'I understand — approve', danger: true });
    if (!confirmRisks) return;
  }
  return runAction(key, 'approve', () => api('POST', runUrl(key, 'approve'), { rev: runRev(key), confirmRisks }), `Plan for ${key} approved. Cursor starts building.`);
};
const actMove = (key, lane, msg) => runAction(key, 'move:' + lane, () => api('POST', `/api/items/${enc(key)}/move`, { lane }), msg);
const actRetry = (key) => runAction(key, 'retry', () => api('POST', runUrl(key, 'retry')), `${key}: retry started.`);
const actResume = (key) => runAction(key, 'resume', () => api('POST', runUrl(key, 'resume')), `${key} resumed.`);
const actOpen = (key, target) => runAction(key, 'open:' + target, () => api('POST', runUrl(key, 'open'), { target }), OPEN_LABEL[target] || 'Opened');
async function actAbort(key) {
  const ok = await confirmDialog({
    title: `Abort ${key}?`,
    body: 'This stops the running agent and marks the run aborted. The worktree and branch stay on disk until you clean up.',
    confirmLabel: 'Abort run', danger: true,
  });
  if (ok) await runAction(key, 'abort', () => api('POST', runUrl(key, 'abort')), `${key} aborted.`);
}
async function actCleanup(key) {
  const ok = await confirmDialog({
    title: `Remove the worktree for ${key}?`,
    body: 'Deletes the working copy Conductor created for this run, and the local branch if it is already merged. Your main checkout is not touched.',
    confirmLabel: 'Remove worktree', danger: true,
  });
  if (ok) await runAction(key, 'cleanup', () => api('POST', runUrl(key, 'cleanup')), `Worktree for ${key} removed.`);
}
function setBusy(el, busy) {
  el.classList.toggle('is-busy', busy);
  if (el.disabled !== busy) el.disabled = busy;
}

/* ───────────────────────── roles (GET /api/roles): who does each job ───────────────────────── */
/** Display name of a provider id (labels come from the server's provider list). */
const provLabel = (id) => (id ? AGENT_LABEL[id] || String(id) : '');
const roleLead = (role) => (S.roles ? M.leadOf(S.roles.roles, role) : null);
let rolesLoading = null;
/** Fetched on load, after any role change, when Settings opens, and when the provider list changes (N5). Failure keeps the static wording. */
function loadRoles() {
  if (rolesLoading) return rolesLoading;
  rolesLoading = (async () => {
    try { S.roles = await api('GET', '/api/roles'); S.rolesErr = null; }
    catch (e) { if (!(e instanceof ApiFail && e.status === 401)) S.rolesErr = e; }
    finally { rolesLoading = null; }
    if (S.state && !S.expired) renderLive();
    return S.roles;
  })();
  return rolesLoading;
}
const providersSig = (ps) => JSON.stringify((ps || []).map((p) => [p.id, p.state, p.tier, p.inUse]));

/**
 * Change who leads one or more jobs (Settings rows or the Home "Handled by" popover). Always from a FRESH GET /api/roles:
 * roleEdit keeps every other field of each role; unverified providers are acknowledged one by one in a modal, and only the
 * confirmed ids are sent (Security U1). A 409 that still comes back is shown and the flow stops. Returns
 * { ok, notices, error, canceled, nothing }.
 */
async function applyRoleChanges(changes, sels, toolModels) {
  let fresh;
  try { fresh = await api('GET', '/api/roles'); S.roles = fresh; } catch (e) { return { ok: false, error: e.message }; }
  // M8-2: each row's model choice rides on the same PUT (sels: row id → choice; toolModels: "Default model for each tool")
  const patch = M.withSel(M.rolesPatch(fresh.roles, changes || {}), fresh.roles, sels || {});
  const tm = toolModels && typeof toolModels === 'object' && Object.keys(toolModels).length ? toolModels : null;
  if (!Object.keys(patch.roles).length && !tm) return { ok: true, nothing: true, notices: [] };
  const confirmed = [];
  for (const a of M.acksNeeded(fresh.roles, fresh.choices, patch)) {
    const name = provLabel(a.provider);
    const extra = a.roles.filter((r) => !M.ROLE_ROWS.some((x) => x.role === r));
    const ok = await confirmDialog({
      title: `Use ${name} for: ${a.rows.join(', ')}?`,
      body: `${name}'s isolation has not been verified on this machine.${extra.length ? ` It would also be used for ${extra.join(', ')}.` : ''} This is a global setting: it changes who does this job for every request and every card.`,
      confirmLabel: 'Use it anyway', danger: true,
    });
    if (!ok) return { ok: false, canceled: true };
    confirmed.push(a.provider);
  }
  try {
    const body = M.withAck(patch, confirmed);
    if (tm) body.toolModels = JSON.parse(JSON.stringify(tm));
    const r = await api('PUT', '/api/roles', body);
    const notices = Array.isArray(r && r.notices) ? r.notices.filter((x) => typeof x === 'string') : [];
    for (const n of notices) toast('warn', n);
    await loadRoles();
    return { ok: true, notices };
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401) return { ok: false, error: e.message };
    loadRoles();
    // a 409 here means the choices changed after the fresh GET: say so plainly, keep the server's text as the detail; never resend
    if (e instanceof ApiFail && e.status === 409) return { ok: false, error: 'The tool settings changed while you were editing. Reload Settings and try again.\n' + e.message };
    // "Save refused with focus": the server names the control (allow-listed names only)
    const field = e instanceof ApiFail && e.info && typeof e.info.field === 'string' ? e.info.field : null;
    return { ok: false, error: e.message, field };
  }
}

/* ───────────────────────── M8-2: model and effort for a job ───────────────────────── */
/**
 * Model / effort / Fast / Thinking / custom id for one Settings row or the Handled-by popover: a draft until Save. The lists come from
 * GET /api/roles (`models[tool]`, each tool in its own words); the fitted choice, its notes and "Runs as …" come from POST
 * /api/roles/preview — the server's own fitting and argv code. Nothing is fitted or composed here. Every label is a text node.
 */
const CUSTOM_MODEL = '\u0000custom';
const modelsOf = (tool) => { const m = S.roles && S.roles.models && S.roles.models[tool]; return m && typeof m === 'object' ? m : null; };
const levelLabel = (tool, v) => { const m = modelsOf(tool); const l = m && Array.isArray(m.levels) ? m.levels.find((x) => x.value === v) : null; return l ? l.label : String(v); };
const fieldRow = (field) => { const m = /^roles\.([a-z]+)\.([a-zA-Z]+)$/.exec(String(field || '')); if (!m) return null; const row = M.ROLE_ROWS.find((r) => r.role === m[1] || r.followers.includes(m[1])); return row ? { row: row.id, key: m[2] } : null; };
function modelEditor(o) {
  // o: { row, tool, entry, view, onChange() }
  let tool = o.tool;
  const initial = M.selOf(o.entry, tool);
  let sel = M.selFields(initial);
  let base = M.selFields(initial); // what the current tool starts from: a pure tool switch sends no model fields (the server clears and fits)
  const modelSel = h('select', { class: 'select select-sm', 'aria-label': 'Model for ' + o.row.label });
  const effortSel = h('select', { class: 'select select-sm' });
  const effortLbl = h('span', { class: 'eff-l' });
  const fastCb = h('input', { type: 'checkbox' });
  const thinkCb = h('input', { type: 'checkbox' });
  const fastLbl = h('label', { class: 'check' }, fastCb, h('span', null, 'Fast'));
  const thinkLbl = h('label', { class: 'check' }, thinkCb, h('span', null, 'Thinking'));
  const customIn = h('input', { class: 'input input-sm', type: 'text', maxlength: '74', autocomplete: 'off', spellcheck: 'false', placeholder: 'for example claude-haiku-5-5', 'aria-label': 'Custom model id for ' + o.row.label });
  const customLbl = h('label', { class: 'who-custom' }, h('span', { class: 'eff-l' }, 'Custom model id'), customIn);
  const hint = h('span', { class: 'muted who-hint-sm' });
  const runs = h('code');
  const notes = h('div', { class: 'who-notes', role: 'status' });
  const problem = h('p', { class: 'err', role: 'alert', hidden: true });
  const el = h('div', { class: 'who-model' },
    h('div', { class: 'who-ctl' }, h('label', { class: 'eff eff-model' }, h('span', { class: 'eff-l' }, 'Model'), modelSel), h('label', { class: 'eff' }, effortLbl, effortSel)),
    h('div', { class: 'who-extra' }, h('span', { class: 'who-flags' }, fastLbl, thinkLbl), customLbl, hint, h('span', { class: 'who-run muted' }, 'Runs as ', runs)),
    notes, problem);
  const option = () => { const m = modelsOf(tool); return m && Array.isArray(m.options) && sel.model && !sel.custom ? m.options.find((x) => x.value === sel.model) || null : null; };
  const levels = () => {
    const m = modelsOf(tool);
    if (!m) return null;
    if (sel.custom) return m.customEfforts;
    if (sel.model) { const op = option(); return op ? op.efforts : null; }
    return m.defaultEfforts;
  };
  const showView = (v) => {
    setText(runs, v && typeof v.runsAs === 'string' ? v.runsAs : '');
    const ns = v && Array.isArray(v.notes) ? v.notes.filter((x) => typeof x === 'string') : [];
    notes.replaceChildren(...ns.map((n) => h('p', { class: 'warn-note who-note' }, n)));
  };
  const render = () => {
    const m = modelsOf(tool) || { options: [], levels: [], defaultLabel: 'the tool chooses', effortLabel: 'Effort' };
    const opts = [h('option', { value: '' }, 'Tool default (' + m.defaultLabel + ')')];
    for (const x of m.options || []) opts.push(h('option', { value: x.value }, x.label + (x.noZdr ? ' (NO ZDR)' : '')));
    if (sel.model && !sel.custom && !option()) opts.push(h('option', { value: sel.model }, sel.model + ' — No longer available'));
    opts.push(h('option', { value: CUSTOM_MODEL }, 'Custom model id…'));
    modelSel.replaceChildren(...opts);
    modelSel.value = sel.custom ? CUSTOM_MODEL : sel.model || '';
    setText(effortLbl, m.effortLabel);
    const lv = levels();
    const op = option();
    const eo = [h('option', { value: '' }, lv ? (op && op.hasBase ? 'Default' : 'Tool decides') : 'No effort setting')];
    for (const v of lv || []) eo.push(h('option', { value: v }, levelLabel(tool, v)));
    if (sel.effort && !(lv || []).includes(sel.effort)) eo.push(h('option', { value: sel.effort }, levelLabel(tool, sel.effort) + ' (not offered)'));
    effortSel.replaceChildren(...eo);
    effortSel.value = sel.effort || '';
    effortSel.disabled = !lv && !sel.effort;
    toggleHidden(fastLbl, !(tool === 'cursor' && op && op.fast));
    toggleHidden(thinkLbl, !(tool === 'cursor' && op && op.thinking));
    fastCb.checked = sel.fast; thinkCb.checked = sel.thinking;
    toggleHidden(customLbl, !sel.custom);
    if (sel.custom && customIn.value !== (sel.model || '')) customIn.value = sel.model || '';
    setText(hint, sel.custom && m.customEffortHint ? m.customEffortHint : m.state && m.state !== 'fresh' && m.reason ? m.reason : '');
  };
  // "Runs as …" for the draft, from the server (stale answers are ignored)
  let seq = 0;
  let timer = 0;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++seq;
      const changes = tool !== M.leadOf(S.roles.roles, o.row.role) ? { [o.row.id]: tool } : {};
      const body = M.withSel(M.rolesPatch(S.roles.roles, changes), S.roles.roles, dirty() ? { [o.row.id]: sel } : {});
      if (!Object.keys(body.roles).length) { showView(o.view); toggleHidden(problem, true); return; }
      try {
        const r = await api('POST', '/api/roles/preview', body);
        if (my !== seq) return;
        showView(r && r.roleViews ? r.roleViews[o.row.role] : null);
        const mine = (r && Array.isArray(r.problems) ? r.problems : []).filter((p) => p && typeof p.field === 'string' && fieldRow(p.field) && fieldRow(p.field).row === o.row.id && typeof p.message === 'string');
        setText(problem, mine.map((p) => p.message).join(' '));
        toggleHidden(problem, !mine.length);
      } catch (e) {
        if (my !== seq) return;
        setText(problem, e.message); toggleHidden(problem, false);
      }
    }, 250);
  };
  const changed = () => { render(); preview(); if (o.onChange) o.onChange(); };
  const dirty = () => !M.sameSel(sel, base);
  modelSel.addEventListener('change', () => {
    const v = modelSel.value;
    if (v === CUSTOM_MODEL) sel = { model: customIn.value.trim() || null, custom: true, effort: sel.effort, fast: false, thinking: false };
    else sel = { model: v || null, custom: false, effort: sel.effort, fast: false, thinking: false }; // a model change keeps the effort; the server fits it
    sel.custom = sel.custom && !!sel.model;
    if (v === CUSTOM_MODEL) { render(); toggleHidden(customLbl, false); customIn.focus(); preview(); if (o.onChange) o.onChange(); return; }
    changed();
  });
  customIn.addEventListener('change', () => { const t = customIn.value.trim(); sel = { model: t || null, custom: !!t, effort: sel.effort, fast: false, thinking: false }; changed(); if (!t) { toggleHidden(customLbl, false); } });
  effortSel.addEventListener('change', () => { sel = Object.assign({}, sel, { effort: effortSel.value || null }); changed(); });
  fastCb.addEventListener('change', () => { sel = Object.assign({}, sel, { fast: fastCb.checked }); changed(); });
  thinkCb.addEventListener('change', () => { sel = Object.assign({}, sel, { thinking: thinkCb.checked }); changed(); });
  render();
  showView(o.view);
  return {
    el,
    /** A tool change resets the model to that tool's default and keeps the effort (the server fits it, with a note). */
    setTool(t) {
      if (t === tool) return;
      tool = t;
      sel = t === o.tool ? M.selFields(initial) : { model: null, custom: false, effort: initial.effort, fast: false, thinking: false };
      base = M.selFields(sel);
      customIn.value = '';
      render();
      if (t === o.tool) { clearTimeout(timer); seq++; showView(o.view); toggleHidden(problem, true); } else preview();
    },
    /** The choice to send, or null when nothing changed for this row. */
    value() { return dirty() ? M.selFields(sel) : null; },
    focus(key) { const t = key === 'effort' ? effortSel : key === 'fast' ? fastCb : key === 'thinking' ? thinkCb : sel.custom ? customIn : modelSel; if (!t.hidden && !(t.parentElement && t.parentElement.hidden)) t.focus(); else modelSel.focus(); },
    showError(m) { setText(problem, m); toggleHidden(problem, !m); },
  };
}
/** "Default model for each tool": one select per tool (+ a custom id), a draft until Save. */
function toolDefaultsEditor() {
  const draft = {};
  const ctl = {};
  const rows = ['claude', 'cursor', 'codex'].map((t) => {
    const m = modelsOf(t) || { options: [] };
    const cur = (S.roles && S.roles.toolModels && S.roles.toolModels[t]) || { model: null, custom: false };
    const sel = h('select', { class: 'select select-sm', 'aria-label': 'Default model for ' + provLabel(t) });
    const opts = [h('option', { value: '' }, 'The tool chooses')];
    for (const x of m.options || []) opts.push(h('option', { value: x.value }, x.label));
    if (cur.model && !cur.custom && !(m.options || []).some((x) => x.value === cur.model)) opts.push(h('option', { value: cur.model }, cur.model + ' — No longer available'));
    opts.push(h('option', { value: CUSTOM_MODEL }, 'Custom model id…'));
    sel.replaceChildren(...opts);
    sel.value = cur.custom ? CUSTOM_MODEL : cur.model || '';
    const inp = h('input', { class: 'input input-sm', type: 'text', maxlength: '74', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Custom default model id for ' + provLabel(t), value: cur.custom ? cur.model : '' });
    const wrap = h('label', { class: 'who-custom', hidden: !cur.custom }, h('span', { class: 'eff-l' }, 'Custom model id'), inp);
    const upd = () => {
      const v = sel.value;
      toggleHidden(wrap, v !== CUSTOM_MODEL);
      const next = v === CUSTOM_MODEL ? { model: inp.value.trim() || null, custom: !!inp.value.trim() } : { model: v || null, custom: false };
      if (next.model === (cur.model || null) && next.custom === !!cur.custom) delete draft[t];
      else draft[t] = next;
    };
    sel.addEventListener('change', () => { upd(); if (sel.value === CUSTOM_MODEL) inp.focus(); });
    inp.addEventListener('change', upd);
    ctl[t] = { sel, inp };
    return h('div', { class: 'td-row' }, h('label', { class: 'eff eff-model' }, h('span', { class: 'eff-l' }, provLabel(t)), sel), wrap);
  });
  const notices = (S.roles && Array.isArray(S.roles.legacyNotices) ? S.roles.legacyNotices : []).filter((n) => n && typeof n.message === 'string').map((n) => h('p', { class: 'warn-note' }, n.message));
  const el = h('details', { class: 'tool-defaults', open: notices.length > 0 },
    h('summary', null, 'Default model for each tool'),
    h('p', { class: 'who-intro' }, 'Used when a job says “Tool default”, and when work moves to another tool after a usage limit. The lists come from each tool itself.'),
    ...notices, h('div', { class: 'td-grid' }, rows));
  return { el, value: () => (Object.keys(draft).length ? JSON.parse(JSON.stringify(draft)) : null), focus(t) { if (ctl[t]) { el.open = true; (ctl[t].sel.value === CUSTOM_MODEL ? ctl[t].inp : ctl[t].sel).focus(); } } };
}

/* ───────────────────────── small widgets: pill radiogroups and menus ───────────────────────── */
/**
 * A radiogroup of pills (design .pills/.pill), updated in place so focus survives. items: [{ id, label, icon?, title?, locked? }].
 * Arrow keys / Home / End move and pick; a locked item takes focus and calls onLocked instead of being picked.
 */
function pillGroup(o) {
  const el = h('div', { class: 'pills' + (o.cls ? ' ' + o.cls : ''), role: 'radiogroup', 'aria-label': o.label });
  const btns = o.items.map((it) => {
    const lbl = h('span', null, it.label);
    const b = h('button', { type: 'button', role: 'radio', class: 'pill', title: it.title || null, 'aria-disabled': it.locked ? 'true' : null, data: { id: it.id } },
      it.icon ? icon(it.icon, 'icon-sm') : null, lbl);
    b._lbl = lbl;
    b.addEventListener('click', () => (it.locked ? (o.onLocked && o.onLocked(it)) : o.onPick(it.id)));
    return b;
  });
  el.append(...btns);
  el.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % btns.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = btns.length - 1;
    else return;
    e.preventDefault();
    btns[n].focus();
    btns[n].click();
  });
  const set = (value, labels) => {
    let any = false;
    btns.forEach((b, k) => {
      const on = b.dataset.id === value;
      any = any || on;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (labels && labels[k] !== undefined) setText(b._lbl, labels[k]);
    });
    if (!any && btns[0]) btns[0].tabIndex = 0;
  };
  set(o.value);
  return { el, set, btns };
}
/** Arrow / Home / End / Escape / Tab handling for a role="menu" (Escape and Tab close and return focus to the trigger). */
function menuKeys(menu, close) {
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll('[role^="menuitem"]'));
    const i = items.indexOf(document.activeElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = i < 0 ? 0 : (i + 1) % items.length;
    else if (e.key === 'ArrowUp') n = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    else if (e.key === 'Tab') { close(false); return; }
    else return;
    e.preventDefault();
    if (items[n]) items[n].focus();
  });
}

/* ───────────────────────── Home (design vmLanding / turnVM) ───────────────────────── */
const PLACEHOLDER = {
  auto: 'Ask a question, describe a feature, or name something to research…',
  ask: 'Ask about the code, for example “Where are rate limits enforced?”',
  work: 'Describe the feature or fix in one line…',
  research: 'What should be researched?',
};
const SUGGEST = {
  ask: ['How does cursor pagination work in the audit log?', 'Where are rate limits enforced?'],
  work: ['Add filters by user and date to the audit log', 'Add a dark mode toggle to the settings page'],
  research: ['Compare job-queue options for webhook retries', 'What is the safest way to roll out feature flags?'],
};
const MODE_PILLS = [
  { id: 'auto', label: 'Auto', icon: 'sparkle', title: 'Let Conductor decide from what you type' },
  { id: 'ask', label: 'Ask', icon: 'help', title: 'Quick Ask: answered here, no task' },
  { id: 'work', label: 'Build', icon: 'code', title: 'Engineering work: designed in detail, sent to the board' },
  { id: 'research', label: 'Research', icon: 'shield', title: 'Deep Research: a detailed brief, then a web report with sources' },
];
const MODE_CARDS = [
  { id: 'ask', title: 'Quick Ask', desc: 'A question or an explanation. Answered right here from your code. No task, no plan.' },
  { id: 'work', title: 'Engineering Work', desc: 'Features, refactors, bug fixes. Checked against your repo, designed in detail, and sent to the board as one or more tasks.' },
  { id: 'research', title: 'Deep Research', desc: 'Compare options and check evidence on the web. Written up as a detailed brief, then researched: a report with sources, shown as opened, listed or unverified.' },
];
const DISCLOSE = {
  ask: 'Answered from a read-only copy of the repository\'s base branch. Nothing is changed and no task is created unless you choose to.',
  research: 'First a short research brief for you to check, written by Claude from your question only (it cannot see your code). Then Claude searches and reads sources on the web and writes a report with citations. Needs the internet; uses your Claude plan.',
  work: 'Conductor reads a read-only copy of the repository, writes a detailed brief and splits it into tasks. Nothing goes to the board until you press Send.',
};
const MAX_TURNS = 20;
const ASK_POLL_MS = 1500;
S.home = { text: '', mode: 'auto', repo: '', allowChange: false, menu: null, turns: [], err: '', who: null };
const HM = { root: null };

const homeRepoNames = () => ((S.state && S.state.repos) || []).map((r) => r.name);
function lastRepo() { const v = storeGet('home:lastRepo'); return v && homeRepoNames().includes(v) ? v : ''; }
const effMode = () => (S.home.mode === 'auto' ? M.detectMode(S.home.text) : S.home.mode);
const homeRepo = () => M.resolveRepo({ text: S.home.text, chosen: S.home.repo, lastUsed: lastRepo(), names: homeRepoNames(), allowNone: noneAllowed(effMode()) });
const homeBusy = () => S.home.turns.some((t) => t.phase === 'sending' || t.phase === 'running' || t.phase === 'briefing');
/** A turn that can be stopped: a running ask/research, or a brief being written. */
const stoppable = (t) => (t.phase === 'running' && t.askId) || (t.phase === 'briefing' && t.briefId);
/** "No repository" is a real choice for Research, and for Ask unless exactly one repo is registered (the server then picks it). */
const noneAllowed = (mode) => M.noneAllowed(mode, homeRepoNames().length);
/** M8-6: with "Design the work" (state.home.design) Build is first handled by the Design row (requirements); otherwise by planning. */
const designOn = () => !!(S.state && S.state.home && S.state.home.design === true);
const researchBriefOn = () => !!(S.state && S.state.home && S.state.home.researchBrief === true);
const modeRow = (mode) => M.ROLE_ROWS.find((r) => r.id === (mode === 'work' && designOn() ? 'design' : M.MODE_META[mode].row));

function buildHomeView() {
  HM.hero = h('section', { class: 'home-hero', 'aria-labelledby': 'hero-h' },
    h('div', { class: 'home-hero-mark' }, icon('baton')),
    h('h1', { id: 'hero-h' }, 'What do you want to do?'),
    h('p', null, 'Write one line. Conductor checks it against your repository, writes it up properly, and sends it where it belongs.'));
  HM.clear = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: clearThread }, 'Clear');
  HM.turnList = h('div', { class: 'thread-list' });
  HM.turnEls = new Map();
  HM.thread = h('div', { class: 'thread', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', hidden: true },
    h('div', { class: 'thread-head' }, HM.clear), HM.turnList);
  HM.input = h('textarea', { id: 'cmp-text', class: 'cmp-input', rows: '1', maxlength: '4000', 'aria-label': 'Your request', placeholder: PLACEHOLDER.auto });
  HM.input.value = S.home.text;
  HM.input.addEventListener('input', () => { S.home.text = HM.input.value; fitComposer(); updateHome(); });
  HM.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); homeSubmit(); }
    else if (e.key === 'Escape' && S.home.menu) { e.preventDefault(); closeHomeMenus(false); }
  });
  HM.modes = pillGroup({ label: 'Type of request', items: MODE_PILLS, value: S.home.mode, onPick: (id) => { S.home.mode = id; S.home.menu = null; S.home.err = ''; updateHome(); } });
  HM.repoLbl = h('span');
  HM.repoBtn = h('button', { type: 'button', class: 'chip-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => toggleHomeMenu('repo') },
    icon('folder'), HM.repoLbl, icon('chevron', 'icon-sm'));
  HM.repoWrap = h('div', { class: 'menu-wrap' }, HM.repoBtn);
  HM.whoIcon = h('span', { class: 'who-ic' });
  HM.whoLbl = h('span');
  HM.whoBtn = h('button', { type: 'button', class: 'chip-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => toggleHomeMenu('who') },
    HM.whoIcon, HM.whoLbl, icon('chevron', 'icon-sm'));
  HM.whoWrap = h('div', { class: 'menu-wrap' }, HM.whoBtn);
  HM.sendIcon = h('span', { class: 'send-ic' });
  HM.send = h('button', { type: 'button', class: 'send', onclick: () => (S.home.turns.some(stoppable) ? stopRunningTurn() : homeSubmit()) }, HM.sendIcon);
  HM.note = h('p', { class: 'cmp-note' });
  HM.allowBox = h('input', { type: 'checkbox', onchange: () => { S.home.allowChange = HM.allowBox.checked; } });
  HM.allowLbl = h('span');
  HM.opt = h('div', { class: 'cmp-opt', hidden: true },
    h('label', { class: 'check' }, HM.allowBox, h('span', null, HM.allowLbl,
      h('span', { class: 'hint' }, 'Only if the question asks for a change. This starts a task and spends your plan quota; its approval rules still apply.'))));
  HM.err = h('p', { class: 'err cmp-err', role: 'alert', hidden: true });
  HM.suggest = h('div', { class: 'suggest', 'aria-label': 'Examples' });
  HM.suggestSig = '';
  const dock = h('div', { class: 'dock' },
    h('div', { class: 'composer' }, HM.input,
      h('div', { class: 'cmp-bar' }, HM.modes.el, h('span', { class: 'cmp-spacer' }), HM.repoWrap, HM.whoWrap, HM.send)),
    HM.note, HM.opt, HM.err, HM.suggest);
  HM.cardWho = {};
  HM.cards = h('div', { class: 'cards3' }, MODE_CARDS.map((c) => {
    HM.cardWho[c.id] = h('span', { class: 'mcard-who' });
    return h('button', { type: 'button', class: 'mcard', data: { mode: c.id }, onclick: () => { S.home.mode = c.id; S.home.err = ''; updateHome(); HM.input.focus(); } },
      h('span', { class: 'mcard-ic' }, icon(M.MODE_META[c.id].icon)), h('span', { class: 'mcard-t' }, c.title), h('span', { class: 'mcard-d' }, c.desc), HM.cardWho[c.id]);
  }));
  HM.tools = h('div', { class: 'tools-row' });
  HM.toolNotes = h('div', { class: 'tools-notes' });
  HM.recentList = h('ul');
  HM.recent = h('section', { class: 'recent', 'aria-labelledby': 'recent-h', hidden: true }, h('h3', { id: 'recent-h' }, 'Recent on the board'), HM.recentList);
  HM.idle = h('div', { class: 'home-idle' }, HM.cards, HM.tools, HM.toolNotes, HM.recent);
  HM.idleSig = '';
  HM.inner = h('div', { class: 'landing-inner' }, HM.hero, HM.thread, dock, HM.idle);
  HM.root = h('div', { class: 'screen landing is-idle' }, HM.inner);
  $('#view').replaceChildren(HM.root);
  fitComposer();
  if (!S.roles && !S.rolesErr) loadRoles();
}
function leaveHome() { S.home.menu = null; HM.root = null; HM.turnEls = null; }
function fitComposer() {
  if (!HM.input) return;
  HM.input.style.setProperty('--cmp-h', 'auto');
  HM.input.style.setProperty('--cmp-h', Math.min(HM.input.scrollHeight, 220) + 'px');
}

function updateHome() {
  if (!HM.root || !S.state) return;
  const hm = S.home;
  const mode = effMode();
  const busy = homeBusy();
  const idle = hm.turns.length === 0;
  HM.root.className = 'screen landing ' + (idle ? 'is-idle' : 'has-thread');
  toggleHidden(HM.hero, !idle);
  toggleHidden(HM.thread, idle);
  toggleHidden(HM.idle, !idle);
  toggleHidden(HM.suggest, !idle);
  // pills, placeholder
  const detected = hm.mode === 'auto' && hm.text.trim() ? M.detectMode(hm.text) : '';
  HM.modes.set(hm.mode, [detected ? 'Auto · ' + M.MODE_META[detected].short : 'Auto']);
  HM.input.placeholder = PLACEHOLDER[hm.mode] || PLACEHOLDER.auto;
  // repo chip (the resolved repository is always visible before Send)
  const names = homeRepoNames();
  const res = homeRepo();
  const repoText = res.how === 'none' ? 'No repository'
    : res.how === 'chosen' ? res.name
      : res.name ? 'Auto · ' + res.name
        : mode === 'work' && names.length > 1 ? 'Choose repo' : 'No repository';
  setText(HM.repoLbl, repoText);
  HM.repoBtn.title = 'Repository: ' + repoText;
  // handled-by chip
  const row = modeRow(mode);
  const lead = roleLead(row.role);
  setText(HM.whoLbl, lead ? provLabel(lead) : 'Handled by');
  if (HM.whoIcon._id !== lead) { HM.whoIcon._id = lead; HM.whoIcon.replaceChildren(icon(lead ? AGENT_ICON[lead] || 'diamond' : 'sliders')); }
  HM.whoBtn.title = row.label + (lead ? ' · ' + provLabel(lead) : '') + ' (who does this job)';
  HM.whoBtn.setAttribute('aria-label', 'Handled by: ' + row.label + (lead ? ', ' + provLabel(lead) : ''));
  // send / stop: the name says what happens and where (Security U4)
  const canStop = hm.turns.some(stoppable);
  const sendName = canStop ? 'Stop' : busy ? 'Sending…'
    : mode === 'ask' ? (res.name ? 'Ask about ' + res.name : 'Ask (no repository)')
      : mode === 'research' ? (researchBriefOn() ? 'Write a research brief' : 'Research on the web')
        : designOn() ? (res.name ? 'Design the work in ' + res.name : 'Design the work')
          : res.name ? 'Send to the board (' + res.name + ')' : 'Send to the board';
  HM.send.setAttribute('aria-label', sendName);
  HM.send.title = sendName;
  HM.send.disabled = canStop ? false : busy || !hm.text.trim();
  HM.send.classList.toggle('is-stop', canStop);
  const sk = canStop ? 'stop' : 'up';
  if (HM.sendIcon._k !== sk) { HM.sendIcon._k = sk; HM.sendIcon.replaceChildren(icon(canStop ? 'stop' : 'arrow-up', canStop ? 'is-fill' : '')); }
  // disclosure, Ask-only fast-path option, inline error
  const showNote = hm.mode !== 'auto' || !!hm.text.trim();
  setText(HM.note, showNote ? DISCLOSE[mode] : '');
  toggleHidden(HM.note, !showNote);
  const allow = mode === 'ask' && !!res.name;
  const allowKey = mode + '|' + (res.name || '');
  if (HM.allowKey !== allowKey) { HM.allowKey = allowKey; hm.allowChange = false; }
  toggleHidden(HM.opt, !allow);
  if (allow) setText(HM.allowLbl, 'Let Conductor make the change in ' + res.name + ' if it is small');
  HM.allowBox.checked = allow && hm.allowChange;
  setText(HM.err, hm.err);
  toggleHidden(HM.err, !hm.err);
  // examples
  const sugModes = hm.mode === 'auto' ? ['ask', 'work', 'research'] : [hm.mode];
  const sug = hm.mode === 'auto' ? sugModes.map((m) => SUGGEST[m][0]) : SUGGEST[hm.mode];
  if (sug.join('|') !== HM.suggestSig) {
    HM.suggestSig = sug.join('|');
    HM.suggest.replaceChildren(...sug.map((t) => h('button', { type: 'button', onclick: () => { S.home.text = t; HM.input.value = t; fitComposer(); updateHome(); HM.input.focus(); } }, t)));
  }
  HM.clear.disabled = busy;
  HM.clear.title = busy ? 'Stop it first' : 'Clear the conversation';
  renderThread();
  if (idle) renderHomeIdle();
  if (hm.menu === 'repo' && !HM.repoMenu) openRepoMenu();
  if (hm.menu === 'who' && !HM.whoMenu) openWhoMenu();
}

function renderHomeIdle() {
  const st = S.state;
  const lw = (role) => provLabel(roleLead(role));
  const who = {
    ask: roleLead('context') ? 'Answered by ' + lw('context') : '',
    work: roleLead('planning') && roleLead('implementation') ? 'Planned by ' + lw('planning') + ' · built by ' + lw('implementation') : '',
    research: roleLead('research') ? 'Researched by ' + lw('research') : '',
  };
  const recent = st.runs.filter((r) => r.column !== 'closed').slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  const sig = JSON.stringify([S.home.mode, who, providersSig(st.providers), (st.providers || []).map((p) => [p.version, p.hint, p.detail]), S.roles && S.roles.roles,
    recent.map((r) => [r.key, r.title, r.column, r.status])]);
  if (sig === HM.idleSig) return;
  HM.idleSig = sig;
  for (const c of MODE_CARDS) { setText(HM.cardWho[c.id], who[c.id]); toggleHidden(HM.cardWho[c.id], !who[c.id]); }
  for (const b of HM.cards.children) b.classList.toggle('is-on', b.dataset.mode === S.home.mode);
  const ps = st.providers || [];
  HM.tools.replaceChildren(...(ps.length ? [h('span', null, 'Your tools')] : []), ...ps.map((p) => {
    const tone = TOOL_STATE[p.state] || TOOL_STATE.unknown;
    const jobs = S.roles ? M.toolJobs(S.roles.roles, p.id) : '';
    const detail = [p.version ? 'v' + String(p.version).replace(/^v/, '') : '', p.state === 'ok' ? jobs : p.hint || p.detail || ''].filter(Boolean).join(' · ');
    return h('span', { class: 'tool-chip', title: detail || null }, icon(AGENT_ICON[p.id] || 'diamond'), p.label || p.id, badge(tone[0], tone[1]));
  }));
  const bad = ps.filter((p) => p.state !== 'ok' && p.inUse && (p.hint || p.detail)); // an unused tool's hint stays in its tooltip
  HM.toolNotes.replaceChildren(...bad.map((p) => h('p', null, h('b', null, (p.label || p.id) + ': '), p.hint || p.detail)));
  toggleHidden(HM.toolNotes, !bad.length);
  HM.recentList.replaceChildren(...recent.map((r) => h('li', null, h('button', { type: 'button', class: 'recent-row', data: { act: 'open', key: r.key } },
    h('span', { class: 'card-key' }, r.key), h('span', { class: 't' }, r.title),
    h('span', { class: 'st ' + statusClass(r) }, icon(statusIcon(r)), (COL_BY_ID[r.column] || { label: runLabel(r) }).label)))));
  toggleHidden(HM.recent, !recent.length);
}

/* menus: repository, and the "Handled by" popover */
function toggleHomeMenu(which) {
  const open = S.home.menu === which;
  closeHomeMenus(false);
  if (!open) { S.home.menu = which; if (which === 'repo') openRepoMenu(); else openWhoMenu(); }
}
function closeHomeMenus(focusTrigger) {
  const was = S.home.menu;
  S.home.menu = null;
  for (const k of ['repoMenu', 'whoMenu']) { if (HM[k]) { HM[k].remove(); HM[k] = null; } }
  if (HM.repoBtn) HM.repoBtn.setAttribute('aria-expanded', 'false');
  if (HM.whoBtn) HM.whoBtn.setAttribute('aria-expanded', 'false');
  if (focusTrigger && was && HM.root) (was === 'repo' ? HM.repoBtn : HM.whoBtn).focus();
}
function openRepoMenu() {
  const mode = effMode();
  const names = homeRepoNames();
  const opts = [{ v: '', label: 'Auto (best match)' }].concat(names.map((n) => ({ v: n, label: n })));
  if (noneAllowed(mode)) opts.push({ v: M.NONE, label: 'No repository' });
  const cur = (S.home.repo === M.NONE && noneAllowed(mode)) || names.includes(S.home.repo) ? S.home.repo : '';
  const close = (f) => closeHomeMenus(f);
  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': 'Repository' }, opts.map((o) => h('button', {
    type: 'button', role: 'menuitemradio', class: 'menu-item' + (o.v === cur ? ' is-on' : ''), 'aria-checked': o.v === cur ? 'true' : 'false', tabindex: '-1',
    onclick: () => { S.home.repo = o.v; S.home.err = ''; close(false); updateHome(); HM.input.focus(); },
  }, icon('tick'), h('span', null, o.label))));
  menuKeys(menu, close);
  HM.repoMenu = h('div', null, h('div', { class: 'menu-scrim', onclick: () => close(false) }), menu);
  HM.repoWrap.appendChild(HM.repoMenu);
  HM.repoBtn.setAttribute('aria-expanded', 'true');
  const on = menu.querySelector('[aria-checked="true"]') || menu.querySelector('[role="menuitemradio"]');
  if (on) on.focus();
}
/** The popover edits a GLOBAL setting: the pill choice is only a draft until the explicit Apply button (Security U2). */
function openWhoMenu() {
  const row = modeRow(effMode());
  const pop = h('div', { class: 'menu menu-who', role: 'dialog', tabindex: '-1', 'aria-label': 'Handled by ' + row.label });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHomeMenus(true); } });
  HM.whoMenu = h('div', null, h('div', { class: 'menu-scrim', onclick: () => closeHomeMenus(false) }), pop);
  HM.whoWrap.appendChild(HM.whoMenu);
  HM.whoBtn.setAttribute('aria-expanded', 'true');
  fillWhoMenu(pop, row);
}
function fillWhoMenu(pop, row) {
  const title = h('div', { class: 'menu-title' }, 'Handled by ', h('b', null, row.label));
  const scope = h('p', { class: 'menu-text' }, h('b', null, 'This is a global setting.'), ' It changes who does this job for every request and every card, not just this one.');
  const link = h('button', { type: 'button', class: 'menu-link', onclick: () => { closeHomeMenus(false); openSettings(); } }, 'All roles in Settings');
  if (!S.roles) {
    const msg = S.rolesErr ? "Couldn't load who does what: " + S.rolesErr.message : 'Loading…';
    pop.replaceChildren(title, scope, h('p', { class: S.rolesErr ? 'err' : 'menu-text', role: 'status' }, msg),
      S.rolesErr ? h('button', { type: 'button', class: 'btn btn-sm', onclick: async () => { S.rolesErr = null; await loadRoles(); if (HM.whoMenu) fillWhoMenu(pop, row); } }, 'Try again') : null, link);
    if (!S.rolesErr) loadRoles().then(() => { if (HM.whoMenu && pop.isConnected) fillWhoMenu(pop, row); });
    pop.focus();
    return;
  }
  const lead = M.leadOf(S.roles.roles, row.role);
  const choices = S.roles.choices[row.role] || {};
  let draft = lead;
  const status = h('p', { class: 'menu-text', role: 'status' });
  const out = h('p', { class: 'warn-note menu-out', role: 'status', hidden: true });
  const apply = h('button', { type: 'button', class: 'btn btn-primary btn-sm' });
  const items = Object.keys(choices).map((id) => ({ id, label: provLabel(id), locked: !choices[id].ok, reason: choices[id].reason || '', title: choices[id].ok ? (choices[id].needsAck ? 'Isolation not verified on this machine' : null) : choices[id].reason || 'Not available for this job' }));
  // M8-2: the job's model and effort, in the chosen tool's own words (Deep Research: always Claude today)
  const ed = modelEditor({ row, tool: row.id === 'research' ? 'claude' : lead, entry: S.roles.roles[row.role], view: (S.roles.roleViews || {})[row.role], onChange: () => sync() });
  const sync = () => {
    pills.set(draft);
    const toolChange = !!draft && draft !== lead;
    const selChange = !!ed.value();
    setText(apply, toolChange ? 'Use ' + provLabel(draft) + ' for every ' + row.label + ' job' : selChange ? 'Save for every ' + row.label + ' job' : 'No change');
    apply.disabled = !draft || (!toolChange && !selChange) || apply.classList.contains('is-busy');
  };
  const pills = pillGroup({ label: 'Tool for ' + row.label, items, value: draft,
    onPick: (id) => { draft = id; setText(status, ''); if (row.id !== 'research') ed.setTool(id); sync(); },
    onLocked: (it) => setText(status, it.label + ': ' + it.reason) });
  apply.addEventListener('click', async () => {
    const sel = ed.value();
    if (!draft || (draft === lead && !sel)) return;
    apply.classList.add('is-busy'); apply.disabled = true;
    for (const b of pills.btns) b.disabled = true;
    const r = await applyRoleChanges(draft !== lead ? { [row.id]: draft } : {}, sel ? { [row.id]: sel } : {});
    if (!HM.whoMenu || !pop.isConnected) return;
    if (r.ok) {
      const notes = r.notices || [];
      if (notes.length) { fillWhoMenu(pop, row); const o2 = pop.querySelector('.menu-out'); if (o2) { o2.replaceChildren(...notes.map((n) => h('span', null, n))); o2.hidden = false; } }
      else { closeHomeMenus(true); toast('good', draft !== lead ? row.label + ' now runs on ' + provLabel(draft) + '.' : row.label + ': model settings saved.'); }
      updateHome();
      return;
    }
    apply.classList.remove('is-busy');
    for (const b of pills.btns) b.disabled = false;
    draft = M.leadOf(S.roles.roles, row.role);
    if (r.error) { out.textContent = r.error; out.hidden = false; }
    const fr = fieldRow(r.field);
    if (fr && fr.row === row.id) ed.focus(fr.key);
    sync();
  });
  const notes = [];
  if (row.id === 'research') notes.push("Deep Research always runs on Claude's web-only research profile today, so this job cannot be moved to another tool yet.");
  const abc = S.roles.roles[row.role] && S.roles.roles[row.role].autoByComplexity;
  if (abc && Object.keys(abc).length) notes.push('Some plan sizes use a different tool first (set in the config file).');
  pop.replaceChildren(title, scope, pills.el, ed.el, status, ...notes.map((n) => h('p', { class: 'menu-text muted' }, n)), out,
    h('div', { class: 'turn-actions' }, apply, link));
  sync();
  const f = pills.btns.find((b) => b.getAttribute('aria-checked') === 'true') || pills.btns[0];
  if (f) f.focus();
}

/* the thread */
function pushTurn(t) {
  S.home.turns.push(t);
  while (S.home.turns.length > MAX_TURNS) {
    const i = S.home.turns.findIndex((x) => x.phase !== 'sending' && x.phase !== 'running');
    if (i < 0) break;
    clearTimeout(S.home.turns[i].timer);
    S.home.turns.splice(i, 1);
  }
}
function clearThread() {
  if (homeBusy()) return;
  for (const t of S.home.turns) clearTimeout(t.timer);
  S.home.turns = [];
  updateHome();
  if (HM.input) HM.input.focus();
}
/** Sign-out / expired session: nothing of the conversation stays on the page (Security U5). */
function dropHome() {
  for (const t of S.home.turns) { clearTimeout(t.timer); t.timer = 0; }
  S.home = { text: '', mode: 'auto', repo: '', allowChange: false, menu: null, turns: [], err: '', who: null };
  HM.root = null; HM.turnEls = null;
}
const askPhase = (r) => (r.status === 'running' || r.status === 'paused' ? 'running' : r.status === 'done' ? 'done' : r.status === 'canceled' ? 'canceled' : 'failed');

async function homeSubmit() {
  const hm = S.home;
  const text = HM.input ? HM.input.value.trim() : hm.text.trim();
  if (!text || homeBusy()) { if (HM.input) HM.input.focus(); return; }
  const mode = effMode();
  const names = homeRepoNames();
  const res = homeRepo();
  hm.err = '';
  if (mode === 'work') {
    if (!names.length) { hm.err = 'Add a repository first (Settings, then Repositories and setup).'; updateHome(); return; }
    if (!res.name) { hm.err = 'Choose which repository this task belongs to.'; updateHome(); toggleHomeMenu('repo'); return; }
  }
  const t = { id: uid('turn'), mode, text, repo: res.name, phase: 'sending', askId: null, rec: null, error: '', created: null, timer: 0, allowChange: mode === 'ask' && !!res.name && hm.allowChange,
    briefId: null, brief: null, unticked: new Set(), depth: 'standard', sendBusy: false, sendErr: '' };
  pushTurn(t);
  hm.allowChange = false;
  closeHomeMenus(false);
  updateHome();
  scrollToTurn(t);
  try {
    if ((mode === 'work' && designOn()) || (mode === 'research' && researchBriefOn())) {
      // M8-6: one line → a brief (and parts). Nothing reaches the board until the user presses Send.
      const body = { kind: mode === 'work' ? 'work' : 'research', line: text };
      if (t.repo) body.repo = t.repo;
      const b = await api('POST', '/api/briefs', body);
      t.briefId = b.id; t.brief = b; t.phase = briefPhase(b);
      if (t.phase === 'briefing') pollBrief(t);
    } else if (mode === 'work') {
      const body = M.taskFromText(text);
      if (t.repo) body.repo = t.repo;
      const r = await api('POST', '/api/tasks', body);
      t.phase = 'sent'; t.created = { key: r.key };
      loadState().catch(() => {});
    } else {
      const body = { question: text };
      if (mode === 'research') body.mode = 'research';
      if (t.repo) body.repo = t.repo;
      if (t.allowChange) body.allowChange = true;
      const r = await api('POST', '/api/ask', body);
      t.askId = r.id; t.rec = r; t.phase = askPhase(r);
      if (t.phase === 'running') pollTurn(t);
    }
    if (t.repo) storeSet('home:lastRepo', t.repo);
    hm.text = '';
    if (HM.input) { HM.input.value = ''; fitComposer(); }
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401) return;
    t.phase = 'error'; t.error = errText(e);
  }
  updateHome();
}
/** A server refusal as text; `limited` adds "Try again at HH:MM" from `retryAt`. */
function errText(e) {
  const at = e && e.info && typeof e.info.retryAt === 'number' && e.info.retryAt > 0 ? new Date(e.info.retryAt) : null;
  return (e && e.message ? e.message : 'Something went wrong.') + (e && e.code === 'limited' && at ? ' Try again at ' + at.toTimeString().slice(0, 5) + '.' : '');
}
function pollTurn(t, delay) {
  clearTimeout(t.timer);
  t.timer = setTimeout(async () => {
    t.timer = 0;
    if (!S.home.turns.includes(t) || S.expired) return;
    try {
      const r = await api('GET', '/api/asks/' + enc(t.askId));
      t.rec = r; t.phase = askPhase(r);
      if (t.phase === 'running') pollTurn(t);
    } catch (e) {
      if (e instanceof ApiFail && e.status === 401) return;
      if (e instanceof ApiFail && e.status === 404) { t.phase = 'error'; t.error = e.message; }
      else pollTurn(t, 5000); // the server is unreachable for a moment: keep watching the same question (never re-asks)
    }
    updateHome();
  }, delay || ASK_POLL_MS);
}
async function stopRunningTurn() {
  const t = S.home.turns.find(stoppable);
  if (!t) return;
  if (t.phase === 'briefing') {
    try { t.brief = await api('POST', '/api/briefs/' + enc(t.briefId) + '/cancel'); t.phase = briefPhase(t.brief); if (t.phase !== 'briefing') clearTimeout(t.timer); } catch (e) { if (!(e instanceof ApiFail && e.status === 401)) toast('error', e.message); }
    updateHome();
    return;
  }
  try {
    const r = await api('POST', '/api/asks/' + enc(t.askId) + '/cancel');
    t.rec = r; t.phase = askPhase(r);
    if (t.phase === 'running') pollTurn(t); else clearTimeout(t.timer);
  } catch (e) { if (!(e instanceof ApiFail && e.status === 401)) toast('error', e.message); }
  updateHome();
}
async function convertTurn(t) {
  if (t.busy || !t.askId) return;
  t.busy = true; updateHome();
  try {
    const c = await api('POST', '/api/asks/' + enc(t.askId) + '/convert');
    toast('good', 'Created ' + c.key + ' — its plan always waits for your approval.');
    loadState().catch(() => {});
    t.rec = await api('GET', '/api/asks/' + enc(t.askId));
  } catch (e) { if (!(e instanceof ApiFail && e.status === 401)) { t.convertErr = e.message; } }
  t.busy = false;
  updateHome();
}

function scrollToTurn(t) {
  const rec = HM.turnEls && HM.turnEls.get(t.id);
  if (rec) rec.el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}
function renderThread() {
  if (!HM.turnEls) return;
  const els = S.home.turns.map((t) => {
    const sig = JSON.stringify([t.phase, t.error, t.created, t.busy, t.convertErr, t.rec && [t.rec.status, t.rec.basis, t.rec.provider, t.rec.updatedAt, t.rec.convertedTo, t.rec.error], t.phase === 'running' ? null : roleLead(modeRow(t.mode).role),
      t.brief && [t.brief.status, t.brief.updatedAt], t.unticked ? [...t.unticked].join() : '', t.depth, t.sendBusy, t.sendErr, briefLimitsSig()]);
    let rec = HM.turnEls.get(t.id);
    if (!rec) { rec = { el: h('article', { class: 'turn', data: { turn: t.id } }), sig: '' }; HM.turnEls.set(t.id, rec); }
    if (rec.sig !== sig) {
      rec.sig = sig;
      const act = document.activeElement;
      const fid = act && rec.el.contains(act) ? act.getAttribute('data-fid') : null;
      rec.el.replaceChildren(...turnNodes(t));
      if (fid) { const f = rec.el.querySelector('[data-fid="' + CSS.escape(fid) + '"]'); if (f) f.focus({ preventScroll: true }); }
    }
    return rec.el;
  });
  const live = new Set(S.home.turns.map((t) => t.id));
  for (const id of Array.from(HM.turnEls.keys())) if (!live.has(id)) HM.turnEls.delete(id);
  reconcile(HM.turnList, els);
}
function stepNodes(steps) {
  return h('ol', { class: 'tsteps' }, steps.map((s) => h('li', { class: 'tstep is-' + s.state },
    h('span', { class: 'tstep-ic' }, s.state === 'running' ? h('span', { class: 'spin' }) : s.state === 'done' ? icon('tick') : s.state === 'stopped' ? icon('x') : h('span', { class: 'tstep-dot' })),
    h('span', { class: 'tstep-body' }, h('span', { class: 'tstep-t' }, s.label), s.detail ? h('span', { class: 'tstep-d' }, s.detail) : null))));
}
/** Steps come from the record's real fields only (status, basis, provider): nothing advances on a timer. */
function turnSteps(t) {
  const r = t.rec;
  if (t.brief) {
    // M8-6: the brief's steps come from the record (the design's STEPS wording); research then adds the web run's own step
    const steps = t.brief.steps.map((s) => ({ label: s.label, detail: s.detail, state: s.state === 'failed' ? 'stopped' : s.state }));
    if (t.mode === 'research' && t.askId) {
      const done = t.phase === 'done';
      const ended = t.phase === 'failed' || t.phase === 'canceled' || t.phase === 'error';
      steps.push({ label: done ? 'Report written by ' + provLabel((r && r.provider) || 'claude') : 'Researching on the web (' + (t.brief.sent && t.brief.sent.depth === 'deep' ? 'Deep' : 'Standard') + '). This can take a few minutes.', state: done ? 'done' : ended ? 'stopped' : 'running' });
    }
    return steps;
  }
  const ended = t.phase === 'failed' || t.phase === 'canceled' || t.phase === 'error';
  if (t.mode === 'work') {
    return [{ label: t.phase === 'sent' ? 'Sent to the board as ' + t.created.key : 'Creating the task', state: t.phase === 'sent' ? 'done' : ended ? 'stopped' : 'running' }];
  }
  if (t.phase === 'error') return [{ label: 'Not sent', state: 'stopped' }];
  if (t.mode === 'research') {
    const done = t.phase === 'done';
    return [{ label: done ? 'Report written by ' + provLabel(r.provider || 'claude') : 'Researching on the web. This can take a few minutes.', state: done ? 'done' : ended ? 'stopped' : 'running' }];
  }
  const repo = (r && r.repo) || t.repo;
  const read = !!(r && r.basis);
  return [
    { label: repo ? 'Reading a read-only copy of ' + repo : 'No repository: a general answer', detail: read ? r.basis : '', state: read ? 'done' : ended ? 'stopped' : 'running' },
    { label: t.phase === 'done' ? 'Answered by ' + provLabel(r.provider) : 'Writing the answer', state: t.phase === 'done' ? 'done' : ended ? 'stopped' : read ? 'running' : 'pending' },
  ];
}
function turnNodes(t) {
  const meta = M.MODE_META[t.mode];
  const row = modeRow(t.mode);
  const r = t.rec;
  const by = r && r.provider ? r.provider : t.brief && t.brief.handledBy ? t.brief.handledBy.provider : roleLead(row.role);
  const out = [];
  if (t.brief) out.push(...briefNodes(t));
  if (t.phase === 'error') out.push(h('div', { class: 'callout c-bad' }, icon('warn'), h('div', { class: 'callout-body' }, h('b', null, 'Not sent'), h('div', { class: 'pre' }, t.error))));
  if (t.phase === 'failed' && !(t.brief && !t.askId)) out.push(h('div', { class: 'callout c-bad' }, icon('warn'), h('div', { class: 'callout-body' }, h('b', null, t.mode === 'research' ? 'No report' : 'No answer'), h('div', { class: 'pre' }, (r && r.error) || 'Something went wrong.'))));
  if (t.phase === 'canceled') out.push(h('p', { class: 'muted' }, 'Stopped.'));
  if (t.phase === 'sent' && !t.brief) {
    out.push(h('div', { class: 'sent' }, icon('check'), h('span', { class: 'sent-t' }, 'Sent to the board'),
      h('span', { class: 'keys' }, h('span', { class: 'chip' }, t.created.key)),
      h('button', { type: 'button', class: 'btn btn-sm', data: { fid: 'view' }, onclick: () => navigate('#/board') }, 'View on board')));
  }
  if (t.phase === 'done' && r && r.result && t.mode === 'ask') {
    const res = r.result;
    const doc = h('div', { class: 'doc' });
    if (res.answer) doc.appendChild(h('div', { class: 'doc-sec is-bare' }, renderMarkdown(res.answer)));
    if (res.kind === 'change' && res.change) doc.appendChild(h('div', { class: 'doc-sec' }, h('p', { class: 'muted' }, 'This looks like a request for a change: ' + res.change.title + ' (size ' + res.change.complexity + '). Nothing was changed.')));
    out.push(doc);
    if ((res.citations || []).length) out.push(h('p', { class: 'cites' }, 'Sources: ', ...res.citations.flatMap((c, i) => [i ? ', ' : '', h('code', null, c.file + (c.lines ? ':' + c.lines : ''))])));
    out.push(h('p', { class: 'cites' }, 'Based on ' + (r.basis || 'the repository') + '. The answer is model-written — check it before relying on it.' + (r.tierNote ? ' ' + r.tierNote : '')));
    out.push(...convertNodes(t, 'Turn into a task', 'Started as task ', 'Nothing was added to the board. Turning it into a task always waits for your approval.', 'Choose a repository before asking if you want to turn this into a task.'));
  }
  if (t.phase === 'done' && r && r.report && t.mode === 'research') {
    out.push(h('div', { class: 'doc' }, h('div', { class: 'doc-sec is-bare' }, renderReport(r.report)),
      h('div', { class: 'doc-sec' }, h('p', { class: 'muted' }, 'Written by a model from web sources — sources marked Opened were really fetched in this session; Listed only appeared in search results; Unverified could not be confirmed.'))));
    out.push(...convertNodes(t, 'Turn into an engineering plan', 'Turned into task ', '', 'Choose a repository before asking if you want to turn the findings into an engineering plan.', true));
  }
  return [
    h('div', { class: 'msg-user' }, h('div', { class: 'bubble' }, t.text)),
    h('div', { class: 'msg-ai' },
      h('div', { class: 'ai-head' },
        h('span', { class: 'ai-mark' }, icon('baton')), h('span', { class: 'ai-name' }, 'Conductor'),
        h('span', { class: 'ai-tag' }, icon(meta.icon, 'icon-sm'), meta.label),
        by ? h('span', { class: 'ai-who', title: row.label + ' · ' + provLabel(by) }, provLabel(by)) : null),
      stepNodes(turnSteps(t)), out),
  ];
}
function convertNodes(t, label, doneText, hint, noRepo, primary) {
  const r = t.rec;
  if (r.convertedTo) return [h('p', null, doneText, h('b', null, r.convertedTo), '. ', h('button', { type: 'button', class: 'link-btn', data: { fid: 'view' }, onclick: () => navigate('#/board') }, 'View on board'))];
  if (!r.repo) return [h('p', { class: 'muted' }, noRepo)];
  return [h('div', { class: 'turn-actions' },
    h('button', { type: 'button', class: 'btn' + (primary ? ' btn-primary' : '') + (t.busy ? ' is-busy' : ''), disabled: !!t.busy, data: { fid: 'convert' }, onclick: () => convertTurn(t) }, icon('plus'), h('span', null, label)),
    hint ? h('span', { class: 'muted' }, hint) : null),
  t.convertErr ? h('p', { class: 'err', role: 'alert' }, t.convertErr) : null].filter(Boolean);
}

/* ───────── M8-6: "Design the work" and research briefs (DOM only; every model string is a text node, code spans via textContent) ───────── */
const BRIEF_POLL_MS = 1000;
const MODEL_LABEL = 'Written by a model — check it';
const WORK_APPROVAL_HINT = "Each task starts by itself and its plan waits for your approval (written from a model's brief).";
const FILE_STATE = { file: 'in the repo', omitted: 'in the repo, not in the snapshot', absent: 'new' };
/** Brief status → turn phase. A research brief that was sent continues as its ask (pollTurn). */
function briefPhase(b) {
  if (b.status === 'running') return 'briefing';
  if (b.status === 'ready' || b.status === 'sending' || b.status === 'send_failed') return 'review';
  if (b.status === 'sent') return 'sent';
  return b.status === 'canceled' ? 'canceled' : 'failed';
}
function pollBrief(t, delay) {
  clearTimeout(t.timer);
  t.timer = setTimeout(async () => {
    t.timer = 0;
    if (!S.home.turns.includes(t) || S.expired) return;
    try {
      t.brief = await api('GET', '/api/briefs/' + enc(t.briefId));
      t.phase = briefPhase(t.brief);
      if (t.phase === 'briefing') pollBrief(t);
    } catch (e) {
      if (e instanceof ApiFail && e.status === 401) return;
      if (e instanceof ApiFail && e.status === 404) { t.phase = 'error'; t.error = e.message; }
      else pollBrief(t, 5000); // a moment without the server: keep watching the same brief (never re-sends)
    }
    updateHome();
  }, delay || BRIEF_POLL_MS);
}
const briefLimits = () => (S.state && S.state.home && S.state.home.limits) || null;
const briefLimitsSig = () => { const l = briefLimits(); return l ? [l.researchUsed, l.researchPerDay].join('/') : ''; };
/** Plain text with `backtick` spans as <code> elements (textContent) — no links, no images, no markup. */
function codeText(text) {
  const parts = String(text == null ? '' : text).split(/`([^`\n]{1,300})`/);
  return parts.map((p, i) => (i % 2 ? h('code', null, p) : p)).filter((x) => x !== '');
}
function briefSec(title, ...kids) { return h('section', { class: 'sec' }, title ? h('h4', null, title) : null, ...kids); }
function briefList(items, cls) { return h('ul', { class: 'sec-list' + (cls ? ' ' + cls : '') }, items.map((x) => h('li', null, cls === 'is-checks' ? h('span', { class: 'cbox' }) : null, h('span', null, ...codeText(x))))); }
const selectedParts = (t) => ((t.brief.work && t.brief.work.parts) || []).filter((p) => !t.unticked.has(p.id)).map((p) => p.id);

function briefNodes(t) {
  const b = t.brief;
  const out = [];
  const w = b.work;
  const rs = b.research;
  if (b.status === 'failed' && !t.askId) {
    const at = b.errorKind === 'limited' && b.retryAt ? ' Try again at ' + new Date(b.retryAt).toTimeString().slice(0, 5) + '.' : '';
    out.push(h('div', { class: 'callout c-bad' }, icon('warn'), h('div', { class: 'callout-body' }, h('b', null, 'No brief'), h('div', { class: 'pre' }, (b.error || 'Something went wrong.') + at))));
  }
  if (w && b.scan) {
    out.push(h('div', { class: 'scan' },
      h('div', { class: 'scan-line' }, icon('folder', 'icon-sm'), h('span', null, b.scan.repo + ' · ' + b.scan.branch + ' @ ' + b.scan.sha + ' · ' + b.scan.snapshotFiles + ' files in the snapshot')),
      h('ul', { class: 'scan-files' }, w.files.map((f) => h('li', null, h('span', { class: 'file-chip' }, f.path), h('span', null, f.why + ' · ' + (FILE_STATE[f.state] || 'new')),
        f.protected ? badge('warn', 'Protected file') : null, f.secretLike ? badge('warn', 'Looks like a secret file') : null))),
      b.scan.note ? h('p', { class: 'scan-note' }, b.scan.note) : null,
      h('p', { class: 'scan-note' }, 'The marks say whether a path is in the committed snapshot. They do not prove the brief’s reasoning is right.')));
  }
  if (w || rs) {
    const doc = h('div', { class: 'doc' }, h('div', { class: 'doc-head' }, h('span', null, w ? 'Detailed brief' : 'Research brief'), b.repo ? h('span', { class: 'chip' }, b.repo) : null, badge('warn', MODEL_LABEL)));
    if (w) {
      doc.append(briefSec('', h('p', null, h('b', null, w.title))), briefSec('Goal', h('p', null, ...codeText(w.summary))), briefSec('What changes', h('p', { class: 'is-pre' }, ...codeText(w.approach))));
      if (w.acceptance.length) doc.append(briefSec('Acceptance criteria', briefList(w.acceptance, 'is-checks')));
      if (w.risks.length) doc.append(briefSec('Risks', briefList(w.risks)));
    } else {
      doc.append(briefSec('', h('p', null, h('b', null, rs.title))), briefSec('Objective', h('p', { class: 'is-pre' }, rs.objective)),
        briefSec('Key questions', h('ol', { class: 'sec-list is-ol' }, rs.questions.map((q) => h('li', null, h('span', null, q))))),
        briefSec('Scope', briefList(rs.scope.in.map((x) => 'In: ' + x).concat(rs.scope.out.map((x) => 'Out: ' + x), rs.scope.timeWindow ? ['Time window: ' + rs.scope.timeWindow] : []))),
        briefSec('Source types', h('p', null, rs.sourceTypes.join(', ') || 'Any')),
        briefSec('Deliverable', h('p', { class: 'is-pre' }, rs.deliverable)),
        briefSec('', h('p', { class: 'muted' }, 'Written by Claude from your question only — it had no access to your repository. Research uses the web only.')));
    }
    out.push(doc);
  }
  if (w && w.parts.length) {
    const review = t.phase === 'review' && b.status === 'ready' && !t.sendBusy;
    out.push(h('div', { class: 'parts-wrap' },
      h('div', { class: 'parts-head' }, h('b', null, w.parts.length === 1 ? 'One task' : w.parts.length + ' tasks, in order'), review ? h('span', { class: 'muted' }, 'Untick anything you do not want sent.') : null),
      h('ul', { class: 'parts' }, w.parts.map((p, i) => {
        const on = !t.unticked.has(p.id);
        return h('li', { class: 'part' + (on ? '' : ' is-off') },
          h('label', { class: 'part-check' }, h('input', { type: 'checkbox', checked: on, disabled: !review, 'aria-label': 'Include part ' + (i + 1), data: { fid: 'part-' + p.id }, onchange: (e) => { if (e.target.checked) t.unticked.delete(p.id); else t.unticked.add(p.id); updateHome(); } })),
          h('div', { class: 'part-main' }, h('div', { class: 'part-t' }, p.title), h('div', { class: 'part-s' }, p.summary),
            h('div', { class: 'part-m' }, ...p.files.map((f) => h('span', { class: 'file-chip' }, f)), p.deps.length ? h('span', { class: 'part-dep' }, 'After ' + p.deps.map((d) => 'part ' + d.slice(1)).join(', ')) : null)),
          h('span', { class: 'badge tone-mute' }, 'Size ' + p.size));
      }))));
    const flagged = w.files.filter((f) => f.protected || f.secretLike).map((f) => f.path);
    if (flagged.length) out.push(h('p', { class: 'warn-note', role: 'note' }, icon('warn', 'icon-sm'), h('span', null, 'This brief names protected or secret-looking files: ' + flagged.join(', ') + '. Plans that touch them always wait for your approval.')));
  }
  if (t.phase === 'review') out.push(...briefReview(t));
  if (t.phase === 'sent' && w && b.sent && b.sent.cards) {
    const n = b.sent.cards.filter((c) => !c.dependsOn.length).length;
    out.push(h('div', { class: 'sent' }, icon('check'), h('span', { class: 'sent-t' }, b.sent.cards.length === 1 ? 'Sent 1 task to the board' : 'Sent ' + b.sent.cards.length + ' tasks to the board'),
      h('span', { class: 'keys' }, ...b.sent.cards.map((c) => h('span', { class: 'chip' }, c.key))),
      h('button', { type: 'button', class: 'btn btn-sm', data: { fid: 'view' }, onclick: () => navigate('#/board') }, 'View on board')));
    out.push(h('p', { class: 'muted' }, (n === 1 ? '1 plan will be written now' : n + ' plans will be written now') + '; each one waits for your approval. A task that starts after another one needs that one merged into your base branch and moved to Done first.'));
  }
  return out;
}
function briefReview(t) {
  const b = t.brief;
  const out = [];
  if (b.status === 'send_failed' && b.sent) out.push(h('div', { class: 'callout c-bad' }, icon('warn'), h('div', { class: 'callout-body' }, h('b', null, 'Not every task was sent'), h('div', { class: 'pre' }, (b.sent.error || 'The board could not take every card.') + ' Sending again creates only the missing ones.'))));
  if (t.sendErr) out.push(h('p', { class: 'err', role: 'alert' }, t.sendErr));
  const acts = [];
  if (b.kind === 'work') {
    const chosen = b.status === 'send_failed' && b.sent && b.sent.parts ? b.sent.parts : selectedParts(t);
    acts.push(h('button', { type: 'button', class: 'btn btn-primary' + (t.sendBusy ? ' is-busy' : ''), disabled: t.sendBusy || !chosen.length || b.status === 'sending', data: { fid: 'send' }, onclick: () => sendBrief(t, { parts: chosen }) },
      icon('arrow-up'), h('span', null, b.status === 'send_failed' ? 'Send the missing tasks' : chosen.length === 1 ? 'Send 1 task to the board' : 'Send ' + chosen.length + ' tasks to the board')));
  } else {
    const lim = briefLimits();
    const deepOff = !!lim && lim.researchUsed + 2 > lim.researchPerDay;
    if (deepOff && t.depth === 'deep') t.depth = 'standard';
    out.push(h('div', { class: 'depth' }, h('span', { class: 'muted' }, 'Depth'),
      h('div', { class: 'pills', role: 'radiogroup', 'aria-label': 'Research depth' }, [['standard', 'Standard'], ['deep', 'Deep']].map(([id, label]) => h('button', {
        type: 'button', role: 'radio', class: 'pill' + (t.depth === id ? ' is-on' : ''), 'aria-checked': t.depth === id ? 'true' : 'false', data: { fid: 'depth-' + id },
        disabled: t.sendBusy || (id === 'deep' && deepOff), title: id === 'deep' && deepOff ? "Deep counts as 2 of today's research runs, and there are not enough left." : null,
        onclick: () => { t.depth = id; updateHome(); },
      }, label))),
      h('span', { class: 'muted' }, t.depth === 'deep' ? "Reads more sources and takes longer (up to 35 minutes). Counts as 2 of today's research runs." : 'A focused pass over the main sources (up to 20 minutes).')));
    acts.push(h('button', { type: 'button', class: 'btn btn-primary' + (t.sendBusy ? ' is-busy' : ''), disabled: t.sendBusy || b.status === 'sending', data: { fid: 'send' }, onclick: () => sendBrief(t, { depth: t.depth }) }, icon('arrow-up'), h('span', null, 'Send as a research task')));
  }
  acts.push(h('button', { type: 'button', class: 'btn', disabled: t.sendBusy || b.status === 'sending' || b.status === 'send_failed', data: { fid: 'discard' }, onclick: () => discardBrief(t) }, 'Discard'));
  acts.push(h('span', { class: 'muted' }, b.kind === 'work' ? WORK_APPROVAL_HINT : 'It starts now (never queued) and the report shows up here. Its findings become work only if you turn them into a plan.'));
  out.push(h('div', { class: 'review' }, h('div', { class: 'actions' }, acts)));
  return out;
}
async function sendBrief(t, body) {
  if (t.sendBusy) return;
  t.sendBusy = true; t.sendErr = ''; updateHome();
  try {
    const r = await api('POST', '/api/briefs/' + enc(t.briefId) + '/send', body);
    if (t.brief.kind === 'research') {
      t.askId = r.askId;
      t.brief = await api('GET', '/api/briefs/' + enc(t.briefId));
      t.rec = await api('GET', '/api/asks/' + enc(r.askId));
      t.phase = askPhase(t.rec);
      if (t.phase === 'running') pollTurn(t);
    } else {
      t.brief = await api('GET', '/api/briefs/' + enc(t.briefId));
      t.phase = briefPhase(t.brief);
    }
    loadState().catch(() => {});
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401) return;
    t.sendErr = errText(e);
    try { t.brief = await api('GET', '/api/briefs/' + enc(t.briefId)); t.phase = briefPhase(t.brief); } catch { /* keep the last known brief */ }
  }
  t.sendBusy = false;
  updateHome();
}
async function discardBrief(t) {
  try { await api('DELETE', '/api/briefs/' + enc(t.briefId)); } catch (e) { if (e instanceof ApiFail && e.status === 401) return; if (!(e instanceof ApiFail && e.status === 404)) { t.sendErr = e.message; updateHome(); return; } }
  clearTimeout(t.timer);
  S.home.turns = S.home.turns.filter((x) => x !== t);
  updateHome();
}

/* ───────────────────────── board view ───────────────────────── */
const B = { idle: new Map(), summary: null, items: null, polled: null, board: null, cols: new Map(), cards: new Map(), history: null, histList: null, histCount: null, histSig: '', empty: null, pollEl: null, order: '', itemsSig: '',
  // M8-U2: GET /api/board (read-only) adds the research projection and the design-card origin; research cards are keyed by ask id
  extra: null, rcards: new Map(), xGen: 0, xTimer: 0, xDue: 0, xBusy: false, xLast: 0 };

function buildBoardView() {
  B.cols = new Map(); B.cards = new Map(); B.idle = new Map(); B.rcards = new Map(); B.histSig = ''; B.order = ''; B.itemsSig = '';
  B.extra = null; B.xGen++; B.xBusy = false; clearTimeout(B.xTimer); B.xTimer = 0;
  boardPoke(true);
  B.items = h('div', { class: 'summary-items' });
  B.polled = h('span', { class: 'sum-quiet' });
  B.summary = h('div', { class: 'summary' }, h('h1', null, 'Board'), B.items, h('span', { class: 'summary-spacer' }), B.polled);
  B.board = h('div', { class: 'board', role: 'group', 'aria-label': 'Runs by stage', tabindex: '0' });
  for (const c of COLUMNS) {
    const headId = uid('colh');
    const count = h('span', { class: 'col-count' }, '0');
    const title = h('h2', { id: headId, tabindex: '-1' }, c.label);
    const list = h('ul', { class: 'col-list', 'aria-labelledby': headId });
    const empty = h('p', { class: 'col-empty' }, 'Nothing here');
    const el = h('section', { class: 'col is-empty', id: 'col-' + c.id, 'aria-labelledby': headId },
      h('div', { class: 'col-head st-' + c.id }, icon(c.icon), title, count),
      h('p', { class: 'col-sub' }, c.hint), list, empty);
    B.cols.set(c.id, { el, list, count, empty, title, sub: el.querySelector('.col-sub') });
  }
  B.pollEl = h('span', { class: 'num' }, '5');
  B.empty = h('section', { class: 'empty', 'aria-labelledby': 'empty-h' },
    h('h2', { id: 'empty-h', class: 'empty-title' }, 'Nothing in flight'),
    h('p', null, 'Create a task and Conductor plans it, builds it and verifies it. Your cards live right here on the board.'),
    (B.flow = h('ol', { class: 'flow', 'aria-label': 'How a task moves' })),
    h('ol', { class: 'how' },
      h('li', null, 'Press ', h('b', null, 'New task'), ' and describe what you want.'),
      h('li', null, 'Conductor picks it up straight away: the card moves through the stages by itself.'),
      h('li', null, 'You only step in when a card says ', h('b', null, 'Needs you'), (B.howTail = h('span')), '.')),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-primary', data: { act: 'new-task' } }, icon('plus'), h('span', null, 'New task')),
      h('button', { type: 'button', class: 'btn', data: { act: 'open-setup' } }, icon('sliders'), h('span', null, 'Repositories and setup'))));
  B.histCount = h('span', { class: 'col-count' }, '0');
  B.histList = h('ul', { class: 'history-list' });
  B.history = h('details', { class: 'history' },
    h('summary', null, icon('archive'), h('span', null, 'History'), B.histCount, h('span', { class: 'card-spacer' }), icon('chevron', 'chev')),
    B.histList);
  B.wordSig = '';
  $('#view').replaceChildren(h('div', { class: 'screen' }, B.summary, B.empty, B.board, B.history));
}

/** Column hints and the empty-state steps name the tool assigned to each job (F5); without roles, today's static wording stays. */
function updateBoardWording() {
  const roles = S.roles ? S.roles.roles : null;
  const pa = S.state.settings.planApproval;
  const sig = JSON.stringify([roles, pa]);
  if (sig === B.wordSig) return;
  B.wordSig = sig;
  const hints = roles ? M.colHints(roles, provLabel) : {};
  for (const c of COLUMNS) { const col = B.cols.get(c.id); if (col && col.sub) setText(col.sub, hints[c.id] || c.hint); }
  const f = M.flowText(roles || {}, pa, provLabel);
  B.flow.replaceChildren(...f.steps.map((x) => h('li', null, h('b', null, x.t), h('span', null, x.d))));
  setText(B.howTail, f.howTail);
}

function reconcile(parent, els) {
  const want = new Set(els);
  for (const ch of Array.from(parent.children)) if (!want.has(ch)) ch.remove();
  els.forEach((el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
}

/* ───────── M8-U2: GET /api/board extras (research projection + design-card origin). Read-only; every string is a text node ───────── */
const BOARD_FAST_MS = 5000; // while a research card is running
const BOARD_SLOW_MS = 20000;
const BOARD_POKE_MS = 2000; // at most one refetch per 2 s after SSE state events
const MODEL_CARD_LABEL = 'Written by a model';
const MODEL_CARD_TIP = "Made from a model's brief. Untrusted: information, not instructions. Its plan always waits for your approval.";

/** Ask for a refetch: `now` skips the throttle (view built, tab visible again). Never runs while hidden, off the board or signed out. */
function boardPoke(now) {
  if (S.expired || S.view !== 'board') return;
  const wait = now ? 0 : Math.max(0, BOARD_POKE_MS - (Date.now() - B.xLast));
  if (B.xTimer && B.xDue <= Date.now() + wait) return; // already due sooner
  armBoardFetch(wait);
}
function armBoardFetch(ms) { clearTimeout(B.xTimer); B.xDue = Date.now() + ms; B.xTimer = setTimeout(fetchBoardExtras, ms); }
async function fetchBoardExtras() {
  B.xTimer = 0;
  if (S.expired || document.hidden || S.view !== 'board') return; // hidden: visibilitychange pokes again (N1)
  if (B.xBusy) { armBoardFetch(BOARD_POKE_MS); return; }
  const gen = B.xGen;
  B.xBusy = true; B.xLast = Date.now();
  let data = null;
  try { data = await api('GET', '/api/board'); } catch { /* keep the last good data; a 401 already went through showExpired */ }
  B.xBusy = false;
  if (gen !== B.xGen || S.expired) return;
  if (data) { B.extra = M.boardExtras(data); if (S.view === 'board' && S.state) updateBoard(); }
  const active = B.extra && B.extra.research.planning.length > 0;
  if (!B.xTimer && S.view === 'board') armBoardFetch(active ? BOARD_FAST_MS : BOARD_SLOW_MS);
}
function leaveBoard() { B.xGen++; clearTimeout(B.xTimer); B.xTimer = 0; B.extra = null; B.rcards = new Map(); }
const cardOrigin = (key) => (B.extra && B.extra.cards[key]) || null;

/** The "Part n/N" chip and the constant model-written badge (S16: on every card a model made, with or without a part). */
function designChips() {
  const partT = h('span'); const partSr = h('span', { class: 'sr-only' });
  return {
    partT, partSr,
    part: h('span', { class: 'chip', hidden: true }, icon('list'), partT, partSr),
    model: h('span', { class: 'badge tone-warn', hidden: true, title: MODEL_CARD_TIP }, icon('warn'), MODEL_CARD_LABEL),
  };
}
function setDesignChips(c, o) {
  const hasPart = !!(o && o.parts);
  toggleHidden(c.part, !hasPart);
  if (hasPart) {
    setText(c.partT, 'Part ' + o.part + '/' + o.parts);
    setText(c.partSr, o.after.length ? ', after ' + o.after.join(', ') : '');
    const tip = M.partTip(o);
    if (c.part.title !== tip) c.part.title = tip;
  }
  toggleHidden(c.model, !(o && o.model));
}

/* Research cards: created once per ask id, updated in place. No drawer, no move, no edit (S15). */
function researchEl(r) {
  let el = B.rcards.get(r.id);
  if (!el) { el = createResearchCard(r.id); B.rcards.set(r.id, el); }
  updateResearchCard(el, r);
  return el;
}
function createResearchCard(id) {
  const p = {};
  p.deep = h('span', { class: 'chip', hidden: true, title: 'Deep research: more sources, takes longer' }, 'Deep');
  p.title = h('p', { class: 'card-title' });
  p.ic = h('span', { class: 'ic' });
  p.sentence = h('span');
  p.timer = h('span', { class: 't-elapsed' });
  p.tail = h('span', { hidden: true }, ' · ', p.timer);
  p.act = h('p', { class: 'card-activity' }, p.ic, h('span', null, p.sentence, p.tail));
  p.reason = h('p', { class: 'card-reason', hidden: true });
  p.repoT = h('span', { class: 'card-repo' });
  p.repo = h('span', { class: 'chip', hidden: true, title: 'Repository' }, icon('folder'), p.repoT);
  p.countsT = h('span');
  p.counts = h('span', { class: 'chip', hidden: true, title: "Findings in the report, by the state of their sources" }, icon('file'), p.countsT);
  p.meta = h('div', { class: 'card-meta' }, p.repo, p.counts);
  p.bReport = h('button', { type: 'button', class: 'btn btn-primary btn-sm', hidden: true, data: { act: 'r-report', rid: id } }, icon('file'), h('span', null, 'View report'));
  p.bDismiss = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', hidden: true, data: { act: 'r-dismiss', rid: id } }, 'Dismiss');
  p.bRemove = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', hidden: true, data: { act: 'r-remove', rid: id } }, icon('x-circle'), h('span', null, 'Remove'));
  p.actions = h('div', { class: 'card-actions', hidden: true }, p.bReport, p.bDismiss, p.bRemove);
  const el = h('li', { class: 'card research-card', data: { rid: id } },
    h('div', { class: 'card-top' }, h('span', { class: 'chip chip-kind', title: 'A research task: web research, no code changes' }, icon('shield'), h('span', null, 'Research')), p.deep),
    p.title, p.act, p.reason, p.meta, p.actions);
  el._p = p;
  return el;
}
function updateResearchCard(el, r) {
  const p = el._p;
  const col = M.RESEARCH_COL[r.lane];
  const cls = 'card research-card st-' + (col === 'needs_human' ? 'needs_human' : col === 'ready' ? 'ready' : 'planning');
  if (el.className !== cls) el.className = cls;
  toggleHidden(p.deep, !r.deep);
  setText(p.title, r.title || 'Research');
  const running = r.lane === 'active';
  const sentence = running ? (r.status === 'paused' ? "Waiting for Claude's usage limit to reset" : 'Claude is researching')
    : r.lane === 'review' ? 'Report ready — ready for your review' : 'Research did not finish';
  setText(p.sentence, sentence);
  const icKey = running && r.status !== 'paused' ? 'dot' : col;
  if (p._ic !== icKey) { p._ic = icKey; p.ic.replaceChildren(icKey === 'dot' ? h('span', { class: 'dot pulse' }) : icon(r.status === 'paused' ? 'pause' : COLUMN_ICON[col] || 'info')); }
  if (running && r.createdAt) { setTimer(p.timer, 't0', r.createdAt); toggleHidden(p.tail, false); } else toggleHidden(p.tail, true);
  const reason = r.lane === 'needs_you' ? r.error || '' : '';
  setText(p.reason, reason); toggleHidden(p.reason, !reason);
  setText(p.repoT, r.repo || ''); toggleHidden(p.repo, !r.repo);
  const showCounts = r.lane === 'review';
  toggleHidden(p.counts, !showCounts);
  if (showCounts) setText(p.countsT, M.researchCounts(r.counts));
  toggleHidden(p.meta, p.repo.hidden && p.counts.hidden);
  const ready = r.lane === 'review'; const failed = r.lane === 'needs_you';
  toggleHidden(p.bReport, !ready); toggleHidden(p.bDismiss, !ready); toggleHidden(p.bRemove, !failed);
  const lbl = (v) => v + ': ' + (r.title || 'research');
  if (p.bDismiss.getAttribute('aria-label') !== lbl('Dismiss report')) p.bDismiss.setAttribute('aria-label', lbl('Dismiss report'));
  if (p.bRemove.getAttribute('aria-label') !== lbl('Remove research')) p.bRemove.setAttribute('aria-label', lbl('Remove research'));
  toggleHidden(p.actions, !(ready || failed));
  setBusy(p.bDismiss, S.busy.has(r.id + ':dismiss'));
  setBusy(p.bRemove, S.busy.has(r.id + ':remove'));
}
const researchById = (id) => {
  const X = B.extra ? B.extra.research : null;
  return X ? [...X.planning, ...X.ready, ...X.needs_human].find((r) => r.id === id) || null : null;
};
async function actDismissResearch(id) {
  const ok = await runAction(id, 'dismiss', () => api('POST', '/api/asks/' + enc(id) + '/dismiss', {}), 'Report moved off the board.');
  if (ok) boardPoke(true);
  return ok;
}
async function actRemoveResearch(id) {
  const r = researchById(id);
  const yes = await confirmDialog({
    title: 'Remove this research?',
    body: 'The research record' + (r && r.title ? ' "' + r.title + '"' : '') + ' is deleted, with anything it found. This cannot be undone.',
    confirmLabel: 'Remove', danger: true,
  });
  if (!yes) return;
  const ok = await runAction(id, 'remove', () => api('DELETE', '/api/asks/' + enc(id)), 'Research removed.');
  if (ok) boardPoke(true);
}

function updateBoard() {
  const st = S.state;
  const open = st.runs.filter((r) => r.column !== 'closed');
  const closed = st.runs.filter((r) => r.column === 'closed');
  const cardsBy = { backlog: st.cards.filter((c) => c.lane === 'backlog'), todo: st.cards.filter((c) => c.lane === 'todo') };
  // run-less cards that sit in a Conductor-owned lane (orphans: nobody is working on them) must not be invisible — show them in their lane's column with the reason
  const ORPHAN_COL = { needs_you: 'needs_human', review: 'ready', active: 'planning' };
  const extra = new Map(COLUMNS.map((c) => [c.id, []]));
  for (const c of st.cards) if (ORPHAN_COL[c.lane]) extra.get(ORPHAN_COL[c.lane]).push(c);
  const orphanCount = [...extra.values()].reduce((n, l) => n + l.length, 0);
  const RX = B.extra ? B.extra.research : null;
  const rx = new Map(COLUMNS.map((c) => [c.id, (RX && RX[c.id]) || []]));
  const researchCount = [...rx.values()].reduce((n, l) => n + l.length, 0);
  const idle = cardsBy.backlog.length + cardsBy.todo.length + orphanCount + researchCount;
  const byCol = new Map(COLUMNS.map((c) => [c.id, []]));
  for (const r of open) (byCol.get(r.column) || byCol.get('queued')).push(r);

  updateBoardWording();
  toggleHidden(B.empty, open.length > 0 || idle > 0);
  toggleHidden(B.board, open.length === 0 && idle === 0);
  setText(B.pollEl, st.engine.pollSeconds || 5);

  const order = S.isMobile ? MOBILE_ORDER : COLUMNS.map((c) => c.id);
  const osig = order.join();
  if (osig !== B.order) { B.order = osig; B.board.replaceChildren(...order.map((id) => B.cols.get(id).el)); }

  const seen = new Set();
  for (const c of COLUMNS) {
    const col = B.cols.get(c.id);
    if (c.cards) { // run-less cards (Backlog / To do): plain cards with their own actions
      const cl = cardsBy[c.id];
      reconcile(col.list, cl.map(idleEl));
      setText(col.count, cl.length);
      col.el.classList.toggle('is-empty', !cl.length);
      toggleHidden(col.empty, cl.length > 0);
      continue;
    }
    const list = byCol.get(c.id);
    const els = list.map((r) => {
      seen.add(r.key);
      let el = B.cards.get(r.key);
      if (!el) { el = createCard(r.key); B.cards.set(r.key, el); }
      updateCard(el, r);
      return el;
    });
    const ex = extra.get(c.id) || [];
    const rs = rx.get(c.id) || [];
    reconcile(col.list, els.concat(ex.map(idleEl), rs.map(researchEl)));
    const total = list.length + ex.length + rs.length;
    setText(col.count, total);
    col.count.setAttribute('aria-label', plural(total, 'card'));
    col.el.classList.toggle('is-empty', !total);
    col.el.classList.toggle('is-attn', !!c.attn && total > 0);
    col.el.classList.toggle('is-ask', !!c.ask && total > 0);
    toggleHidden(col.empty, total > 0);
  }
  for (const [k, el] of B.cards) if (!seen.has(k)) { el.remove(); B.cards.delete(k); }
  const liveIdle = new Set(st.cards.map((c) => c.key + '|' + c.lane));
  for (const [id, rec] of B.idle) if (!liveIdle.has(id)) { rec.el.remove(); B.idle.delete(id); }
  const liveR = new Set([...rx.values()].flat().map((r) => r.id));
  for (const [id, el] of B.rcards) if (!liveR.has(id)) { el.remove(); B.rcards.delete(id); }
  updateSummary(byCol, extra, rx);
  updateHistory(closed);
}

/** Idle (run-less) cards are created ONCE per key+lane and updated in place — rebuilding them on every state event dropped keyboard focus and clicks. */
function idleEl(c) {
  const id = c.key + '|' + c.lane;
  let rec = B.idle.get(id);
  if (!rec) { rec = { el: idleCard(c), title: null, note: null }; rec.dc = rec.el._dc; B.idle.set(id, rec); }
  const t = rec.el.querySelector('.card-title');
  if (t && rec.title !== c.title) { t.textContent = c.title; rec.title = c.title; }
  const o = cardOrigin(c.key);
  setDesignChips(rec.dc, o);
  toggleHidden(rec.dc.meta, rec.dc.part.hidden && rec.dc.model.hidden);
  const n = c.note || (c.lane === 'todo' ? M.waitNote(o) : '');
  if (rec.note !== n) {
    rec.note = n;
    let np = rec.el.querySelector('.card-note');
    if (n && !np) { np = h('p', { class: 'muted card-note' }, n); rec.el.querySelector('.card-actions').before(np); }
    else if (np && n) np.textContent = n;
    else if (np) np.remove();
  }
  return rec.el;
}
function idleCard(c) {
  const move = (lane, msg) => () => runAction(c.key, 'move:' + lane, () => api('POST', `/api/items/${enc(c.key)}/move`, { lane }), msg);
  const btns = c.lane === 'todo'
    ? [h('button', { type: 'button', class: 'btn btn-sm', onclick: move('backlog', `${c.key} moved to Backlog.`) }, 'Park')]
    : [h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: move('todo', `${c.key} will start now.`) }, c.lane === 'backlog' ? 'Start' : 'Run it'),
      ...(c.lane === 'backlog' ? [] : [h('button', { type: 'button', class: 'btn btn-sm', onclick: move('backlog', `${c.key} moved to Backlog.`) }, 'Park')])];
  btns.push(h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: move('canceled', `${c.key} canceled.`) }, 'Cancel'));
  const dc = designChips();
  dc.meta = h('div', { class: 'card-meta', hidden: true }, dc.part, dc.model);
  const el = h('li', { class: 'card idle-card' }, h('div', { class: 'card-top' }, h('span', { class: 'card-key' }, c.key)), h('p', { class: 'card-title' }, c.title), dc.meta, h('div', { class: 'card-actions' }, btns));
  el._dc = dc;
  return el;
}

function updateSummary(byCol, extra, rx) {
  const n = (id) => byCol.get(id).length + ((extra && extra.get(id)) || []).length + ((rx && rx.get(id)) || []).length;
  const working = n('planning') + n('building') + n('verifying');
  const items = [];
  if (n('needs_human')) items.push({ col: 'needs_human', cls: 'st-needs_human', ic: 'alert', n: n('needs_human'), text: n('needs_human') === 1 ? 'needs you' : 'need you' });
  if (n('plan_ready')) items.push({ col: 'plan_ready', cls: 'st-plan_ready', ic: 'clipboard', n: n('plan_ready'), text: n('plan_ready') === 1 ? 'plan to approve' : 'plans to approve' });
  if (n('ready')) items.push({ col: 'ready', cls: 'st-ready', ic: 'check', n: n('ready'), text: 'ready for review' });
  if (working) items.push({ col: working === n('building') ? 'building' : 'planning', cls: 'st-building', ic: 'code', n: working, text: 'working' });
  if (n('paused')) items.push({ col: 'paused', cls: 'st-paused', ic: 'pause', n: n('paused'), text: 'paused' });
  if (n('queued')) items.push({ col: 'queued', cls: 'st-queued', ic: 'clock', n: n('queued'), text: 'queued' });
  const sig = JSON.stringify(items);
  if (sig !== B.itemsSig) {
    B.itemsSig = sig;
    B.items.replaceChildren(...(items.length
      ? items.map((i) => h('button', { type: 'button', class: 'sum-item ' + i.cls, data: { act: 'jump', col: i.col } },
        icon(i.ic, 'icon-sm'), h('b', null, i.n), ' ', i.text))
      : [h('span', { class: 'sum-quiet' }, 'Nothing is running right now.')]));
  }
  const lp = S.state.engine.lastPollAt;
  B.polled.replaceChildren();
  if (lp) B.polled.append('Board checked ', h('span', { class: 'num', data: { ago: lp } }, ''));
  else B.polled.append('Waiting for the first check');
}

function histRow(r) {
  return h('li', null, h('button', { type: 'button', class: 'hrow', data: { act: 'open', key: r.key } },
    h('span', { class: 'card-key' }, r.key),
    h('span', { class: 't' }, r.title),
    h('span', { class: 'st ' + statusClass(r) }, icon(statusIcon(r)), runLabel(r)),
    h('span', { class: 'hrow-time muted', title: fmtFull(r.updatedAt), data: { ago: r.updatedAt } }, '')));
}
function updateHistory(closed) {
  toggleHidden(B.history, closed.length === 0);
  setText(B.histCount, closed.length);
  const sig = closed.map((r) => [r.key, r.status, r.updatedAt, r.title].join('|')).join('~');
  if (sig === B.histSig) return;
  B.histSig = sig;
  B.histList.replaceChildren(...closed.map(histRow));
}

function jumpToColumn(id) {
  const col = B.cols.get(id);
  if (!col) return;
  col.el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: S.isMobile ? 'start' : 'nearest', inline: 'center' });
  col.title.focus({ preventScroll: true });
}

/* ───────────────────────── cards ───────────────────────── */
function createCard(key) {
  const p = {};
  p.key = h('span', { class: 'card-key' }, key);
  p.repoT = h('span', { class: 'card-repo' });
  p.repo = h('span', { class: 'chip', hidden: true, title: 'Repository' }, icon('folder'), p.repoT);
  p.agent = h('span', { class: 'ag', hidden: true });
  p.main = h('button', { type: 'button', class: 'card-main', data: { act: 'open', key } });
  p.ic = h('span', { class: 'ic' });
  p.sentence = h('span');
  p.lbl = h('span');
  p.timer = h('span', { class: 't-elapsed' });
  p.tail = h('span', { hidden: true }, ' · ', p.lbl, p.timer);
  p.act = h('p', { class: 'card-activity' }, p.ic, h('span', null, p.sentence, p.tail));
  p.reason = h('p', { class: 'card-reason', hidden: true });
  p.loopT = h('span'); p.bugsT = h('span');
  p.loop = h('span', { class: 'chip', title: 'Fix loops used / allowed', hidden: true }, icon('repeat'), p.loopT);
  p.bugs = h('span', { class: 'chip is-bad', hidden: true }, icon('bug'), p.bugsT);
  p.unv = h('span', { class: 'badge tone-warn', hidden: true, title: 'No reliable gates: regressions cannot be ruled out' }, icon('warn'), 'Unverified');
  p.dc = designChips();
  // M8-3: the account of the current/last stage (only when its tool has several) and the last automatic move (N5 wording)
  p.acctT = h('span'); p.acct = h('span', { class: 'chip', hidden: true }, icon('lock'), p.acctT);
  p.movedT = h('span'); p.moved = h('span', { class: 'chip', hidden: true }, icon('repeat'), p.movedT);
  p.meta = h('div', { class: 'card-meta' }, p.dc.part, p.dc.model, p.repo, p.acct, p.moved, p.loop, p.bugs, p.unv);
  p.bApprove = h('button', { type: 'button', class: 'btn btn-primary btn-sm', hidden: true, data: { act: 'approve' } }, icon('tick'), h('span', null, 'Approve plan'));
  p.bRetry = h('button', { type: 'button', class: 'btn btn-sm', hidden: true, data: { act: 'retry' } }, icon('refresh'), h('span', null, 'Retry'));
  p.bResume = h('button', { type: 'button', class: 'btn btn-sm', hidden: true, data: { act: 'resume' } }, icon('play'), h('span', null, 'Resume now'));
  p.actions = h('div', { class: 'card-actions', hidden: true }, p.bApprove, p.bRetry, p.bResume);
  const el = h('li', { class: 'card is-entering', data: { key } },
    h('div', { class: 'card-top' }, p.key, h('span', { class: 'card-spacer' }), p.agent), p.main, p.act, p.reason, p.meta, p.actions);
  el._p = p;
  el._entering = true;
  const settle = () => { if (el._entering) { el._entering = false; el.classList.remove('is-entering'); } };
  el.addEventListener('animationend', settle, { once: true });
  setTimeout(settle, 800); // a hidden tab may never deliver animationend
  return el;
}
function setTimer(span, mode, ts) {
  if (mode === 't0') { span.dataset.t0 = String(ts); delete span.dataset.t1; span.className = 't-elapsed'; }
  else { span.dataset.t1 = String(ts); delete span.dataset.t0; span.className = 't-until'; }
  tickEl(span);
}
function updateCard(el, r) {
  const p = el._p;
  const cls = 'card ' + statusClass(r) + (S.route.key === r.key ? ' is-selected' : '') + (el._entering ? ' is-entering' : '');
  if (el.className !== cls) el.className = cls;
  setText(p.repoT, r.repo || ''); toggleHidden(p.repo, !r.repo);

  if (r.agent) {
    if (p._ag !== r.agent) {
      p._ag = r.agent;
      p.agent.className = 'ag ag-' + r.agent;
      p.agent.replaceChildren(icon(AGENT_ICON[r.agent] || 'diamond'), AGENT_LABEL[r.agent] || r.agent);
    }
    p.agent.title = (AGENT_LABEL[r.agent] || r.agent) + ' is working';
    toggleHidden(p.agent, false);
  } else { p._ag = null; toggleHidden(p.agent, true); }

  setText(p.main, r.title);

  const working = WORKING_COLUMNS.includes(r.column);
  const live = working && r.stageStartedAt;
  setText(p.sentence, activitySentence(r, live));
  const icKey = working ? 'dot' : r.column;
  if (p._ic !== icKey) { p._ic = icKey; p.ic.replaceChildren(working ? h('span', { class: 'dot pulse' }) : icon(COLUMN_ICON[r.column] || 'info')); }
  if (live) { setText(p.lbl, ''); setTimer(p.timer, 't0', r.stageStartedAt); toggleHidden(p.tail, false); }
  else if (r.column === 'paused' && r.pausedUntil) { setText(p.lbl, 'resumes in '); setTimer(p.timer, 't1', r.pausedUntil); toggleHidden(p.tail, false); }
  else if (WAITING_COLUMNS.includes(r.column) && r.updatedAt) { setText(p.lbl, 'waiting '); setTimer(p.timer, 't0', r.updatedAt); toggleHidden(p.tail, false); }
  else toggleHidden(p.tail, true);

  const reason = r.column === 'needs_human' && r.needsHuman ? r.needsHuman.reason : '';
  setText(p.reason, reason); toggleHidden(p.reason, !reason);

  const showLoop = r.loop > 0 && r.maxLoops > 0 && ['building', 'verifying', 'needs_human', 'ready', 'paused'].includes(r.column);
  toggleHidden(p.loop, !showLoop);
  if (showLoop) setText(p.loopT, `Loop ${r.loop}/${r.maxLoops}`);
  toggleHidden(p.bugs, !(r.bugsOpen > 0));
  if (r.bugsOpen > 0) setText(p.bugsT, plural(r.bugsOpen, 'open bug'));
  toggleHidden(p.unv, !r.unverified);
  setDesignChips(p.dc, cardOrigin(r.key));
  const acc = r.account && typeof r.account.name === 'string' && accountsOf(r.account.provider).length > 1 ? r.account : null;
  toggleHidden(p.acct, !acc);
  if (acc) { setText(p.acctT, acc.name); p.acct.title = 'Account: ' + (AGENT_LABEL[acc.provider] || acc.provider) + ' · ' + acc.name; }
  const mv = r.moved && !['ready', 'closed'].includes(r.column) ? M.movedChip(r.moved) : null;
  toggleHidden(p.moved, !mv);
  if (mv) { setText(p.movedT, mv.label); p.moved.title = mv.title; }
  toggleHidden(p.meta, p.dc.part.hidden && p.dc.model.hidden && p.repo.hidden && p.acct.hidden && p.moved.hidden && p.loop.hidden && p.bugs.hidden && p.unv.hidden);

  const showApprove = !!r.canApprove;
  const showRetry = !!r.canRetry && r.column === 'needs_human';
  const showResume = r.status === 'paused' || r.status === 'parked';
  toggleHidden(p.bApprove, !showApprove); toggleHidden(p.bRetry, !showRetry); toggleHidden(p.bResume, !showResume);
  toggleHidden(p.actions, !(showApprove || showRetry || showResume));
  setBusy(p.bApprove, S.busy.has(r.key + ':approve'));
  setBusy(p.bRetry, S.busy.has(r.key + ':retry'));
  setBusy(p.bResume, S.busy.has(r.key + ':resume'));
}

function onViewClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t || !$('#view').contains(t)) return;
  const card = t.closest('[data-key]');
  const key = t.dataset.key || (card && card.dataset.key);
  switch (t.dataset.act) {
    case 'open': if (key) openRun(key); break;
    case 'approve': if (key) actApprove(key); break;
    case 'retry': if (key) actRetry(key); break;
    case 'resume': if (key) actResume(key); break;
    case 'jump': jumpToColumn(t.dataset.col); break;
    case 'new-task': openNewTask(); break;
    case 'open-setup': navigate('#/setup'); break;
    case 'r-report': if (M.isAskId(t.dataset.rid)) openResearchReport(t.dataset.rid, t); break;
    case 'r-dismiss': if (M.isAskId(t.dataset.rid)) actDismissResearch(t.dataset.rid); break;
    case 'r-remove': if (M.isAskId(t.dataset.rid)) actRemoveResearch(t.dataset.rid); break;
    default: break;
  }
}

/* ───────────────────────── run drawer ───────────────────────── */
const D = { tabBtns: null, panels: {}, counts: {}, fetching: false, again: false, silent: false, headSig: '', refreshTimer: 0 };

function badge(tone, label, ic, extra) {
  return h('span', { class: 'badge tone-' + tone + (extra ? ' ' + extra : '') }, ic ? icon(ic) : null, label);
}
function statusPill(r) {
  return h('span', { class: 'st ' + statusClass(r) }, icon(statusIcon(r)), runLabel(r));
}
function agentChip(a, text) {
  return h('span', { class: 'ag ag-' + a }, icon(AGENT_ICON[a] || 'diamond'), text || AGENT_LABEL[a] || a);
}

function buildDrawer(key) {
  const dlg = $('#drawer');
  D.tabBtns = {}; D.panels = {}; D.counts = {}; D.headSig = '';
  D.title = h('h2', { id: 'drawer-title' }, 'Loading…');
  D.badges = h('div', { class: 'dr-key' }, h('span', { class: 'card-key' }, key));
  D.sub = h('div', { class: 'dr-sub' });
  const closeBtn = h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': 'Close run details', title: 'Close (Esc)', onclick: closeRoute }, icon('x'));
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Run details', onkeydown: onTabKey });
  const panelWrap = h('div', { class: 'dr-panels' });
  for (const [id, label] of TABS) {
    const count = h('span', { class: 'count', hidden: true });
    D.counts[id] = count;
    D.tabBtns[id] = h('button', {
      type: 'button', class: 'tab', role: 'tab', id: 'tab-' + id, 'aria-controls': 'panel-' + id,
      'aria-selected': 'false', tabindex: '-1', data: { tab: id }, onclick: () => selectTab(id, true),
    }, label, count);
    if (id === 'tasks') D.tabBtns[id].hidden = true;
    tablist.appendChild(D.tabBtns[id]);
    D.panels[id] = h('div', {
      class: 'panel' + (id === 'log' ? ' is-log' : ''), role: 'tabpanel', id: 'panel-' + id,
      'aria-labelledby': 'tab-' + id, tabindex: id === 'log' ? null : '0', hidden: true,
    });
    panelWrap.appendChild(D.panels[id]);
  }
  D.panels.overview.appendChild(h('p', { class: 'muted' }, 'Loading run…'));
  buildLogPanel(D.panels.log);
  dlg.replaceChildren(
    h('div', { class: 'dr-head' },
      h('div', { class: 'dr-title-row' }, h('div', { class: 'dr-title' }, D.badges, D.title, D.sub), closeBtn),
      tablist),
    panelWrap);
}
function startDetail(key) {
  S.detailKey = key; S.detail = null; S.detailSig = ''; S.detailError = null; S.verLoop = null;
  buildDrawer(key);
  initLog(key);
  fetchDetail();
}
function syncDrawer() {
  const dlg = $('#drawer');
  const { key, tab } = S.route;
  if (!key) { closeDrawerSilently(); return; }
  if (S.detailKey !== key) startDetail(key);
  updateDrawerHead();
  selectTab(tab, false);
  if (!dlg.open) dlg.showModal();
}
function closeDrawerSilently() {
  const dlg = $('#drawer');
  if (dlg.open) { D.silent = true; dlg.close(); }
  if (S.detailKey) { S.detailKey = null; S.detail = null; S.detailSig = ''; L.key = null; dlg.replaceChildren(); L.queue = []; L.pending = []; }
}
function selectTab(id, user) {
  if (D.tabBtns && D.tabBtns[id] && D.tabBtns[id].hidden) id = 'overview'; // the Tasks tab exists only for runs that were split into tasks
  if (!D.tabBtns || !D.tabBtns[id]) return;
  for (const [tid, b] of Object.entries(D.tabBtns)) {
    const on = tid === id;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    toggleHidden(D.panels[tid], !on);
  }
  S.route.tab = id;
  if (user && S.detailKey) history.replaceState(null, '', '#/run/' + enc(S.detailKey) + (id === 'overview' ? '' : '/' + id));
  if (id === 'log') logShown();
}
function onTabKey(e) {
  const ids = TABS.map((t) => t[0]).filter((id) => !(D.tabBtns[id] && D.tabBtns[id].hidden));
  const cur = ids.indexOf(document.activeElement && document.activeElement.dataset.tab);
  if (cur < 0) return;
  let n = -1;
  if (e.key === 'ArrowRight') n = (cur + 1) % ids.length;
  else if (e.key === 'ArrowLeft') n = (cur - 1 + ids.length) % ids.length;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = ids.length - 1;
  else return;
  e.preventDefault();
  selectTab(ids[n], true);
  D.tabBtns[ids[n]].focus();
}
function updateDrawerHead() {
  const r = runByKey(S.detailKey) || S.detail;
  if (!r || !D.title) return;
  setText(D.title, r.title);
  const sig = [r.status, r.column, r.agent, r.repo, r.branch, r.loop, r.maxLoops, r.rev].join('|');
  if (sig !== D.headSig) {
    D.headSig = sig;
    D.badges.replaceChildren(...[h('span', { class: 'card-key' }, r.key), statusPill(r), r.agent ? agentChip(r.agent, (AGENT_LABEL[r.agent] || r.agent) + ' working') : null].filter(Boolean));
    D.sub.replaceChildren(...[
      r.repo ? h('span', { class: 'chip' }, icon('folder'), r.repo) : null,
      r.branch ? h('span', { class: 'chip chip-mono', title: 'Branch' }, icon('branch'), r.branch) : null,
      r.loop > 0 && r.maxLoops > 0 ? h('span', { class: 'chip', title: 'Fix loops used / allowed' }, icon('repeat'), `Loop ${r.loop}/${r.maxLoops}`) : null].filter(Boolean));
  }
  const bugs = r.bugsOpen || 0;
  setText(D.counts.verification, bugs);
  toggleHidden(D.counts.verification, !bugs);
  D.counts.verification.classList.toggle('is-bad', bugs > 0);
  const ns = S.detail ? S.detail.sessions.length : 0;
  setText(D.counts.sessions, ns);
  toggleHidden(D.counts.sessions, !ns);
}
function updateDrawerLive() {
  if (!S.detailKey || !D.tabBtns) return;
  updateDrawerHead();
  updateLogStatus();
  const s = runByKey(S.detailKey);
  const d = S.detail;
  if (s && d && (s.updatedAt !== d.updatedAt || s.status !== d.status || s.loop !== d.loop || s.bugsOpen !== d.bugsOpen )) {
    clearTimeout(D.refreshTimer);
    D.refreshTimer = setTimeout(fetchDetail, 350);
  }
}
async function fetchDetail() {
  const key = S.detailKey;
  if (!key) return;
  if (D.fetching) { D.again = true; return; }
  D.fetching = true;
  try {
    const d = normalizeDetail(await api('GET', '/api/runs/' + enc(key)));
    if (S.detailKey !== key) return;
    S.detailError = null;
    const sig = JSON.stringify(d);
    const changed = sig !== S.detailSig;
    S.detail = d; S.detailSig = sig;
    updateDrawerHead();
    updateLogStatus();
    if (changed) renderDetailPanels();
  } catch (e) {
    if (S.detailKey !== key || (e instanceof ApiFail && e.status === 401)) return;
    S.detailError = e;
    fillPanel('overview', detailErrorNode(e));
  } finally {
    D.fetching = false;
    if (D.again) { D.again = false; fetchDetail(); }
  }
}
function detailErrorNode(e) {
  const gone = e instanceof ApiFail && e.status === 404;
  return h('div', { class: 'callout c-bad', role: 'alert' }, icon('warn'), h('div', { class: 'callout-body' },
    h('b', null, gone ? 'This run no longer exists' : "Couldn't load this run"),
    h('div', { class: 'pre' }, gone ? 'It may have been removed or cleaned up. Close this panel to go back to the board.' : e.message),
    gone ? null : h('div', { class: 'row' }, btn('Try again', { icon: 'refresh', cls: 'btn-sm', onclick: () => fetchDetail() }))));
}
function fillPanel(id, node) {
  const p = D.panels[id];
  if (!p) return;
  const top = p.scrollTop;
  const act = document.activeElement;
  const fid = act && p.contains(act) ? act.getAttribute('data-fid') : null;
  p.replaceChildren(node);
  p.scrollTop = top;
  if (fid) { const el = p.querySelector('[data-fid="' + CSS.escape(fid) + '"]'); if (el) el.focus({ preventScroll: true }); }
  tick();
}
function renderDetailPanels() {
  const d = S.detail;
  if (!d) return;
  fillPanel('overview', renderOverview(d));
  fillPanel('plan', renderPlan(d));
  const gr = d.graph;
  if (D.tabBtns.tasks) {
    toggleHidden(D.tabBtns.tasks, !gr);
    if (D.counts.tasks) {
      const done = gr ? gr.items.filter((i) => i.state === 'done').length : 0;
      setText(D.counts.tasks, gr ? done + '/' + gr.items.length : '');
      toggleHidden(D.counts.tasks, !gr);
    }
    if (!gr && S.route.tab === 'tasks') selectTab('overview', false);
  }
  fillPanel('tasks', renderTasks(d));
  fillPanel('verification', renderVerification(d));
  fillPanel('sessions', renderSessions(d));
  fillPanel('timeline', renderTimeline(d));
}

/* ───────────────────────── overview ───────────────────────── */
function activityNodes(r) {
  const working = WORKING_COLUMNS.includes(r.column);
  const live = working && r.stageStartedAt;
  const out = [activitySentence(r, live)];
  if (live) out.push(' · ', h('span', { class: 't-elapsed', data: { t0: r.stageStartedAt } }, ''));
  else if (r.column === 'paused' && r.pausedUntil) out.push(' · resumes in ', h('span', { class: 't-until', data: { t1: r.pausedUntil } }, ''));
  else if (WAITING_COLUMNS.includes(r.column) && r.updatedAt) out.push(' · waiting ', h('span', { class: 't-elapsed', data: { t0: r.updatedAt } }, ''));
  return out;
}
function retryLabel(r) {
  if (r.status === 'ready') return 'Rework (re-plan)';
  const o = r.needsHuman && r.needsHuman.origin;
  const map = { plan: 'Retry planning', plan_review: 'Retry plan review', approval: 'Retry', build: 'Retry build', verify: 'Retry verification' };
  return map[o] || 'Retry';
}
function nextAction(r) {
  switch (r.status) {
    case 'awaiting_approval': return 'Read the plan, then approve it so Cursor can start building.';
    case 'needs_human': return r.needsHuman ? `Sort out the blocker below, then press ${retryLabel(r)}.` : 'Check the run, then press Retry.';
    case 'ready': return `Review branch ${r.branch || ''} and merge it yourself${r.unverified ? '. Look closely: this run is unverified' : ''}. Conductor never pushes or merges.`;
    case 'paused': return r.pausedUntil ? `On hold by a usage limit. It resumes automatically at ${fmtWhen(r.pausedUntil)}, or press Resume now to try immediately.` : 'On hold by a usage limit. It resumes automatically.';
    case 'parked': return 'Parked in Backlog: nothing runs. Press Move to To do to restart it (it re-plans and keeps the work so far).';
    case 'queued': return 'Waiting for a free worker slot. Nothing for you to do.';
    case 'running': return r.agent ? `${AGENT_LABEL[r.agent] || r.agent} is working. Nothing for you to do.` : 'Working. Nothing for you to do.';
    case 'failed': return 'Infrastructure failure. Conductor retries automatically, or press Retry to try now.';
    case 'aborted': return r.canCleanup ? 'This run was stopped. The worktree is kept until you remove it.' : 'This run was stopped.';
    case 'finished': return r.canCleanup ? 'Marked done. You can remove the worktree.' : 'Marked done.';
    default: return '';
  }
}
function actBtn(r, name, label, ic, cls, onclick) {
  const b = h('button', { type: 'button', class: 'btn ' + (cls || ''), data: { fid: 'act:' + name }, onclick }, icon(ic), h('span', null, label));
  setBusy(b, S.busy.has(r.key + ':' + name));
  return b;
}
function renderOverview(d) {
  const root = h('div');
  root.appendChild(h('div', { class: 'hero ' + statusClass(d) }, icon(statusIcon(d), 'icon-lg'), h('div', { class: 'hero-body' },
    h('p', { class: 'hero-activity' }, activityNodes(d)), h('p', { class: 'hero-next' }, nextAction(d)))));

  const bar = h('div', { class: 'actions' });
  if (d.canApprove) bar.appendChild(actBtn(d, 'approve', 'Approve plan', 'tick', 'btn-primary', () => actApprove(d.key)));
  if (d.canRetry) bar.appendChild(actBtn(d, 'retry', retryLabel(d), 'refresh', d.status === 'needs_human' ? 'btn-primary' : '', () => actRetry(d.key)));
  if (d.status === 'paused') bar.appendChild(actBtn(d, 'resume', 'Resume now', 'play', 'btn-primary', () => actResume(d.key)));
  if (d.status === 'parked') bar.appendChild(actBtn(d, 'move:todo', 'Move to To do (restart)', 'play', 'btn-primary', () => actMove(d.key, 'todo', `${d.key} restarted.`)));
  if (d.canPark) bar.appendChild(actBtn(d, 'move:backlog', 'Park in Backlog', 'archive', '', () => actMove(d.key, 'backlog', `${d.key} parked in Backlog.`)));
  if (d.canFinish) bar.appendChild(actBtn(d, 'move:done', 'Mark done', 'tick', '', () => actMove(d.key, 'done', `${d.key} marked done.`)));
  if (d.canCleanup) bar.appendChild(actBtn(d, 'cleanup', 'Remove worktree', 'folder', '', () => actCleanup(d.key)));
  if (d.canAbort) bar.appendChild(actBtn(d, 'abort', 'Abort run', 'x-circle', 'btn-danger', () => actAbort(d.key)));
  root.appendChild(bar);

  if (d.needsHuman) {
    root.appendChild(h('div', { class: 'callout c-bad' }, icon('alert'), h('div', { class: 'callout-body' },
      h('b', null, 'Needs you'), h('div', { class: 'pre' }, d.needsHuman.reason),
      h('p', { class: 'muted' }, 'Stopped before: ' + (d.needsHuman.origin === 'approval' ? 'approval' : STAGE_LABEL[d.needsHuman.origin] || d.needsHuman.origin)))));
  }
  if (d.status === 'paused' && d.pausedUntil) {
    root.appendChild(h('div', { class: 'callout c-limit' }, icon('clock'), h('div', { class: 'callout-body' },
      h('b', null, 'Paused by a usage limit'), h('div', { class: 'pre' }, 'Resumes automatically at ' + fmtWhen(d.pausedUntil) + ' (in '),
      h('span', { class: 'num', data: { t1: d.pausedUntil } }, ''), ')')));
  }
  if (d.unverified) {
    root.appendChild(h('div', { class: 'callout' }, icon('warn'), h('div', { class: 'callout-body' },
      h('b', null, 'Unverified'), h('div', { class: 'pre' }, d.unverifiedWhy || 'No reliable gates, so regressions cannot be ruled out. Review the diff yourself.'))));
  }
  if (d.noPushEnvOnly) {
    root.appendChild(h('div', { class: 'callout' }, icon('warn'), h('div', { class: 'callout-body' },
      h('b', null, 'No-push is env-only for this repo'),
      h('div', { class: 'pre' }, 'A tracked .cursor/cli.json prevented Conductor from writing its push deny rule, so only the environment guard applies. Review the branch before you push anything.'))));
  }

  const fact = (label, content, mono, wide) => h('div', { class: wide ? 'wide' : null }, h('dt', null, label), h('dd', { class: mono ? 'mono' : null }, content));
  const copyBtn = (text, label) => h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Copy ' + label, title: 'Copy ' + label, data: { fid: 'copy:' + label }, onclick: async () => { const ok = await copyText(text); toast(ok ? 'good' : 'warn', ok ? `Copied ${label}.` : `Couldn't copy ${label}.`); } }, icon('copy'));
  root.appendChild(h('div', { class: 'sec' }, h('h3', null, 'Details'), h('dl', { class: 'facts' },
    fact('Repository', d.repo || 'none'),
    fact('Stage', d.stage ? STAGE_LABEL[d.stage] || d.stage : 'none'),
    fact('Fix loop', d.maxLoops ? `${d.loop} of ${d.maxLoops}` : String(d.loop)),
    fact('Plan revision', 'rev ' + d.rev + (d.complexity ? ' · size ' + d.complexity : '')),
    fact('Verdict', d.verdict ? badge(d.verdict === 'pass' ? 'good' : 'bad', d.verdict === 'pass' ? 'Pass' : 'Fail', d.verdict === 'pass' ? 'tick' : 'x-circle') : 'Not yet'),
    fact('Open bugs', String(d.bugsOpen || 0)),
    fact('Started', h('span', { title: fmtFull(d.startedAt) }, fmtWhen(d.startedAt))),
    fact('Last change', h('span', { title: fmtFull(d.updatedAt) }, fmtAgo(d.updatedAt))),
    fact('Branch', [h('span', { class: 'val' }, d.branch || 'none'), d.branch ? copyBtn(d.branch, 'branch name') : null], true),
    fact('Base commit', d.baseSha ? d.baseSha.slice(0, 10) : 'none', true),
    fact('Commit', d.commitSha ? d.commitSha.slice(0, 10) : 'none yet', true),
    fact('Worktree', d.worktree ? [h('span', { class: 'val' }, d.worktree), copyBtn(d.worktree, 'worktree path')] : 'none', true, true))));

  if (d.diffStat) root.appendChild(h('div', { class: 'sec' }, h('h3', null, 'Changes'), h('pre', { class: 'diffstat mono' }, d.diffStat)));
  if (d.description) {
    root.appendChild(h('details', { class: 'sec details-sec', open: true },
      h('summary', null, icon('chevron', 'chev'), 'Task description'), h('div', { class: 'desc' }, d.description)));
  }
  root.appendChild(notesSection(d));
  return root;
}

/* ───────────────────────── notes: the card's conversation (your notes are included in the next attempt) ───────────────────────── */
function notesSection(d) {
  const notes = Array.isArray(d.notes) ? d.notes : [];
  const sec = h('div', { class: 'sec notes-sec' }, h('h3', null, 'Notes'));
  if (notes.length) {
    sec.appendChild(h('ul', { class: 'notes' }, notes.map((n) => {
      const who = n.author === 'user' ? 'You' : 'Conductor';
      const long = n.body.length > 500;
      const body = long
        ? h('details', null, h('summary', null, n.body.slice(0, 160).replace(/\s+/g, ' ') + '…'), h('div', { class: 'pre' }, n.body))
        : h('div', { class: 'pre' }, n.body);
      return h('li', { class: 'note note-' + n.author }, h('div', { class: 'note-meta' }, h('b', null, who), ' · ', h('span', { title: fmtFull(n.ts) }, fmtAgo(n.ts))), body);
    })));
  } else sec.appendChild(h('p', { class: 'muted' }, 'Nothing yet. Notes you add here are read by the planner the next time this card runs.'));
  const idN = uid('note');
  const ta = h('textarea', { class: 'textarea', id: idN, rows: '3', maxlength: '20000', placeholder: 'Answer a question, add context or a constraint…' });
  const add = h('button', { type: 'button', class: 'btn', onclick: async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    setBusy(add, true);
    try {
      await api('POST', `/api/items/${enc(d.key)}/comment`, { body: text });
      ta.value = '';
      toast('good', 'Note added. It is included the next time this card runs.');
      await fetchDetail();
    } catch (e) { toast('error', e.message); }
    setBusy(add, false);
  } }, 'Add note');
  sec.appendChild(h('div', { class: 'field' }, h('label', { class: 'label', for: idN }, 'Add a note'), ta));
  sec.appendChild(h('div', { class: 'row' }, add));
  return sec;
}

/* ───────────────────────── sessions & timeline ───────────────────────── */
function sessionTone(status) {
  return { running: 'info', ok: 'good', error: 'bad', limit: 'warn', aborted: 'mute', timeout: 'bad' }[status] || 'mute';
}
function renderSessions(d) {
  const root = h('div');
  const has = (a) => d.sessions.some((s) => s.agent === a);
  const ob = (label, ic, target, ok, why) => {
    const b = h('button', { type: 'button', class: 'btn btn-sm', disabled: !ok, title: ok ? null : why, data: { fid: 'open:' + target }, onclick: () => actOpen(d.key, target) }, icon(ic), h('span', null, label));
    const busy = S.busy.has(d.key + ':open:' + target);
    b.disabled = !ok || busy;
    b.classList.toggle('is-busy', busy);
    return b;
  };
  root.appendChild(h('div', { class: 'open-bar', role: 'group', 'aria-label': 'Open this run elsewhere' },
    h('div', { class: 'grp' },
      ob('Open in Claude app', 'claude', 'claude-desktop', has('claude'), 'No Claude session yet'),
      ob('Open in Cursor', 'cursor', 'cursor', !!d.worktree, 'No worktree yet')),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    h('div', { class: 'grp', role: 'group', 'aria-label': 'Open in Terminal' },
      h('span', { class: 'muted' }, 'Open in Terminal'),
      ob('Claude', 'terminal', 'terminal-claude', has('claude'), 'No Claude session yet'),
      ob('Cursor', 'terminal', 'terminal-cursor', has('cursor'), 'No Cursor session yet')),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    h('div', { class: 'grp' },
      ob('Show in Finder', 'folder', 'finder', !!d.worktree, 'No worktree yet'))));

  if (!d.sessions.length) {
    root.appendChild(h('div', { class: 'empty-note' }, h('b', null, 'No agent sessions yet'), 'Sessions appear here as soon as Claude or Cursor starts working. Each one has a command you can paste to continue it yourself.'));
    return root;
  }
  const list = h('ul', { class: 'stack' });
  for (const s of d.sessions.slice().sort((a, b) => b.startedAt - a.startedAt)) {
    const dur = (s.endedAt || nowMs()) - s.startedAt;
    list.appendChild(h('li', { class: 'sess' },
      h('div', { class: 'sess-head' },
        agentChip(s.agent), h('b', null, STAGE_LABEL[s.stage] || s.stage),
        h('span', { class: 'chip' }, `Loop ${s.loop}`), h('span', { class: 'chip' }, `Plan rev ${s.rev}`),
        badge(sessionTone(s.status), s.status, s.status === 'ok' ? 'tick' : s.status === 'running' ? null : 'info')),
      h('div', { class: 'sess-meta' },
        s.model ? h('span', null, s.model) : null,
        h('span', null, fmtDur(dur) + (s.endedAt ? '' : ' so far')),
        h('span', { title: fmtFull(s.startedAt) }, 'Started ' + fmtWhen(s.startedAt)),
        s.cliVersion ? h('span', null, 'CLI ' + s.cliVersion) : null),
      h('div', { class: 'cmd-row' },
        h('code', { class: 'cmd', tabindex: '0', 'aria-label': `Resume command for the ${AGENT_LABEL[s.agent]} ${STAGE_LABEL[s.stage] || s.stage} session` }, s.resumeCommand || ''),
        h('button', { type: 'button', class: 'btn btn-sm', data: { fid: 'copy:' + s.id }, 'aria-label': `Copy resume command for the ${AGENT_LABEL[s.agent]} ${STAGE_LABEL[s.stage] || s.stage} session`, onclick: async () => {
          const ok = await copyText(s.resumeCommand || '');
          toast(ok ? 'good' : 'warn', ok ? 'Resume command copied. Paste it in a terminal.' : "Couldn't copy. Select the command and copy it manually.");
        } }, icon('copy'), h('span', null, 'Copy')))));
  }
  root.appendChild(list);
  return root;
}
function renderTimeline(d) {
  const items = (d.timeline || []).slice().sort((a, b) => b.ts - a.ts);
  if (!items.length) return h('div', { class: 'empty-note' }, h('b', null, 'Nothing recorded yet'), 'Every state change for this run shows up here.');
  return h('ol', { class: 'timeline', 'aria-label': 'Run timeline, newest first' }, items.map((t) => h('li', { class: 'tl' },
    h('time', { datetime: new Date(t.ts).toISOString(), title: fmtFull(t.ts) }, fmtWhen(t.ts)), h('p', null, t.text))));
}

/* ───────────────────────── live log ───────────────────────── */
const L = {
  key: null, ready: false, pending: [], queue: [], raf: 0, lastSeq: 0, trimmed: 0, pinned: true, newCount: 0,
  lastGroup: '', lastTop: 0, lastTs: 0, error: '', list: null, scroller: null, note: null, empty: null, status: null,
  statusDot: null, statusText: null, pin: null, jump: null,
};
function buildLogPanel(panel) {
  const mkRadio = (v, label) => h('label', null,
    h('input', { type: 'radio', name: 'log-agent', value: v, checked: v === 'all', onchange: () => { L.list.dataset.agent = v; } }), h('span', null, label));
  const seg = h('fieldset', { class: 'seg' }, h('legend', { class: 'sr-only' }, 'Show events from'), mkRadio('all', 'All'), mkRadio('claude', 'Claude'), mkRadio('cursor', 'Cursor'));
  const tools = h('input', { type: 'checkbox', checked: true, onchange: (e) => L.list.classList.toggle('hide-tools', !e.target.checked) });
  const think = h('input', { type: 'checkbox', checked: true, onchange: (e) => L.list.classList.toggle('hide-thinking', !e.target.checked) });
  L.pin = h('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': 'true', onclick: () => setPinned(!L.pinned) }, icon('pin'), h('span', null, 'Pinned to latest'));
  L.jump = h('button', { type: 'button', class: 'btn btn-primary btn-sm jump', hidden: true, onclick: () => setPinned(true) }, icon('pin'), h('span', null, 'Jump to latest'));
  L.note = h('p', { class: 'log-note', hidden: true });
  L.empty = h('p', { class: 'log-empty' }, 'Loading output…');
  L.list = h('div', { class: 'loglist' });
  L.scroller = h('div', { class: 'logscroll', role: 'log', 'aria-live': 'off', 'aria-label': 'Agent output', tabindex: '0' }, L.note, L.empty, L.list);
  L.scroller.addEventListener('scroll', onLogScroll, { passive: true });
  L.statusDot = h('span', { class: 'dot' });
  L.statusText = h('span');
  L.statusAgo = h('span', { class: 'num' });
  L.status = h('div', { class: 'logstatus' }, L.statusDot, L.statusText, L.statusAgo);
  panel.append(
    h('div', { class: 'logbar' }, seg,
      h('label', { class: 'check' }, tools, h('span', null, 'Tool calls')),
      h('label', { class: 'check' }, think, h('span', null, 'Thinking')),
      h('span', { class: 'card-spacer' }), L.pin),
    h('div', { class: 'logwrap' }, L.scroller, L.jump), L.status);
}
function setPinned(v) {
  L.pinned = v;
  L.pin.setAttribute('aria-pressed', v ? 'true' : 'false');
  setText(L.pin.lastChild, v ? 'Pinned to latest' : 'Pin to latest');
  if (v) { L.newCount = 0; scrollLogBottom(); }
  updateJump();
}
function updateJump() {
  const show = !L.pinned && L.newCount > 0;
  toggleHidden(L.jump, !show);
  if (show) setText(L.jump.lastChild, `${plural(L.newCount, 'new line')}, jump to latest`);
}
function scrollLogBottom() {
  if (!L.scroller) return;
  L.scroller.scrollTop = L.scroller.scrollHeight;
  L.lastTop = L.scroller.scrollTop;
}
function onLogScroll() {
  const el = L.scroller;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (L.pinned && !atBottom && el.scrollTop < L.lastTop - 3) setPinned(false);
  else if (!L.pinned && atBottom) setPinned(true);
  L.lastTop = el.scrollTop;
}
function logShown() { if (L.pinned) scrollLogBottom(); }

function initLog(key) {
  Object.assign(L, { key, ready: false, pending: [], queue: [], lastSeq: 0, trimmed: 0, newCount: 0, lastGroup: '', lastTs: 0, error: '' });
  if (L.raf) { cancelAnimationFrame(L.raf); L.raf = 0; }
  L.list.replaceChildren();
  setPinned(true);
  updateLogChrome();
  loadBacklog(key);
}
async function loadBacklog(key) {
  try {
    let after = 0; let all = []; let total = 0;
    for (let i = 0; i < 40; i++) {
      const r = await api('GET', `${runUrl(key, 'log')}?after=${after}&limit=${LOG_PAGE}`);
      if (L.key !== key) return;
      const evs = Array.isArray(r.events) ? r.events : [];
      total += evs.length;
      if (evs.length) { all = all.concat(evs); if (all.length > MAX_LOG_NODES) all = all.slice(-MAX_LOG_NODES); }
      const next = typeof r.next === 'number' ? r.next : after;
      if (evs.length < LOG_PAGE || next <= after) break;
      after = next;
    }
    L.trimmed = total - all.length;
    const frag = document.createDocumentFragment();
    for (const ev of all) appendEv(frag, ev);
    L.list.appendChild(frag);
    for (const ev of all) if (ev.seq > L.lastSeq) L.lastSeq = ev.seq;
    if (all.length) L.lastTs = all[all.length - 1].ts;
    L.ready = true;
    const pend = L.pending; L.pending = [];
    for (const ev of pend) logEnqueue(ev);
    updateLogChrome();
    if (L.pinned) scrollLogBottom();
  } catch (e) {
    if (L.key !== key || (e instanceof ApiFail && e.status === 401)) return;
    L.error = e.message;
    L.ready = true;
    updateLogChrome();
  }
}
async function logResync() {
  if (!L.key || !L.ready) return;
  const key = L.key;
  try {
    for (let i = 0; i < 10; i++) {
      const r = await api('GET', `${runUrl(key, 'log')}?after=${L.lastSeq}&limit=${LOG_PAGE}`);
      if (L.key !== key) return;
      const evs = Array.isArray(r.events) ? r.events : [];
      for (const ev of evs) logEnqueue(ev);
      if (evs.length < LOG_PAGE) break;
    }
  } catch { /* the next SSE event or resync will catch up */ }
}
function logPush(key, ev) {
  if (key !== L.key || !ev) return;
  if (!L.ready) { L.pending.push(ev); return; }
  logEnqueue(ev);
}
function logEnqueue(ev) {
  if (!(ev.seq > L.lastSeq)) return; // dedupe / out-of-order guard
  L.lastSeq = ev.seq;
  L.lastTs = ev.ts || Date.now();
  L.queue.push(ev);
  if (!L.raf) L.raf = requestAnimationFrame(flushLog);
}
function flushLog() {
  L.raf = 0;
  if (!L.queue.length) return;
  const q = L.queue; L.queue = [];
  const frag = document.createDocumentFragment();
  for (const ev of q) appendEv(frag, ev);
  L.list.appendChild(frag);
  while (L.list.childElementCount > MAX_LOG_NODES) {
    const first = L.list.firstElementChild;
    if (first.classList.contains('ev')) L.trimmed++;
    first.remove();
  }
  updateLogChrome();
  if (L.pinned) scrollLogBottom();
  else { L.newCount += q.length; updateJump(); }
}
function updateLogChrome() {
  toggleHidden(L.note, !(L.trimmed > 0));
  if (L.trimmed > 0) setText(L.note, `${L.trimmed.toLocaleString()} older lines trimmed. Showing the latest ${MAX_LOG_NODES.toLocaleString()}.`);
  const none = L.list.childElementCount === 0;
  toggleHidden(L.empty, !none);
  if (none) setText(L.empty, L.error ? "Couldn't load the log: " + L.error : L.ready ? 'No output yet. Lines appear here the moment an agent starts working.' : 'Loading output…');
  updateLogStatus();
}
function updateLogStatus() {
  if (!L.status) return;
  const r = runByKey(L.key) || S.detail;
  const active = r && WORKING_COLUMNS.includes(r.column);
  const down = S.sse.everOpen && !S.sse.ok;
  L.status.classList.toggle('is-idle', !active || down);
  L.statusDot.classList.toggle('pulse', !!active && !down);
  setText(L.statusText, down ? 'Disconnected. Reconnecting, then catching up.' : active ? 'Streaming live' : 'Not running. Showing recorded output.');
  toggleHidden(L.statusAgo, !L.lastTs);
  if (L.lastTs) tickLogAgo();
}
function tickLogAgo() { if (L.statusAgo && L.lastTs) setText(L.statusAgo, ' · last line ' + fmtAgo(L.lastTs)); }

/* log rows */
function firstLine(text, max) {
  const i = text.indexOf('\n');
  const line = i >= 0 ? text.slice(0, i) : text;
  return line.length > max ? line.slice(0, max) + '…' : line;
}
function foldable(lead, text, limit) {
  const long = text.length > limit || (text.indexOf('\n') >= 0 && limit < 400) || text.split('\n').length > 10;
  if (!long) return h('span', null, lead, text);
  return h('details', { class: 'ev-fold' }, h('summary', null, lead, firstLine(text, limit > 400 ? 260 : 150)), h('pre', null, text));
}
function appendEv(parent, ev) {
  const group = ev.agent + '|' + ev.stage;
  if (group !== L.lastGroup) {
    L.lastGroup = group;
    parent.appendChild(h('div', { class: 'ev-div', data: { agent: ev.agent } },
      h('span', null, `${AGENT_LABEL[ev.agent] || ev.agent} · ${STAGE_LABEL[ev.stage] || ev.stage}`)));
  }
  const text = ev.text === undefined || ev.text === null ? '' : String(ev.text).slice(0, 20000);
  let body;
  switch (ev.kind) {
    case 'tool': {
      const lead = h('span', { class: 'ev-toolname' }, ev.tool || 'tool');
      body = text ? foldable(lead, text, 160) : lead;
      break;
    }
    case 'tool_result': {
      const lead = ev.ok === undefined ? null : h('span', { class: 'ev-ok' + (ev.ok ? '' : ' is-bad'), title: ev.ok ? 'Succeeded' : 'Failed' }, icon(ev.ok ? 'tick' : 'x', 'icon-sm'), sr(ev.ok ? 'Succeeded: ' : 'Failed: '));
      body = text ? foldable(lead, text, 160) : (lead || h('span', null, 'done'));
      break;
    }
    case 'text': body = foldable(null, text, 700); break;
    case 'thinking': body = foldable(h('span', { class: 'sr-only' }, 'Thinking: '), text, 160); break;
    case 'error': body = h('span', null, h('span', { class: 'sr-only' }, 'Error: '), text); break;
    case 'result': body = foldable(null, text, 700); break;
    default: body = foldable(null, text, 400); break;
  }
  const row = h('div', { class: 'ev', data: { agent: ev.agent, kind: ev.kind, seq: ev.seq, ok: ev.ok === undefined ? null : String(ev.ok) } },
    h('time', { class: 'ev-time', datetime: new Date(ev.ts).toISOString(), title: fmtFull(ev.ts) }, fmtClock(ev.ts)),
    h('span', { class: 'ev-who ag-' + ev.agent, title: `${AGENT_LABEL[ev.agent] || ev.agent} · ${STAGE_LABEL[ev.stage] || ev.stage}` }, icon(AGENT_ICON[ev.agent] || 'diamond'), sr(AGENT_LABEL[ev.agent] || ev.agent)),
    h('div', { class: 'ev-body' }, body));
  parent.appendChild(row);
}

/* ───────────────────────── markdown (DOM-only, safe subset) ───────────────────────── */
function mdInline(text) {
  const frag = document.createDocumentFragment();
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] !== undefined) frag.append(h('code', null, m[1]));
    else if (m[2] !== undefined) frag.append(h('strong', null, m[2]));
    else if (m[3] !== undefined) frag.append(h('em', null, m[3]));
    else {
      const href = safeHttp(m[5]);
      if (href) frag.append(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, m[4]));
      else frag.append(m[4] + ' (' + m[5] + ')');
    }
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
function mdSplitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}
const mdIsTableSep = (s) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s);
function mdStartsBlock(line) {
  return /^\s*```/.test(line) || /^#{1,6}\s/.test(line) || MD_LIST.test(line) || /^\s*>/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
}
function renderMarkdown(src) {
  const root = h('div', { class: 'md' });
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    let m;
    if (/^\s*```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      root.appendChild(h('pre', null, h('code', null, buf.join('\n'))));
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { root.appendChild(h('h' + m[1].length, null, mdInline(m[2]))); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.appendChild(h('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      root.appendChild(h('blockquote', null, Array.from(renderMarkdown(buf.join('\n')).childNodes)));
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && mdIsTableSep(lines[i + 1])) {
      const head = mdSplitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(mdSplitRow(lines[i++]));
      root.appendChild(h('div', { class: 'md-scroll' }, h('table', null,
        h('thead', null, h('tr', null, head.map((c) => h('th', null, mdInline(c))))),
        h('tbody', null, rows.map((r) => h('tr', null, head.map((_, ci) => h('td', null, mdInline(r[ci] || '')))))))));
      continue;
    }
    if (MD_LIST.test(line)) {
      const stack = [];
      while (i < lines.length) {
        const mm = MD_LIST.exec(lines[i]);
        if (!mm) {
          if (/^\s*$/.test(lines[i]) && i + 1 < lines.length && MD_LIST.test(lines[i + 1])) { i++; continue; }
          if (stack.length && /^\s{2,}\S/.test(lines[i]) && stack[stack.length - 1].lastLi) {
            stack[stack.length - 1].lastLi.append(' ', mdInline(lines[i].trim())); i++; continue;
          }
          break;
        }
        const indent = mm[1].replace(/\t/g, '    ').length;
        const ordered = /\d/.test(mm[2]);
        while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
        let top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          const el = h(ordered ? 'ol' : 'ul');
          if (top && top.lastLi) top.lastLi.appendChild(el); else root.appendChild(el);
          top = { indent, el, lastLi: null };
          stack.push(top);
        }
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(mm[3]);
        const li = h('li');
        if (task) li.append(task[1] === ' ' ? '☐ ' : '☑ ', mdInline(task[2]));
        else li.append(mdInline(mm[3]));
        top.el.appendChild(li);
        top.lastLi = li;
        i++;
      }
      continue;
    }
    const buf = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !mdStartsBlock(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && mdIsTableSep(lines[i + 1]))) buf.push(lines[i++].trim());
    root.appendChild(h('p', null, mdInline(buf.join(' '))));
  }
  return root;
}

/* ───────────────────────── plan tab ───────────────────────── */
const AC_TONE = { met: ['good', 'Met', 'tick'], not_met: ['bad', 'Not met', 'x-circle'], unverifiable: ['warn', 'Unverifiable', 'help'] };
function latestVerdict(d) {
  const vs = d.verdicts || [];
  return vs.length ? vs.reduce((a, b) => (b.loop > a.loop ? b : a)) : null;
}
function bulletList(items) { return h('ul', { class: 'kv-list' }, items.map((t) => h('li', null, t))); }
function renderPlan(d) {
  const p = d.plan; const md = d.planMarkdown; const rv = d.planReview;
  const root = h('div', { class: 'stack-lg' });
  if (d.canApprove) {
    if ((d.holdReasons || []).length) root.appendChild(h('div', { class: 'callout c-bad' }, icon('shield'), h('div', { class: 'callout-body' }, h('b', null, 'Why it is waiting'), bulletList(d.holdReasons))));
    root.appendChild(h('div', { class: 'sticky-ask' }, h('b', null, 'This plan is waiting for your approval.'),
      actBtn(d, 'approve', 'Approve plan', 'tick', 'btn-primary', () => actApprove(d.key))));
  }
  if (!p && !md) {
    root.appendChild(h('div', { class: 'empty-note' }, h('b', null, 'No plan yet'), 'Claude writes the plan as soon as the run starts planning. It appears here, and Conductor also adds it to the card as a note.'));
    return root;
  }
  if (p) {
    root.appendChild(h('div', { class: 'card-box stack' },
      h('p', null, p.summary),
      h('div', { class: 'row' },
        h('span', { class: 'chip' }, 'Size ' + (p.complexity || d.complexity || '?')),
        h('span', { class: 'chip' }, 'Plan rev ' + d.rev),
        h('span', { class: 'chip' }, plural((p.acceptanceCriteria || []).length, 'acceptance criterion', 'acceptance criteria')),
        h('span', { class: 'chip' }, plural((p.filesToChange || []).length, 'file')))));
    if (p.blocked && p.blocked.is) {
      root.appendChild(h('div', { class: 'callout c-bad' }, icon('alert'), h('div', { class: 'callout-body' },
        h('b', null, 'Claude is blocked and has questions'), bulletList(p.blocked.questions || []),
        h('p', { class: 'muted' }, 'Add your answer as a note on this card, then press Retry.'))));
    }
  }
  if (rv) {
    const ok = rv.decision === 'approved';
    root.appendChild(h('div', { class: 'callout ' + (ok ? 'c-good' : '') }, icon(ok ? 'shield' : 'warn'), h('div', { class: 'callout-body' },
      h('b', null, ok ? 'Plan review: approved' : 'Plan review: changes requested'), h('div', { class: 'pre' }, rv.summary),
      (rv.issues || []).length ? h('ul', { class: 'kv-list' }, rv.issues.map((i) => h('li', null, badge(i.severity === 'blocking' ? 'bad' : 'mute', i.severity), ' ', i.text))) : null)));
  }
  if (p && (p.acceptanceCriteria || []).length) {
    const lv = latestVerdict(d);
    const status = {};
    if (lv) for (const a of lv.verdict.acceptance || []) status[a.id] = a.status;
    root.appendChild(h('section', { class: 'sec' }, h('h3', null, 'Acceptance criteria'),
      h('ul', { class: 'ac-list' }, p.acceptanceCriteria.map((a) => {
        const t = status[a.id] ? AC_TONE[status[a.id]] : null;
        return h('li', { class: 'ac' }, h('span', { class: 'ac-id' }, a.id),
          h('div', null, h('p', { class: 'ac-text' }, a.text), t ? badge(t[0], t[1], t[2]) : null),
          h('p', { class: 'ac-sub' }, h('b', null, 'Verified by: '), a.verification));
      }))));
  }
  if (p && (p.filesToChange || []).length) {
    root.appendChild(h('section', { class: 'sec' }, h('h3', null, 'Files to change'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Action'), h('th', null, 'Change'))),
        h('tbody', null, p.filesToChange.map((f) => h('tr', null,
          h('td', null, h('code', null, f.path)), h('td', null, f.action), h('td', null, f.change + (f.reason ? ' — ' + f.reason : '')))))))));
  }
  const full = h('details', { class: 'sec details-sec', open: !p },
    h('summary', null, icon('chevron', 'chev'), 'Full plan'));
  if (md) full.appendChild(renderMarkdown(md));
  else if (p) {
    const sec = (title, body) => (body ? h('section', { class: 'sec' }, h('h3', null, title), body) : null);
    full.append(...[
      sec('Current state', p.currentState ? h('p', null, p.currentState) : null),
      sec('Expected state', p.expectedState ? h('p', null, p.expectedState) : null),
      sec('Assumptions', (p.assumptions || []).length ? bulletList(p.assumptions) : null),
      sec('Steps', (p.steps || []).length ? h('ol', { class: 'kv-list' }, p.steps.map((s) => h('li', null, s))) : null),
      sec('Testing', p.testing ? h('div', { class: 'stack' }, (p.testing.commands || []).map((c) => h('code', { class: 'cmd' }, c)), (p.testing.cases || []).length ? bulletList(p.testing.cases) : null) : null),
      sec('Risks', (p.risks || []).length ? bulletList(p.risks) : null)].filter(Boolean));
  }
  root.appendChild(full);
  return root;
}

/* ───────────────────────── tasks tab (runs that were split into tasks) ───────────────────────── */
const TASK_STATE = {
  done: ['good', 'Done', 'tick'], running: ['info', 'Working', 'code'], failed: ['bad', 'Failed', 'x-circle'],
  blocked: ['warn', 'Blocked', 'warn'], ready: ['mute', 'Ready', 'clock'], pending: ['mute', 'Waiting', 'clock'],
};
const ROLE_LABEL = { implementation: 'Build', documentation: 'Docs', requirements: 'Requirements', architecture: 'Architecture', context: 'Context' };
function renderTasks(d) {
  const g = d.graph;
  const root = h('div', { class: 'stack-lg' });
  if (!g) return root;
  const n = (s) => g.items.filter((i) => i.state === s).length;
  const failed = n('failed');
  root.appendChild(h('div', { class: 'card-box stack' },
    h('div', { class: 'row' },
      h('span', { class: 'chip' }, plural(g.items.length, 'task')),
      h('span', { class: 'chip' }, n('done') + ' done'),
      n('running') ? h('span', { class: 'chip' }, n('running') + ' working') : null,
      failed ? h('span', { class: 'chip' }, failed + ' failed') : null,
      n('blocked') ? h('span', { class: 'chip' }, n('blocked') + ' blocked') : null,
      h('span', { class: 'chip' }, 'Plan rev ' + g.rev)),
    h('p', { class: 'muted' }, 'The plan was split into tasks. Conductor builds them one at a time on one branch, in dependency order, and runs the quality gates after each one; the whole change is verified at the end.'),
    d.status === 'needs_human' && (failed || n('blocked'))
      ? h('p', null, h('b', null, 'Retry'), ' runs the failed and blocked tasks again; finished tasks and their commits are kept. Moving the card to To do does the same as Retry; to start over with a new plan, edit the card description (or stop the run, then Retry).')
      : null));
  root.appendChild(h('ol', { class: 'task-list' }, g.items.map((it) => {
    const st = TASK_STATE[it.state] || TASK_STATE.pending;
    return h('li', { class: 'task card-box stack' },
      h('div', { class: 'row' },
        h('span', { class: 'ac-id' }, it.id), h('b', null, it.title),
        h('span', { class: 'chip' }, ROLE_LABEL[it.role] || it.role),
        badge(st[0], st[1], st[2]),
        it.loop > 1 ? h('span', { class: 'chip' }, 'Attempt ' + it.loop + ' of ' + it.loopBudget) : null,
        it.commitSha ? h('code', { class: 'chip', title: it.commitSha }, it.commitSha.slice(0, 7)) : null),
      h('p', null, it.objective),
      it.dependsOn.length ? h('p', { class: 'ac-sub' }, h('b', null, 'After: '), it.dependsOn.join(', ')) : null,
      it.files.length ? h('p', { class: 'ac-sub' }, h('b', null, 'Files: '), ...it.files.flatMap((f, i) => [i ? ', ' : '', h('code', null, f)])) : null,
      it.criteria.length ? h('p', { class: 'ac-sub' }, h('b', null, 'Covers: '), it.criteria.join(', ')) : null,
      it.note ? h('div', { class: 'pre' }, it.note) : null);
  })));
  return root;
}

/* ───────────────────────── verification tab ───────────────────────── */
function gateOutcome(res) {
  if (!res) return null;
  if (res.timedOut) return { tone: 'warn', label: 'Timed out', ic: 'clock' };
  return res.exitCode === 0 ? { tone: 'good', label: 'Passed', ic: 'tick' } : { tone: 'bad', label: 'Failed', ic: 'x-circle' };
}
function gateCell(res, label) {
  if (!res) return h('td', { data: { label } }, h('span', { class: 'muted' }, 'Not run'));
  const o = gateOutcome(res);
  const bits = [fmtDur(res.durationMs)];
  if (o.tone !== 'good') bits.push(res.failureCount === null || res.failureCount === undefined ? 'output not parseable' : plural(res.failureCount, 'failure'));
  return h('td', { class: 'gate-cell', data: { label } },
    h('span', { class: 'status-line tone-' + o.tone }, icon(o.ic), o.label),
    h('small', null, bits.join(' · ')),
    res.outputTail && o.tone !== 'good' ? h('details', { class: 'out-details' }, h('summary', null, 'Output'), h('pre', null, res.outputTail)) : null);
}
function renderVerification(d) {
  const verdicts = d.verdicts || [];
  const gl = (d.gates && d.gates.loops) || [];
  const base = d.gates && d.gates.baseline;
  const loops = Array.from(new Set([...verdicts.map((v) => v.loop), ...gl.map((g) => g.loop)])).sort((a, b) => a - b);
  const root = h('div', { class: 'stack-lg' });
  if (!loops.length && !base) {
    root.appendChild(h('div', { class: 'empty-note' }, h('b', null, 'Nothing verified yet'),
      'After Cursor builds, the gates (tests, lint, types) run on the base commit and on the new code, then Claude checks each acceptance criterion. Results show up here per loop.'));
    if ((d.bugs || []).length) root.appendChild(bugTracker(d));
    return root;
  }
  if (S.verLoop === null || !loops.includes(S.verLoop)) S.verLoop = loops.length ? loops[loops.length - 1] : null;
  const sel = S.verLoop;
  const verdictOf = (n) => (verdicts.find((v) => v.loop === n) || {}).verdict || null;

  if (loops.length) {
    root.appendChild(h('fieldset', { class: 'seg' },
      h('legend', { class: 'sr-only' }, 'Verification loop'),
      loops.map((n) => {
        const v = verdictOf(n);
        return h('label', null, h('input', { type: 'radio', name: 'ver-loop', value: n, checked: n === sel, data: { fid: 'loop:' + n }, onchange: () => { S.verLoop = n; fillPanel('verification', renderVerification(S.detail)); } }),
          h('span', null, `Loop ${n}` + (v ? (v.verdict === 'pass' ? ' · pass' : ' · fail') : ' · running')));
      })));
  }
  const v = sel !== null ? verdictOf(sel) : null;
  if (v) {
    const pass = v.verdict === 'pass';
    root.appendChild(h('div', { class: 'verdict ' + (pass ? 'st-ready' : 'st-needs_human') }, icon(pass ? 'check' : 'x-circle'),
      h('div', null, h('b', null, `Loop ${sel}: ${pass ? 'Pass' : 'Fail'}`), h('p', null, v.summary))));
  } else if (sel !== null) {
    root.appendChild(h('div', { class: 'callout c-info' }, icon('info'), h('div', { class: 'callout-body' }, h('b', null, `Loop ${sel} has no verdict yet`), h('div', { class: 'pre' }, 'Claude is still checking, or the gates failed first.'))));
  }

  if (v && (v.acceptance || []).length) {
    const acText = {};
    for (const a of (d.plan && d.plan.acceptanceCriteria) || []) acText[a.id] = a.text;
    root.appendChild(h('section', { class: 'sec' }, h('h3', null, 'Acceptance criteria'), h('ul', { class: 'ac-list' }, v.acceptance.map((a) => {
      const t = AC_TONE[a.status] || ['mute', a.status, 'info'];
      return h('li', { class: 'ac' }, h('span', { class: 'ac-id' }, a.id),
        h('div', null, h('p', { class: 'ac-text' }, acText[a.id] || ''), badge(t[0], t[1], t[2])),
        a.evidence ? h('p', { class: 'ac-sub' }, h('b', null, 'Evidence: '), a.evidence) : null);
    }))));
  }

  const gr = gl.find((g) => g.loop === sel);
  const names = [];
  for (const r of (base ? base.results : [])) if (!names.includes(r.name)) names.push(r.name);
  for (const r of (gr ? gr.run.results : [])) if (!names.includes(r.name)) names.push(r.name);
  if (names.length) {
    const cmp = gr ? gr.comparison : null;
    const find = (run, n) => (run ? run.results.find((r) => r.name === n) : null);
    const resultCell = (n) => {
      if (!cmp) return h('td', { data: { label: 'Result' } }, h('span', { class: 'muted' }, 'No comparison yet'));
      const reg = (cmp.regressions || []).find((r) => r.gate === n);
      if (reg) return h('td', { data: { label: 'Result' } }, badge('bad', 'Regression', 'alert'),
        reg.note ? h('small', { class: 'muted' }, ' ' + reg.note) : null,
        (reg.newFailures || []).length ? h('div', { class: 'fail-list', 'aria-label': 'New failures' }, reg.newFailures.slice(0, 20).map((f) => h('code', null, f)),
          reg.newFailures.length > 20 ? h('small', { class: 'muted' }, `and ${reg.newFailures.length - 20} more`) : null) : null);
      if ((cmp.unverified || []).includes(n)) return h('td', { data: { label: 'Result' } }, badge('warn', 'Unverified', 'warn'), h('small', { class: 'muted' }, " Failing at baseline and the output can't be parsed, so new failures can't be ruled out."));
      if ((cmp.preExisting || []).includes(n)) return h('td', { data: { label: 'Result' } }, badge('mute', 'Pre-existing', 'minus-circle'), h('small', { class: 'muted' }, ' Already failing before this run, nothing new.'));
      if ((cmp.passed || []).includes(n)) return h('td', { data: { label: 'Result' } }, badge('good', 'Passed', 'tick'));
      return h('td', { data: { label: 'Result' } }, h('span', { class: 'muted' }, 'Not compared'));
    };
    root.appendChild(h('section', { class: 'sec' }, h('h3', null, 'Gates: baseline vs now'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table gate-table' },
        h('thead', null, h('tr', null, h('th', null, 'Gate'), h('th', null, 'Baseline (before)'), h('th', null, sel !== null ? `Loop ${sel} (now)` : 'Now'), h('th', null, 'Result'))),
        h('tbody', null, names.map((n) => {
          const r = find(gr && gr.run, n) || find(base, n);
          return h('tr', null,
            h('td', { data: { label: 'Gate' } }, h('span', { class: 'gate-name' }, n), r && r.cmd ? h('code', { class: 'gate-cmd' }, r.cmd) : null),
            gateCell(find(base, n), 'Baseline'), gateCell(find(gr && gr.run, n), 'Now'), resultCell(n));
        }))))));
  } else if (d.unverified) {
    root.appendChild(h('div', { class: 'callout' }, icon('warn'), h('div', { class: 'callout-body' }, h('b', null, 'No gates ran'), h('div', { class: 'pre' }, d.unverifiedWhy || 'This repo has no detected test, lint or type gates, so only Claude\'s read-through backs this result.'))));
  }

  if (v && (v.bugs || []).length) {
    root.appendChild(h('section', { class: 'sec' }, h('h3', null, `Bugs found in loop ${sel}`), h('div', { class: 'stack' }, v.bugs.map((b) => bugCard(b)))));
  } else if (v) {
    root.appendChild(h('section', { class: 'sec' }, h('h3', null, `Bugs found in loop ${sel}`), h('p', { class: 'muted' }, 'None.')));
  }
  if ((d.bugs || []).length) root.appendChild(bugTracker(d));
  return root;
}
const SEV_ICON = { blocker: 'x-circle', major: 'alert', minor: 'warn', nit: 'info' };
function sevBadge(s) { return h('span', { class: 'sev sev-' + s }, icon(SEV_ICON[s] || 'info'), s); }
function bugCard(b) {
  return h('article', { class: 'bug sev-' + b.severity },
    h('div', { class: 'bug-head' }, sevBadge(b.severity), h('span', { class: 'bug-title' }, b.title),
      b.file ? h('span', { class: 'bug-loc' }, b.file + (b.line ? ':' + b.line : '')) : null),
    b.evidence ? h('p', null, b.evidence) : null,
    b.repro ? h('details', { class: 'out-details' }, h('summary', null, 'How to reproduce'), h('pre', null, b.repro)) : null,
    b.suggestedFix ? h('details', { class: 'out-details' }, h('summary', null, 'Suggested fix'), h('pre', null, b.suggestedFix)) : null);
}
function bugTracker(d) {
  const open = d.bugs.filter((b) => b.status === 'open').length;
  return h('section', { class: 'sec' }, h('h3', null, `All tracked bugs (${open} open of ${d.bugs.length})`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table gate-table' },
      h('thead', null, h('tr', null, h('th', null, 'Severity'), h('th', null, 'Bug'), h('th', null, 'Status'), h('th', null, 'Card'), h('th', null, 'Seen in'))),
      h('tbody', null, d.bugs.map((b) => h('tr', null,
        h('td', { data: { label: 'Severity' } }, sevBadge(b.severity)),
        h('td', { data: { label: 'Bug' } }, b.title, b.file ? h('code', { class: 'gate-cmd' }, b.file) : null),
        h('td', { data: { label: 'Status' } }, b.status === 'open' ? badge('bad', 'Open', 'alert') : badge('good', 'Closed', 'tick')),
        h('td', { data: { label: 'Card' } }, b.itemKey ? h('code', null, b.itemKey) : h('span', { class: 'muted' }, 'not filed')),
        h('td', { data: { label: 'Seen in' } }, (b.loops || []).map((n) => 'loop ' + n).join(', ') || '')))))));
}

/* ───────────────────────── dialogs ───────────────────────── */
function confirmDialog(o) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    if (dlg.open) dlg.close(); // the previous confirm has already settled (from its submit); never stack two
    dlg.returnValue = '';
    const form = h('form', { method: 'dialog' },
      h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-confirm-title' }, o.title)),
      h('div', { class: 'dlg-body' }, h('p', null, o.body)),
      h('div', { class: 'dlg-foot' },
        h('button', { type: 'submit', class: 'btn', value: 'cancel', formnovalidate: true, autofocus: true }, o.cancelLabel || 'Cancel'),
        h('button', { type: 'submit', class: 'btn ' + (o.danger ? 'btn-danger-solid' : 'btn-primary'), value: 'ok' }, o.confirmLabel || 'Confirm')));
    dlg.replaceChildren(form);
    // settle from the submit itself (its submitter says which button) and, for Escape, from `close`; whichever comes first wins
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    form.addEventListener('submit', (e) => done(!!(e.submitter && e.submitter.value === 'ok')));
    dlg.addEventListener('close', () => done(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

function dlgShell(title, bodyNodes, footNodes, onSubmit, wide) {
  const dlg = $('#dlg');
  dlg.classList.toggle('dlg-wide', !!wide);
  const form = h('form', { novalidate: true, onsubmit: onSubmit },
    h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title' }, title),
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    h('div', { class: 'dlg-body' }, bodyNodes),
    h('div', { class: 'dlg-foot' }, footNodes));
  dlg.replaceChildren(form);
  return dlg;
}
function field(id, label, control, hint, extra) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint', id: id + '-hint' }, hint) : null, extra || null);
}

/* ───────────────────────── detected tools ───────────────────────── */
const TOOL_STATE = { ok: ['good', 'Ready'], 'not-logged-in': ['warn', 'Not signed in'], missing: ['bad', 'Not installed'], 'broken-install': ['bad', 'Broken install'], unknown: ['mute', 'Unknown'] };
function toolsNodes() {
  const ps = (S.state && S.state.providers) || [];
  if (!ps.length) return [];
  return [
    h('h3', { class: 'tools-title' }, 'Your tools', h('span', { class: 'muted' }, ' — found on this Mac automatically')),
    h('ul', { class: 'tool-list' }, ps.map((p) => {
      const st = TOOL_STATE[p.state] || TOOL_STATE.unknown;
      const roles = S.roles ? M.toolJobs(S.roles.roles, p.id) : '';
      return h('li', { class: 'tool' },
        h('span', { class: 'tool-name' }, icon(AGENT_ICON[p.id] || 'diamond'), p.label || p.id),
        badge(st[0], st[1]),
        h('span', { class: 'muted tool-d' }, [p.version ? 'v' + String(p.version).replace(/^v/, '') : '', p.state === 'ok' ? roles : (p.hint || p.detail || '')].filter(Boolean).join(' · ')));
    })),
  ];
}

/* ───────────────────────── research report (rendered in the Home thread) ───────────────────────── */
function renderReport(rp) {
  const tone = { opened: ['good', 'Opened'], listed: ['warn', 'Listed, not opened'], unverified: ['bad', 'Unverified'] };
  const out = [h('h3', null, 'Summary'), h('p', null, rp.summary)];
  if (rp.findings.length) out.push(h('h3', null, 'Findings'), h('ul', { class: 'kv-list' }, rp.findings.map((f) => h('li', null, badge(tone[f.status][0], tone[f.status][1]), ' ', f.claim,
    f.sources.length ? h('div', { class: 'muted' }, f.sources.map((x) => h('div', null, '— ', x.title || 'source', ' (', h('code', null, x.url), ') ', badge(tone[x.state][0], tone[x.state][1]), x.quote ? h('div', { class: 'ac-sub' }, '“' + x.quote + '”') : null))) : h('div', { class: 'muted' }, 'No usable source cited.')))));
  if (rp.alternatives.length) out.push(h('h3', null, 'Alternatives'), h('ul', { class: 'kv-list' }, rp.alternatives.map((a) => h('li', null, h('b', null, a.name), a.pros.length ? h('div', null, 'For: ' + a.pros.join('; ')) : null, a.cons.length ? h('div', null, 'Against: ' + a.cons.join('; ')) : null))));
  out.push(h('h3', null, 'Recommendation'), h('p', null, rp.recommendation));
  if (rp.steps.length) out.push(h('h3', null, 'Suggested next steps'), h('ol', { class: 'kv-list' }, rp.steps.map((x) => h('li', null, x))));
  out.push(h('h3', null, 'Limits of this report'), h('p', null, rp.limitations || 'None stated.'));
  if (rp.fetched.length || rp.searched.length) {
    // S14/F1: the lists are capped (100 / 50); the true totals say what is not shown
    const moreS = M.moreNote(rp.searchedTotal, rp.searched.length, 'searches');
    const moreF = M.moreNote(rp.fetchedTotal, rp.fetched.length, 'pages opened');
    out.push(h('details', null, h('summary', null, 'Everything it searched and opened'),
      rp.searched.length ? h('p', { class: 'muted' }, 'Searches: ' + rp.searched.join(' · ') + (moreS ? ' · ' + moreS : '')) : null,
      rp.fetched.length ? h('p', { class: 'muted' }, 'Opened: ' + rp.fetched.join(' · ') + (moreF ? ' · ' + moreF : '')) : null));
  }
  return out;
}

/* M8-U2: a research card's report, opened from the Board. Same DOM-only renderer as the Home thread; actions are the existing endpoints. */
const RESEARCH_DISCLAIMER = 'Written by a model from web sources — sources marked Opened were really fetched in this session; Listed only appeared in search results; Unverified could not be confirmed.';
function openResearchReport(id, opener) {
  const st = { rec: null, err: null, notFound: false, busy: '', actErr: '' };
  const body = h('div', { class: 'rr-body' });
  const foot = h('div', { class: 'rr-foot' });
  const dlg = dlgShell('Research report', [body], [foot], (e) => e.preventDefault(), true);
  const close = () => dlg.close();
  dlg.addEventListener('close', () => { if (opener && opener.isConnected) opener.focus(); }, { once: true });
  const draw = () => {
    const r = st.rec;
    const kids = [];
    if (st.notFound) kids.push(h('p', { class: 'muted' }, 'This report no longer exists.'));
    else if (st.err) kids.push(h('p', { class: 'err', role: 'alert' }, icon('warn'), h('span', null, st.err)), h('p', null, h('button', { type: 'button', class: 'btn btn-sm', onclick: load }, icon('refresh'), h('span', null, 'Try again'))));
    else if (!r) kids.push(h('p', { class: 'muted', role: 'status' }, 'Loading the report…'));
    else {
      kids.push(h('p', { class: 'rr-q' }, h('span', { class: 'muted' }, 'Question: '), r.question || ''));
      if (r.report) {
        kids.push(h('div', { class: 'doc' }, h('div', { class: 'doc-sec is-bare' }, renderReport(r.report)),
          h('div', { class: 'doc-sec' }, h('p', { class: 'muted' }, badge('warn', MODEL_LABEL, 'warn'), ' ', RESEARCH_DISCLAIMER))));
      } else kids.push(h('p', { class: 'muted' }, r.error || 'There is no report for this research.'));
      if (r.convertedTo) kids.push(h('p', null, 'Turned into task ', h('b', null, r.convertedTo), '.'));
      else if (r.report && !r.repo) kids.push(h('p', { class: 'muted' }, 'Choose a repository before asking if you want to turn the findings into an engineering plan.'));
    }
    if (st.actErr) kids.push(h('p', { class: 'err', role: 'alert' }, icon('warn'), h('span', null, st.actErr)));
    body.replaceChildren(...kids);
    const acts = [h('button', { type: 'button', class: 'btn', onclick: close }, 'Close')];
    if (r && r.status === 'done' && !r.convertedTo && !r.dismissedAt) {
      acts.push(h('button', { type: 'button', class: 'btn' + (st.busy === 'dismiss' ? ' is-busy' : ''), disabled: !!st.busy, onclick: doDismiss }, 'Dismiss'));
    }
    if (r && r.report && r.repo && !r.convertedTo) {
      acts.push(h('button', { type: 'button', class: 'btn btn-primary' + (st.busy === 'convert' ? ' is-busy' : ''), disabled: !!st.busy, onclick: doConvert }, icon('plus'), h('span', null, 'Turn into an engineering plan')));
    }
    foot.replaceChildren(...acts);
  };
  async function load() {
    st.err = null; st.notFound = false; draw();
    try { st.rec = await api('GET', '/api/asks/' + enc(id)); }
    catch (e) {
      if (e instanceof ApiFail && e.status === 401) return;
      if (e instanceof ApiFail && e.status === 404) st.notFound = true; else st.err = (e && e.message) || "Couldn't load the report.";
    }
    if (dlg.open) draw();
  }
  async function doDismiss() {
    st.busy = 'dismiss'; st.actErr = ''; draw();
    try { await api('POST', '/api/asks/' + enc(id) + '/dismiss', {}); toast('good', 'Report moved off the board.'); boardPoke(true); close(); return; }
    catch (e) { if (e instanceof ApiFail && e.status === 401) return; st.actErr = (e && e.message) || 'Something went wrong.'; }
    st.busy = ''; draw();
  }
  async function doConvert() {
    st.busy = 'convert'; st.actErr = ''; draw();
    try {
      const c = await api('POST', '/api/asks/' + enc(id) + '/convert');
      toast('good', 'Created ' + c.key + ' — its plan always waits for your approval.');
      loadState().catch(() => {}); boardPoke(true);
      st.rec = await api('GET', '/api/asks/' + enc(id));
    } catch (e) { if (e instanceof ApiFail && e.status === 401) return; st.actErr = (e && e.message) || 'Something went wrong.'; }
    st.busy = ''; draw();
  }
  draw();
  dlg.showModal();
  load();
}

function openNewTask() {
  const repos = (S.state && S.state.repos) || [];
  const idT = uid('nt'); const idD = uid('nt'); const idR = uid('nt');
  const err = h('p', { class: 'err form-error', role: 'alert', hidden: true });
  const showErr = (m) => { setText(err, m); err.hidden = false; };
  const title = h('input', { class: 'input', id: idT, type: 'text', maxlength: '200', autocomplete: 'off', placeholder: 'What should the agents do?', 'aria-describedby': idT + '-hint' });
  const desc = h('textarea', { class: 'textarea', id: idD, placeholder: 'Context, constraints, links. The more concrete, the better the plan.' });
  const repo = h('select', { class: 'select', id: idR }, repos.length > 1 ? h('option', { value: '' }, 'Choose a repository') : null, repos.map((r) => h('option', { value: r.name }, r.name)));
  if (repos.length === 1) repo.value = repos[0].name;
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create task');
  const cancel = h('button', { type: 'button', class: 'btn', onclick: () => $('#dlg').close() }, 'Cancel');
  const onSubmit = async (e) => {
    e.preventDefault();
    err.hidden = true; title.removeAttribute('aria-invalid');
    const t = title.value.trim();
    if (!t) { showErr('Give the task a title.'); title.setAttribute('aria-invalid', 'true'); title.focus(); return; }
    if (repos.length > 1 && !repo.value) { showErr('Choose which repository this task belongs to.'); repo.focus(); return; }
    if (!repos.length) { showErr('Add a repository first (Settings, then Repositories and setup).'); return; }
    setBusy(submit, true); cancel.disabled = true;
    const body = { title: t };
    if (desc.value.trim()) body.description = desc.value.trim();
    if (repo.value) body.repo = repo.value;
    try {
      const r = await api('POST', '/api/tasks', body);
      $('#dlg').close();
      toast('good', `Created ${r.key} in To do. Conductor starts on it right away.`);
      loadState().catch(() => {});
    } catch (ex) {
      showErr(ex.message);
      setBusy(submit, false); cancel.disabled = false;
    }
  };
  const dlg = dlgShell('New task', [
    h('p', { class: 'muted', id: idT + '-intro' }, 'Creates a card in To do. Conductor plans it, builds it and verifies it without further input.'),
    field(idT, 'Title', title),
    field(idD, 'Description', desc, 'Optional, but the plan is only as good as the brief.'),
    repos.length
      ? field(idR, 'Repository', repo, repos.length > 1 ? 'Where the code lives. Conductor works in a separate worktree, never in your checkout.' : null)
      : h('div', { class: 'callout' }, icon('warn'), h('div', { class: 'callout-body' }, h('b', null, 'No repository registered'), h('div', { class: 'pre' }, 'Add a repository in setup first, so Conductor knows where to work.'))),
    err,
  ], [h('span', { class: 'spacer' }), cancel, submit], onSubmit);
  dlg.showModal();
  title.focus();
}

/**
 * M8-3 Settings → "Accounts and limits": every sign-in of each tool in the order Conductor tries them. Actions apply at once (they are not part of
 * Save). Labels via text nodes only; no email, no path; the sign-in command is built by the server from constants + the id.
 */
function accountsPanel() {
  const root = h('div', { class: 'acct-panel' });
  const err = h('p', { class: 'err', role: 'alert', hidden: true });
  const act = async (fn, ok) => {
    err.hidden = true;
    try { await fn(); if (ok) toast('good', ok); } catch (e) { setText(err, (e && e.message) || 'Something went wrong.'); err.hidden = false; }
    try { await loadState(); } catch { /* keep the old view */ }
    fill();
  };
  const reorder = (tool, id, dir) => {
    const ids = accountsOf(tool).map((a) => a.id);
    const i = ids.indexOf(id); const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return act(() => api('PUT', '/api/accounts/order', { provider: tool, ids }));
  };
  const toolSel = h('select', { class: 'select', 'aria-label': 'Tool' }, h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'cursor' }, 'Cursor'));
  const nameIn = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'A short name, e.g. Work', 'aria-label': 'Account name', autocomplete: 'off' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => {
    const name = nameIn.value.trim();
    if (!name) { setText(err, 'Give the account a short name.'); err.hidden = false; nameIn.focus(); return; }
    act(async () => { await api('POST', '/api/accounts', { provider: toolSel.value, name }); nameIn.value = ''; }, 'Account added. It is not signed in yet.');
  } }, icon('plus'), h('span', null, 'Add account'));
  const fill = () => {
    const list = S.state.accounts;
    if (!list) { root.replaceChildren(h('p', { class: 'muted' }, 'This Conductor does not support several accounts per tool.')); return; }
    const tools = ['claude', 'cursor', ...(acctShown({ provider: 'codex' }) ? ['codex'] : [])];
    root.replaceChildren(
      ...tools.map((tool) => {
        const rows = accountsOf(tool);
        return h('div', { class: 'acct-tool' }, h('h4', null, AGENT_LABEL[tool] || tool),
          h('ol', { class: 'acct-list' }, rows.map((a, i) => h('li', { class: 'acct-row' },
            h('span', { class: 'acct-name' }, a.isDefault ? a.name + ' (your sign-in)' : a.name), acctStatusNode(a),
            a.provider === 'cursor' && a.buildReady === false ? h('span', { class: 'chip', title: 'Builds on added Cursor accounts stay off until their build isolation is checked' }, 'Read-only work only') : null,
            h('span', { class: 'spacer' }),
            h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Move ' + a.name + ' up', disabled: i === 0, onclick: () => reorder(tool, a.id, 'up') }, icon('arrow-up')),
            h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm acct-down', 'aria-label': 'Move ' + a.name + ' down', disabled: i === rows.length - 1, onclick: () => reorder(tool, a.id, 'down') }, icon('arrow-up')),
            a.isDefault || tool === 'codex' ? null : h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => act(() => api('POST', `/api/accounts/${enc(a.id)}/check`, {})) }, 'Check'),
            a.isDefault ? null : h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => {
              if (!window.confirm(`Remove ${acctLabel(a)}? Conductor signs it out, deletes its private folder and restarts any step running on it.`)) return;
              act(async () => { const r = await api('DELETE', `/api/accounts/${enc(a.id)}`); if (r && r.note) toast('warn', r.note); }, 'Account removed.');
            } }, 'Remove'),
            !a.isDefault && a.status === 'not-signed-in' ? h('p', { class: 'muted acct-signin' }, 'Signing in extra accounts is not enabled yet (awaiting a live check). Later: ', h('code', null, a.signInCommand)) : null,
            a.note ? h('p', { class: 'muted' }, a.note) : null))));
      }),
      h('div', { class: 'acct-add' }, h('h4', null, 'Add an account'),
        h('div', { class: 'row-2' }, toolSel, nameIn), addBtn,
        h('ul', { class: 'muted acct-disclose' },
          h('li', null, 'The account signs in with the tool\'s own login and keeps it in a private folder under the Conductor home. For Cursor this is a plaintext file (auth.json, 0600), not the Keychain: code that the Cursor builder or repository checks run can read it as your user, just as it can read your other files. Add only accounts you accept that for, and revoke sessions if a build looked hostile.'),
          h('li', null, 'Under "Next account, then another tool", work from any project may run on any listed account, including a personal one. If a project must stay on one organisation\'s account, choose "same tool" or "wait", or do not add the account.'),
          h('li', null, 'Removing an account deletes its folder and tries to sign it out; Claude may keep a Keychain item for a folder that no longer exists.'),
          h('li', null, 'Builds on added Cursor accounts stay off until their build isolation is checked; repositories that need a private registry or an SSH remote may fail on them later.'))),
      err);
  };
  fill();
  return { el: root, fill };
}

/** The server supports the M8-3 limit rule (feature detection). */
const cur0 = (st) => typeof st.limitRule === 'string';
function openSettings(focus) {
  const s = S.state.settings;
  const sel = (opts, val) => { const el = h('select', { class: 'select' }, opts.map(([v, l]) => h('option', { value: v }, l))); el.value = val; return el; };
  const num = (min, max, val) => h('input', { class: 'input', type: 'number', min, max, step: '1', inputmode: 'numeric', value: String(val) });
  const c = {
    planApproval: sel([['auto', 'Automatic'], ['first', 'Ask for the first plan in each repo'], ['manual', 'Ask for every plan']], s.planApproval),
    planReview: sel([['off', 'Off'], ['auto', 'Only for medium and large plans'], ['always', 'Always']], s.planReview),
    maxLoops: num(1, 10, s.maxLoops),
    maxParallel: num(1, 8, s.maxParallel),
    onClaudeLimit: sel([['wait', 'Wait until the limit resets'], ['cursor', 'Use Cursor for read-only stages']], s.onClaudeLimit),
    noGates: sel([['warn', 'Continue, marked Unverified'], ['block', 'Block the run']], s.noGates),
    limitRule: sel(Object.entries(M.LIMIT_RULE_LABEL), s.limitRule || 'switch'),
  };
  const ruleHint = h('p', { class: 'muted', role: 'status' });
  const syncRuleHint = () => {
    const eff = s.limitRuleEffective && s.limitRuleEffective !== c.limitRule.value && c.limitRule.value === s.limitRule ? s.limitRuleEffective : c.limitRule.value;
    setText(ruleHint, (M.LIMIT_RULE_HINT[c.limitRule.value] || '') + (eff !== c.limitRule.value ? ' The run mode currently applies "' + M.LIMIT_RULE_LABEL[eff] + '".' : ''));
  };
  c.limitRule.addEventListener('change', syncRuleHint);
  syncRuleHint();
  const accts = accountsPanel();
  const err = h('p', { class: 'err form-error', role: 'alert', hidden: true });
  const showErr = (m) => { setText(err, m); err.hidden = false; };
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes');
  const fld = (label, control, hint) => { const id = uid('st'); control.id = id; return field(id, label, control, hint); };
  const group = (legend, ...kids) => h('fieldset', { class: 'set-group' }, h('legend', { class: 'legend' }, legend), kids);

  /* Who does what: seven rows, a draft until Save (the server's role chains are the truth; reasons are shown verbatim) */
  const draft = {}; // row id → provider id the user picked
  const editors = {}; // M8-2: row id → model editor
  let toolDefs = null; // M8-2: "Default model for each tool"
  const tdHolder = h('div');
  const whoList = h('div', { class: 'who-list' });
  const limitNote = h('p', { class: 'warn-note', role: 'status', hidden: true });
  const syncLimitNote = () => {
    const ro = ['plan', 'review', 'verify'].filter((id) => draft[id] === 'cursor');
    const show = c.onClaudeLimit.value === 'cursor' && ro.length > 0;
    toggleHidden(limitNote, !show);
    if (show) setText(limitNote, ro.map((id) => M.ROLE_ROWS.find((r) => r.id === id).label).join(', ') + ' now starts on Cursor, so it has no Claude limit to wait for.');
  };
  c.onClaudeLimit.addEventListener('change', syncLimitNote);
  const fillWho = () => {
    if (!S.roles) {
      whoList.replaceChildren(S.rolesErr
        ? h('div', { class: 'who-err' }, h('p', { class: 'err', role: 'alert' }, "Couldn't load who does what: " + S.rolesErr.message),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: async () => { S.rolesErr = null; whoList.replaceChildren(h('p', { class: 'muted' }, 'Loading…')); await loadRoles(); fillWho(); } }, icon('refresh'), h('span', null, 'Try again')))
        : h('p', { class: 'muted' }, 'Loading…'));
      return;
    }
    const { roles, choices } = S.roles;
    const views = S.roles.roleViews || {};
    whoList.replaceChildren(...M.ROLE_ROWS.map((row) => {
      const lead = M.leadOf(roles, row.role);
      const ch = choices[row.role] || {};
      const note = h('p', { class: 'muted who-note', role: 'status' });
      const items = Object.keys(ch).map((id) => ({ id, label: provLabel(id), locked: !ch[id].ok, reason: ch[id].reason || '', title: ch[id].ok ? (ch[id].needsAck ? 'Isolation not verified on this machine: Conductor asks you to confirm on Save' : null) : ch[id].reason || 'Not available for this job' }));
      // the tool the model choice is judged against: Claude for Deep Research (it only runs there today), else the lead
      const selTool = row.id === 'research' ? 'claude' : lead;
      const ed = modelEditor({ row, tool: selTool, entry: roles[row.role], view: views[row.role] });
      editors[row.id] = ed;
      const pills = pillGroup({ label: 'Tool for ' + row.label, items, value: draft[row.id] || lead,
        onPick: (id) => { if (id === lead) delete draft[row.id]; else draft[row.id] = id; pills.set(id); setText(note, ''); syncLimitNote(); if (row.id !== 'research') ed.setTool(id); },
        onLocked: (it) => setText(note, it.label + ': ' + it.reason) });
      const extra = [];
      if (row.id === 'research') extra.push("Deep Research always runs on Claude's web-only research profile today, so this job cannot be moved to another tool yet.");
      const abc = roles[row.role] && roles[row.role].autoByComplexity;
      if (abc && Object.keys(abc).length) extra.push('Some plan sizes use a different tool first (set in the config file).');
      return h('div', { class: 'who-row' },
        h('div', { class: 'who-main' }, h('div', { class: 'who-title' }, row.label), h('div', { class: 'who-hint' }, row.hint),
          ...extra.map((x) => h('div', { class: 'who-hint' }, x))),
        h('div', { class: 'who-ctl' }, pills.el),
        ed.el,
        note);
    }));
    toolDefs = toolDefaultsEditor();
    tdHolder.replaceChildren(toolDefs.el);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const next = {
      planApproval: c.planApproval.value, planReview: c.planReview.value,
      maxLoops: Number(c.maxLoops.value), maxParallel: Number(c.maxParallel.value),
      onClaudeLimit: c.onClaudeLimit.value, noGates: c.noGates.value,
      ...(cur0(s) ? { limitRule: c.limitRule.value } : {}),
    };
    const cur = S.state.settings;
    const patch = {};
    for (const k of Object.keys(next)) if (next[k] !== cur[k]) patch[k] = next[k];
    const roleChanges = Object.assign({}, draft);
    const sels = {};
    for (const id of Object.keys(editors)) { const v = editors[id].value(); if (v) sels[id] = v; }
    const tm = toolDefs ? toolDefs.value() : null;
    const whoChanged = Object.keys(roleChanges).length || Object.keys(sels).length || !!tm;
    if (!Object.keys(patch).length && !whoChanged) { $('#dlg').close(); return; }
    if (!Number.isInteger(next.maxLoops) || next.maxLoops < 1 || next.maxLoops > 10) { showErr('Fix loops must be a whole number from 1 to 10.'); c.maxLoops.focus(); return; }
    if (!Number.isInteger(next.maxParallel) || next.maxParallel < 1 || next.maxParallel > 8) { showErr('Parallel runs must be a whole number from 1 to 8.'); c.maxParallel.focus(); return; }
    setBusy(submit, true);
    // 1. settings (no `stages`: roles are edited directly below, so nothing here can overwrite them)
    if (Object.keys(patch).length) {
      try { await api('PUT', '/api/settings', patch); await loadState(); }
      catch (ex) { showErr(ex.message); setBusy(submit, false); return; }
    }
    // 2. roles, recomputed from a fresh GET (onClaudeLimit may just have changed the chains)
    if (whoChanged) {
      const r = await applyRoleChanges(roleChanges, sels, tm);
      if (!r.ok) {
        const why = r.canceled ? 'You did not confirm the tool change.' : r.error || 'Something went wrong.';
        showErr(Object.keys(patch).length ? 'Your other settings were saved. Who does what was not changed: ' + why : 'Who does what was not changed: ' + why);
        setBusy(submit, false);
        // "Save refused with focus" (M8-2): the server names the control
        const fr = fieldRow(r.field);
        if (fr && editors[fr.row]) { editors[fr.row].showError(r.error || ''); editors[fr.row].focus(fr.key); }
        else { const tmf = /^toolModels\.(claude|cursor|codex)/.exec(String(r.field || '')); if (tmf && toolDefs) toolDefs.focus(tmf[1]); }
        return;
      }
    }
    $('#dlg').close();
    toast('good', 'Settings saved.');
    loadState().catch(() => {});
  };
  const signOut = h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* cookie may already be gone */ }
    $('#dlg').close(); showExpired();
  } }, icon('logout'), h('span', null, 'Sign out'));
  const dlg = dlgShell('Settings', [
    group('Planning',
      fld('Plan approval', c.planApproval, 'Automatic starts building as soon as the plan is written. Large plans always ask.'),
      fld('Plan review', c.planReview, 'A second pass checks the plan before anything is built.')),
    group('Who does what',
      h('p', { class: 'who-intro' }, 'Pick the tool, the model and how hard it should think for each job. Each tool names its models and levels differently, so the choices change with the tool. Some tools cannot take some jobs yet; the reason is shown when you pick one. These are global settings: they apply to every request and every card.'),
      whoList, tdHolder),
    h('div', { id: 'set-accounts' }, group('Accounts and limits',
      fld('At a usage limit', c.limitRule), ruleHint,
      fld('When Claude hits its usage limit (which tools a job may use)', c.onClaudeLimit, 'Adds or removes Cursor as the fallback of the read-only jobs. With "same tool" or "wait" it is used only when Claude cannot run at all.'), limitNote,
      accts.el)),
    group('Limits',
      h('div', { class: 'row-2' }, fld('Fix loops', c.maxLoops, 'Build and verify rounds before Conductor asks you.'), fld('Parallel runs', c.maxParallel, 'Runs working at the same time.')),
      fld('When a repo has no tests or lint', c.noGates, 'Unverified runs are flagged on the board.')),
    err,
  ], [signOut, h('button', { type: 'button', class: 'btn', onclick: () => { $('#dlg').close(); navigate('#/setup'); } }, icon('folder'), h('span', null, 'Repositories and setup')),
    h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn', onclick: () => $('#dlg').close() }, 'Cancel'), submit], onSubmit, true);
  fillWho();
  dlg.showModal();
  if (focus === 'accounts') { const g = dlg.querySelector('#set-accounts'); if (g) g.scrollIntoView({ block: 'start' }); }
  loadRoles().then(() => { if (dlg.open && !Object.keys(draft).length && !Object.values(editors).some((e) => e.value())) fillWho(); });
}

/* ───────────────────────── setup wizard ───────────────────────── */
const WIZ_STEPS = [['agents', 'Agents'], ['repo', 'Repository']];
const STEP_HINT = {
  agents: 'Check that Claude Code and the Cursor CLI are ready',
  repo: 'Pick the project folder agents will work in',
};
const W = {
  sig: '', inited: false, open: null,
  probe: { claude: null, cursor: null }, probing: { claude: false, cursor: false },
  repoPath: '', repoName: '', repoErr: '', repoBusy: false, lastRepo: null, removeErr: '',
};
const stepOk = (id) => { const s = S.state.setup.steps.find((x) => x.id === id); return !!(s && s.ok); };
const firstOpenStep = () => { const f = WIZ_STEPS.find(([id]) => !stepOk(id)); return f ? f[0] : null; };
const rerenderWizard = () => renderWizard(true);
const focusWiz = (id) => { const el = $('#view [data-focus="' + id + '"]'); if (el && !el.disabled) el.focus({ preventScroll: false }); };
const advanceWizard = () => { W.open = firstOpenStep(); };
const df = (id) => ({ focus: id });

function renderWizard(force) {
  if (S.view !== 'wizard' || !S.state) return;
  const st = S.state;
  const sig = JSON.stringify([st.setup, st.health, st.repos, st.providers, S.route.view, S.roles && S.roles.roles]);
  if (!force && sig === W.sig) return;
  W.sig = sig;
  if (!W.inited) { W.inited = true; W.open = firstOpenStep(); }
  const view = $('#view');
  const act = document.activeElement;
  const fid = act && view.contains(act) ? act.getAttribute('data-focus') : null;
  const done = WIZ_STEPS.filter(([id]) => stepOk(id)).length;
  const complete = st.setup.complete;
  const root = h('div', { class: 'wizard' },
    h('div', { class: 'wiz-head' },
      complete ? h('p', null, h('a', { class: 'btn btn-sm', href: '#/board' }, icon('chevron', 'icon-back'), 'Back to board')) : null,
      h('h1', { id: 'wiz-h' }, complete ? 'Setup and repositories' : 'Set up Conductor'),
      h('p', null, complete
        ? 'Everything is connected. Add another repository or re-check a step.'
        : 'Two short steps. Conductor never pushes or merges code, and everything stays on this computer.'),
      h('div', { class: 'wiz-progress' },
        h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(WIZ_STEPS.length), 'aria-valuenow': String(done), 'aria-label': 'Setup progress' },
          (() => { const f = h('span'); f.style.setProperty('--pct', (done / WIZ_STEPS.length) * 100 + '%'); return f; })()),
        h('span', null, `${done} of ${WIZ_STEPS.length} done`))),
    h('section', { class: 'tools tools-wiz', 'aria-label': 'Detected tools' }, ...toolsNodes()),
    h('ol', { class: 'steps' }, WIZ_STEPS.map(([id, title], idx) => wizStep(id, title, idx))),
    done === WIZ_STEPS.length ? h('section', { class: 'wiz-done', 'aria-labelledby': 'wiz-done-h' },
      h('h2', { id: 'wiz-done-h' }, 'You are set up'),
      h('p', null, 'Press New task on the board. Conductor plans it, Cursor builds it, Claude verifies it.'),
      h('a', { class: 'btn btn-primary', href: '#/board', 'data-focus': 'go-board' }, 'Go to the board')) : null);
  view.replaceChildren(root);
  if (fid) { const el = view.querySelector('[data-focus="' + CSS.escape(fid) + '"]'); if (el) el.focus({ preventScroll: true }); }
}

function wizStep(id, title, idx) {
  const step = S.state.setup.steps.find((s) => s.id === id) || { ok: false };
  const ok = !!step.ok;
  const open = W.open === id;
  const current = !ok && firstOpenStep() === id;
  const bodyId = 'step-body-' + id;
  const status = ok ? (step.detail || 'Done') : (step.detail || STEP_HINT[id]);
  const head = h('button', { type: 'button', class: 'step-head', 'aria-expanded': String(open), 'aria-controls': bodyId, data: df('head:' + id), onclick: () => { W.open = open ? null : id; rerenderWizard(); } },
    h('span', { class: 'step-mark' }, ok ? icon('tick') : String(idx + 1)),
    h('span', { class: 'step-titles' }, h('span', { class: 'step-title' }, sr(ok ? 'Done: ' : 'To do: '), title), h('span', { class: 'step-sub' }, status)),
    icon('chevron', 'chev'));
  const li = h('li', { class: 'step' + (ok ? ' is-done' : '') + (current ? ' is-current' : '') }, head);
  if (open) li.appendChild(h('div', { class: 'step-body', id: bodyId, role: 'group', 'aria-label': title }, wizBody(id, step)));
  return li;
}
function wizBody(id, step) {
  if (id === 'agents') return agentsBody(step);
  return repoBody(step);
}
function nextBtn(label, id) {
  return h('button', { type: 'button', class: 'btn btn-primary', data: df('next:' + id), onclick: () => { W.open = id; rerenderWizard(); } }, label);
}
function inlineErr(msg) { return msg ? h('p', { class: 'err', role: 'alert' }, icon('warn'), h('span', null, msg)) : null; }

/* step 1: agents */
async function probeAgent(target) {
  W.probing[target] = true; W.probe[target] = null; rerenderWizard();
  try {
    const r = await api('POST', '/api/setup/probe', { target });
    W.probe[target] = { ok: !!r.ok, detail: r.detail || '', ms: r.durationMs };
  } catch (e) { W.probe[target] = { ok: false, detail: e.message }; }
  W.probing[target] = false; rerenderWizard();
}
async function probeBoth() { await probeAgent('claude'); await probeAgent('cursor'); }
function agentsBody() {
  const hl = S.state.health || {};
  const card = (id, name, a) => {
    a = a || { found: false, ok: false };
    const pr = W.probe[id];
    let hint = '';
    if (!a.found) hint = id === 'claude'
      ? 'Claude Code was not found on your PATH. Install it, run `claude` once to sign in, then press Re-check.'
      : 'The Cursor CLI (`agent`) was not found on your PATH. Install it and sign in, then press Re-check.';
    else if (a.loggedIn === false) hint = `${name} is installed but not signed in. Open a terminal, sign in, then press Re-check.`;
    const probeBtn = h('button', { type: 'button', class: 'btn btn-sm' + (W.probing[id] ? ' is-busy' : ''), disabled: W.probing[id] || !a.found, data: df('probe:' + id), onclick: () => probeAgent(id) }, W.probing[id] ? 'Testing…' : 'Test ' + name.split(' ')[0]);
    return h('div', { class: 'agent-card' },
      h('span', { class: 'agent-ic ag ag-' + id }, icon(AGENT_ICON[id])),
      h('h3', null, name, ' ',
        a.found ? h('span', { class: 'chip' }, a.version ? 'v' + a.version : 'Installed') : badge('bad', 'Not found', 'x-circle'),
        a.found ? (a.loggedIn === false ? badge('warn', 'Not signed in', 'warn') : a.ok ? badge('good', 'Ready', 'tick') : badge('warn', 'Needs attention', 'warn')) : null),
      h('p', { class: 'detail' }, [hint, a.detail].filter(Boolean).join(' ') || (a.ok ? 'Found and ready.' : '')),
      pr ? h('p', { class: 'probe ' + (pr.ok ? 'ok' : 'bad'), role: 'status' }, icon(pr.ok ? 'tick' : 'x-circle', 'icon-sm'), ' ', pr.detail || (pr.ok ? 'Answered.' : 'No answer.'), pr.ms ? ` (${(pr.ms / 1000).toFixed(1)} s)` : '') : null,
      probeBtn);
  };
  return h('div', null,
    h('p', null, 'Conductor drives the Claude Code and Cursor command-line tools already on this Mac. Nothing is installed or changed.'),
    card('claude', 'Claude Code', hl.claude),
    card('cursor', 'Cursor agent', hl.cursor),
    h('p', { class: 'hint muted' }, 'Testing sends one tiny prompt to the agent, so it may use a very small amount of your usage quota.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-primary', disabled: W.probing.claude || W.probing.cursor, data: df('probe:both'), onclick: probeBoth }, 'Test both agents'),
      h('button', { type: 'button', class: 'btn', data: df('recheck'), onclick: async (e) => { setBusy(e.currentTarget, true); try { await loadState(); } catch (er) { toast('error', er.message); } rerenderWizard(); } }, icon('refresh'), h('span', null, 'Re-check')),
      stepOk('agents') ? nextBtn('Continue to repository', 'repo') : null));
}

/* step 2: repository */
async function addRepo() {
  const path = W.repoPath.trim(); const name = W.repoName.trim();
  if (!path) { W.repoErr = 'Paste the folder path of a git repository.'; rerenderWizard(); return; }
  if (!/^(\/|~)/.test(path)) { W.repoErr = 'Use the full path, starting with / or ~ (for example /Users/you/code/my-app).'; rerenderWizard(); return; }
  W.repoBusy = true; W.repoErr = ''; W.lastRepo = null; rerenderWizard();
  try {
    const r = await api('POST', '/api/setup/repo', name ? { path, name } : { path });
    W.lastRepo = r.repo || null; W.repoPath = ''; W.repoName = '';
    await loadState();
    advanceWizard();
    if (S.state.setup.complete) toast('good', 'Setup complete. Press New task to start.');
  } catch (e) { W.repoErr = e.message; }
  W.repoBusy = false; rerenderWizard();
  if (W.repoErr) focusWiz('repo-path');
}
async function removeRepo(name) {
  const ok = await confirmDialog({ title: `Remove ${name}?`, body: 'Conductor forgets this repository. The folder and its worktrees are not touched.', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  W.removeErr = '';
  try { await api('DELETE', '/api/setup/repo/' + enc(name)); await loadState(); } catch (e) { W.removeErr = e.message; }
  rerenderWizard();
}
function repoBody() {
  const repos = S.state.repos || [];
  const idP = uid('repo'); const idN = uid('repo');
  const path = h('input', { class: 'input mono', id: idP, type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '/Users/you/code/my-app', value: W.repoPath, 'aria-describedby': idP + '-hint', 'aria-invalid': W.repoErr ? 'true' : null, disabled: W.repoBusy, data: df('repo-path'), oninput: (e) => { W.repoPath = e.target.value; } });
  const name = h('input', { class: 'input', id: idN, type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Defaults to the folder name', value: W.repoName, disabled: W.repoBusy, data: df('repo-name'), oninput: (e) => { W.repoName = e.target.value; } });
  const form = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); addRepo(); } },
    h('div', { class: 'field' }, h('label', { for: idP }, 'Repository folder'), path,
      h('p', { class: 'hint', id: idP + '-hint' }, 'The folder that contains .git. Tip: in Finder, right-click the folder, hold Option, and choose Copy as Pathname.'),
      inlineErr(W.repoErr)),
    h('div', { class: 'field' }, h('label', { for: idN }, 'Name (optional)'), name),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-primary' + (W.repoBusy ? ' is-busy' : ''), disabled: W.repoBusy, data: df('repo-add') }, W.repoBusy ? 'Checking…' : 'Add repository')));
  const list = repos.map((r) => h('div', { class: 'repo-row' },
    h('b', null, r.name),
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-danger', 'aria-label': 'Remove ' + r.name, data: df('rm:' + r.name), onclick: () => removeRepo(r.name) }, 'Remove'),
    h('span', { class: 'path' }, r.path),
    h('div', { class: 'chip-list' },
      h('span', { class: 'chip chip-mono' }, icon('branch'), r.baseBranch),
      (r.gates || []).length ? r.gates.map((g) => h('span', { class: 'chip', title: g.cmd }, icon('shield'), g.name)) : badge('warn', 'No gates detected', 'warn'),
      r.approvedPlans ? h('span', { class: 'chip' }, plural(r.approvedPlans, 'approved plan')) : null),
    (r.warnings || []).map((w) => h('p', { class: 'muted' }, w))));
  return h('div', null,
    h('p', null, 'Pick a project folder the agents may work on. Conductor never edits your checkout: every task runs in its own git worktree.'),
    repos.length ? h('div', { role: 'list', 'aria-label': 'Registered repositories' }, list) : null,
    inlineErr(W.removeErr),
    W.lastRepo && !W.repoErr ? h('div', { class: 'callout c-good' }, icon('check'), h('div', { class: 'callout-body' }, h('b', null, `Added ${W.lastRepo.name}`),
      h('div', { class: 'pre' }, (W.lastRepo.gates || []).length ? 'Detected gates: ' + W.lastRepo.gates.map((g) => g.name).join(', ') + '.' : 'No test, lint or type gates were detected, so runs here will be marked Unverified.'))) : null,
    h('h3', null, repos.length ? 'Add another repository' : 'Add your first repository'),
    form);
}

/* ───────────────────────── boot ───────────────────────── */
function showLoadError(e) {
  S.view = 'error';
  const view = $('#view');
  view.setAttribute('aria-busy', 'false');
  view.replaceChildren(h('section', { class: 'empty', role: 'alert' },
    h('h1', null, "Can't load the dashboard"), h('p', null, e && e.message ? e.message : 'Conductor did not answer.'),
    h('div', { class: 'row' }, btn('Try again', { cls: 'btn-primary', icon: 'refresh', onclick: () => boot() }))));
  clearTimeout(showLoadError.t);
  showLoadError.t = setTimeout(() => { if (S.view === 'error' && !S.expired) boot(); }, 6000);
}
async function boot() {
  try { await loadState(); connectSSE(); }
  catch (e) { if (!S.expired) showLoadError(e); }
}
function init() {
  const mq = matchMedia('(max-width: 640px)');
  S.isMobile = mq.matches;
  mq.addEventListener('change', (e) => { S.isMobile = e.matches; B.order = ''; if (S.state && S.view === 'board') updateBoard(); });
  buildHeader();
  renderConn();
  $('#view').addEventListener('click', onViewClick);
  window.addEventListener('hashchange', applyRoute);
  const drawer = $('#drawer');
  drawer.addEventListener('cancel', (e) => { e.preventDefault(); closeRoute(); });
  drawer.addEventListener('click', (e) => { if (e.target === drawer) closeRoute(); });
  drawer.addEventListener('close', () => { if (D.silent) { D.silent = false; return; } if (S.route.key) closeRoute(); });
  $('#expired-copy').addEventListener('click', async () => { const ok = await copyText('conductor open'); toast(ok ? 'good' : 'warn', ok ? 'Copied. Paste it in a terminal.' : "Couldn't copy. Type it in a terminal."); });
  $('#expired-retry').addEventListener('click', () => location.reload());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.state && !S.expired) { loadState().catch(() => {}); if (S.view === 'board') boardPoke(true); } });
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && S.state && !S.expired) loadState().catch(() => {}); }, STATE_POLL_MS);
  setInterval(() => {
    if (S.expired || !S.sse.es || !S.sse.ok) return;
    if (Date.now() - S.sse.lastMsg > SSE_DEAD_MS) {
      S.sse.dropped = true; S.sse.downSince = Date.now();
      closeSSE(); renderConn(); scheduleReconnect();
    }
  }, 10000);
  let lastCrash = 0;
  const crash = () => { if (Date.now() - lastCrash > 5000) { lastCrash = Date.now(); toast('error', 'Something went wrong in the dashboard. Reload the page if it looks stuck.'); } };
  window.addEventListener('error', crash);
  window.addEventListener('unhandledrejection', crash);
  S.route = parseHash();
  if (S.route.view === 'home' || S.route.view === 'board') S.baseView = S.route.view;
  boot();
}
init();
})();
