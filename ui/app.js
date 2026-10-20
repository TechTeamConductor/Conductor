/* Conductor dashboard (vanilla JS, no build step, no dependencies).
 * Contract: docs/API.md + src/types.ts. CSP-safe: no inline script/style, no innerHTML with data,
 * server strings are only ever written with textContent / text nodes.
 */
(() => {
'use strict';

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
  ['overview', 'Overview'], ['log', 'Live log'], ['plan', 'Plan'],
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
  route: { view: 'board', key: null, tab: 'overview' },
  detail: null, detailKey: null, detailSig: '', detailError: null,
  verLoop: null,
  sse: { es: null, ok: false, everOpen: false, dropped: false, lastMsg: 0, attempts: 0, timer: 0, downSince: 0 },
  expired: false,
  busy: new Set(),
  dismissed: new Set(),
  isMobile: false,
  view: null, // 'board' | 'wizard' | 'error'
  loadFailed: false,
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
      else el.setAttribute(k, v === true ? '' : String(v));
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
function safeHttp(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
}
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
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
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
    throw new ApiFail(res.status, e ? e.code : 'http_' + res.status, e && e.message ? e.message : `Request failed (${res.status}).`);
  }
  return data;
}

function showExpired() {
  if (S.expired) return;
  S.expired = true;
  closeSSE();
  for (const d of document.querySelectorAll('dialog[open]')) { try { d.close(); } catch { /* noop */ } }
  for (const id of ['topbar', 'banners', 'main']) { const el = document.getElementById(id); if (el) el.inert = true; }
  $('#expired').hidden = false;
  const retry = $('#expired-retry');
  if (retry) retry.focus();
}

/* ───────────────────────── routing ───────────────────────── */
function parseHash() {
  const m = /^#\/run\/([^/?]+)(?:\/([a-z]+))?/.exec(location.hash);
  if (m) {
    let key = m[1];
    try { key = decodeURIComponent(key); } catch { /* keep raw */ }
    const tab = TABS.some((t) => t[0] === m[2]) ? m[2] : 'overview';
    return { view: 'board', key, tab };
  }
  if (/^#\/setup/.test(location.hash)) return { view: 'setup', key: null, tab: 'overview' };
  return { view: 'board', key: null, tab: 'overview' };
}
function applyRoute() {
  S.route = parseHash();
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
  history.replaceState(null, '', '#/');
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
  d.health.warnings = Array.isArray(d.health.warnings) ? d.health.warnings : [];
  d.quota = d.quota || {};
  d.engine = Object.assign({ paused: false, providerPause: {}, running: 0, maxParallel: 0, lastPollAt: null, lastPollError: null, storageProblem: null, pollSeconds: 5 }, d.engine || {});
  d.engine.providerPause = d.engine.providerPause || {};
  d.settings = Object.assign({ planApproval: 'auto', planReview: 'auto', maxLoops: 3, maxParallel: 2, onClaudeLimit: 'wait', noGates: 'warn' }, d.settings || {});
  d.settings.stages = Object.assign({ plan: 'claude', review: 'claude', verify: 'claude' }, d.settings.stages || {});
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
  return d;
}
function applyState(data, quiet) {
  normalizeState(data);
  S.state = data;
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
    if (S.view !== 'wizard') { closeDrawerSilently(); S.view = 'wizard'; $('#view').replaceChildren(); W.sig = ''; }
    renderWizard();
  } else {
    if (S.view !== 'board') { S.view = 'board'; buildBoardView(); }
    updateBoard();
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
  updateTitle();
  tick();
}
function updateTitle() {
  const n = S.state ? S.state.runs.filter((r) => r.column === 'needs_human' || r.column === 'plan_ready').length : 0;
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
  if (d.now) S.offset = d.now - Date.now();
  renderLive();
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
  const brand = h('a', { class: 'brand', href: '#/', 'aria-label': 'Conductor, back to board' },
    h('span', { class: 'brand-mark' }, icon('baton')), h('span', { class: 'brand-name' }, 'Conductor'), HDR.version);
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
  top.append(brand, HDR.engine, HDR.quota, h('span', { class: 'tb-spacer' }), HDR.conn, HDR.newBtn, HDR.setBtn);
}
function engineView(eng) {
  const pp = eng.providerPause || {};
  const waiting = ['claude', 'cursor'].filter((a) => pp[a]);
  if (eng.paused) {
    return { cls: 'st-paused', icon: 'pause', label: 'Paused', title: eng.pauseReason || 'No new work starts. Running stages finish.' };
  }
  if (waiting.length) {
    const names = waiting.map((a) => AGENT_LABEL[a]).join(' and ');
    return { cls: 'st-planning', icon: 'clock', label: 'Waiting for ' + names, title: waiting.map((a) => pp[a].reason).filter(Boolean).join('\n') || 'Usage limit reached' };
  }
  const busy = eng.maxParallel ? ` · ${eng.running || 0}/${eng.maxParallel} busy` : '';
  const polled = eng.lastPollAt ? 'Last checked the board ' + fmtAgo(eng.lastPollAt) : 'Waiting for the first check';
  return { cls: 'st-ready', icon: 'check', label: 'Running' + busy, pulse: (eng.running || 0) > 0, title: polled };
}
function updateHeader(wizard) {
  const st = S.state;
  toggleHidden(HDR.version, !st.version);
  setText(HDR.version, st.version ? 'v' + st.version : '');
  toggleHidden(HDR.engine, wizard);
  toggleHidden(HDR.newBtn, wizard);
  toggleHidden(HDR.setBtn, wizard);

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
  for (const a of ['claude', 'cursor']) {
    const p = pp[a];
    if (!p) continue;
    const lines = [];
    if (p.reason) lines.push(p.reason);
    lines.push(a === 'claude' && st.settings && st.settings.onClaudeLimit === 'cursor'
      ? 'Read-only stages run on Cursor meanwhile. Everything else continues.'
      : `Stages that need ${AGENT_LABEL[a]} wait. Nothing is lost, runs resume by themselves.`);
    out.push({ id: 'pp-' + a, cls: 'b-limit', icon: 'clock', title: `${AGENT_LABEL[a]} usage limit`, text: ' — resuming automatically at ' + fmtWhen(p.until), until: p.until, lines });
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
      b.action ? h('a', { class: 'btn btn-sm', href: b.action.href }, b.action.label) : null,
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
const runRev = (key) => { const r = S.state && S.state.runs.find((x) => x.key === key); return r ? r.rev : 0; };
const actApprove = (key) => runAction(key, 'approve', () => api('POST', runUrl(key, 'approve'), { rev: runRev(key) }), `Plan for ${key} approved. Cursor starts building.`);
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

/* ───────────────────────── board view ───────────────────────── */
const B = { summary: null, items: null, polled: null, board: null, cols: new Map(), cards: new Map(), history: null, histList: null, histCount: null, histSig: '', empty: null, pollEl: null, order: '', itemsSig: '' };

function buildBoardView() {
  B.cols = new Map(); B.cards = new Map(); B.histSig = ''; B.order = ''; B.itemsSig = '';
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
    B.cols.set(c.id, { el, list, count, empty, title });
  }
  B.pollEl = h('span', { class: 'num' }, '5');
  B.empty = h('section', { class: 'empty', 'aria-labelledby': 'empty-h' },
    h('h2', { id: 'empty-h', class: 'empty-title' }, 'Nothing in flight'),
    h('p', null, 'Create a task and Conductor plans it, builds it and verifies it. Your cards live right here on the board.'),
    h('ol', { class: 'flow', 'aria-label': 'How a task moves' },
      h('li', null, h('b', null, 'Plan'), h('span', null, 'Claude reads the card and writes a plan')),
      h('li', null, h('b', null, 'Approve'), h('span', null, 'You confirm the first plan per repo')),
      h('li', null, h('b', null, 'Build'), h('span', null, 'Cursor writes the code in a worktree')),
      h('li', null, h('b', null, 'Verify'), h('span', null, 'Gates and Claude check every criterion')),
      h('li', null, h('b', null, 'Review'), h('span', null, 'You merge. Conductor never pushes'))),
    h('ol', { class: 'how' },
      h('li', null, 'Press ', h('b', null, 'New task'), ' and describe what you want.'),
      h('li', null, 'Conductor picks it up straight away: the card moves through the stages by itself.'),
      h('li', null, 'You only step in when a card says ', h('b', null, 'Needs you'), ' or a plan needs approval.')),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-primary', data: { act: 'new-task' } }, icon('plus'), h('span', null, 'New task')),
      h('button', { type: 'button', class: 'btn', data: { act: 'open-setup' } }, icon('sliders'), h('span', null, 'Repositories and setup'))));
  B.histCount = h('span', { class: 'col-count' }, '0');
  B.histList = h('ul', { class: 'history-list' });
  B.history = h('details', { class: 'history' },
    h('summary', null, icon('archive'), h('span', null, 'History'), B.histCount, h('span', { class: 'card-spacer' }), icon('chevron', 'chev')),
    B.histList);
  $('#view').replaceChildren(B.summary, B.empty, B.board, B.history);
}

function reconcile(parent, els) {
  const want = new Set(els);
  for (const ch of Array.from(parent.children)) if (!want.has(ch)) ch.remove();
  els.forEach((el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
}

function updateBoard() {
  const st = S.state;
  const open = st.runs.filter((r) => r.column !== 'closed');
  const closed = st.runs.filter((r) => r.column === 'closed');
  const cardsBy = { backlog: st.cards.filter((c) => c.lane === 'backlog'), todo: st.cards.filter((c) => c.lane === 'todo') };
  const idle = cardsBy.backlog.length + cardsBy.todo.length;
  const byCol = new Map(COLUMNS.map((c) => [c.id, []]));
  for (const r of open) (byCol.get(r.column) || byCol.get('queued')).push(r);

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
      reconcile(col.list, cl.map(idleCard));
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
    reconcile(col.list, els);
    setText(col.count, list.length);
    col.count.setAttribute('aria-label', plural(list.length, 'run'));
    col.el.classList.toggle('is-empty', !list.length);
    col.el.classList.toggle('is-attn', !!c.attn && list.length > 0);
    col.el.classList.toggle('is-ask', !!c.ask && list.length > 0);
    toggleHidden(col.empty, list.length > 0);
  }
  for (const [k, el] of B.cards) if (!seen.has(k)) { el.remove(); B.cards.delete(k); }
  updateSummary(byCol);
  updateHistory(closed);
}

function idleCard(c) {
  const move = (lane, msg) => () => runAction(c.key, 'move:' + lane, () => api('POST', `/api/items/${enc(c.key)}/move`, { lane }), msg);
  const btns = c.lane === 'backlog'
    ? [h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: move('todo', `${c.key} will start now.`) }, 'Start')]
    : [h('button', { type: 'button', class: 'btn btn-sm', onclick: move('backlog', `${c.key} moved to Backlog.`) }, 'Park')];
  btns.push(h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: move('canceled', `${c.key} canceled.`) }, 'Cancel'));
  return h('li', { class: 'card idle-card' }, h('div', { class: 'card-top' }, h('span', { class: 'card-key' }, c.key)), h('p', { class: 'card-title' }, c.title), c.note ? h('p', { class: 'muted' }, c.note) : null, h('div', { class: 'card-actions' }, btns));
}

function updateSummary(byCol) {
  const n = (id) => byCol.get(id).length;
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
  p.meta = h('div', { class: 'card-meta' }, p.repo, p.loop, p.bugs, p.unv);
  p.bApprove = h('button', { type: 'button', class: 'btn btn-primary btn-sm', hidden: true, data: { act: 'approve' } }, icon('tick'), h('span', null, 'Approve plan'));
  p.bRetry = h('button', { type: 'button', class: 'btn btn-sm', hidden: true, data: { act: 'retry' } }, icon('refresh'), h('span', null, 'Retry'));
  p.bResume = h('button', { type: 'button', class: 'btn btn-sm', hidden: true, data: { act: 'resume' } }, icon('play'), h('span', null, 'Resume now'));
  p.actions = h('div', { class: 'card-actions', hidden: true }, p.bApprove, p.bRetry, p.bResume);
  const el = h('li', { class: 'card', data: { key } },
    h('div', { class: 'card-top' }, p.key, h('span', { class: 'card-spacer' }), p.agent), p.main, p.act, p.reason, p.meta, p.actions);
  el._p = p;
  return el;
}
function setTimer(span, mode, ts) {
  if (mode === 't0') { span.dataset.t0 = String(ts); delete span.dataset.t1; span.className = 't-elapsed'; }
  else { span.dataset.t1 = String(ts); delete span.dataset.t0; span.className = 't-until'; }
  tickEl(span);
}
function updateCard(el, r) {
  const p = el._p;
  const cls = 'card ' + statusClass(r) + (S.route.key === r.key ? ' is-selected' : '');
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
  toggleHidden(p.meta, p.repo.hidden && p.loop.hidden && p.bugs.hidden && p.unv.hidden);

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
  const ids = TABS.map((t) => t[0]);
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
    D.badges.replaceChildren(...[h('span', { class: 'card-key' }, r.key), statusPill(r), r.agent ? agentChip(r.agent, AGENT_LABEL[r.agent] + ' working') : null].filter(Boolean));
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
    case 'running': return r.agent ? `${AGENT_LABEL[r.agent]} is working. Nothing for you to do.` : 'Working. Nothing for you to do.';
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
    dlg.returnValue = '';
    const form = h('form', { method: 'dialog' },
      h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-confirm-title' }, o.title)),
      h('div', { class: 'dlg-body' }, h('p', null, o.body)),
      h('div', { class: 'dlg-foot' },
        h('button', { type: 'submit', class: 'btn', value: 'cancel', formnovalidate: true, autofocus: true }, o.cancelLabel || 'Cancel'),
        h('button', { type: 'submit', class: 'btn ' + (o.danger ? 'btn-danger-solid' : 'btn-primary'), value: 'ok' }, o.confirmLabel || 'Confirm')));
    dlg.replaceChildren(form);
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
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

function openSettings() {
  const s = S.state.settings;
  const sel = (opts, val) => { const el = h('select', { class: 'select' }, opts.map(([v, l]) => h('option', { value: v }, l))); el.value = val; return el; };
  const num = (min, max, val) => h('input', { class: 'input', type: 'number', min, max, step: '1', inputmode: 'numeric', value: String(val) });
  const c = {
    planApproval: sel([['auto', 'Automatic'], ['first', 'Ask for the first plan in each repo'], ['manual', 'Ask for every plan']], s.planApproval),
    planReview: sel([['off', 'Off'], ['auto', 'Only for medium and large plans'], ['always', 'Always']], s.planReview),
    stPlan: sel([['claude', 'Claude'], ['cursor', 'Cursor']], s.stages.plan),
    stReview: sel([['claude', 'Claude'], ['cursor', 'Cursor']], s.stages.review),
    stVerify: sel([['claude', 'Claude'], ['cursor', 'Cursor']], s.stages.verify),
    maxLoops: num(1, 10, s.maxLoops),
    maxParallel: num(1, 8, s.maxParallel),
    onClaudeLimit: sel([['wait', 'Wait until the limit resets'], ['cursor', 'Use Cursor for read-only stages']], s.onClaudeLimit),
    noGates: sel([['warn', 'Continue, marked Unverified'], ['block', 'Block the run']], s.noGates),
  };
  const err = h('p', { class: 'err form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes');
  const fld = (label, control, hint) => { const id = uid('st'); control.id = id; return field(id, label, control, hint); };
  const group = (legend, ...kids) => h('fieldset', { class: 'set-group' }, h('legend', { class: 'legend' }, legend), kids);
  const onSubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const next = {
      planApproval: c.planApproval.value, planReview: c.planReview.value,
      maxLoops: Number(c.maxLoops.value), maxParallel: Number(c.maxParallel.value),
      onClaudeLimit: c.onClaudeLimit.value, noGates: c.noGates.value,
      stages: { plan: c.stPlan.value, review: c.stReview.value, verify: c.stVerify.value },
    };
    const patch = {};
    for (const k of Object.keys(next)) {
      if (k === 'stages') { if (JSON.stringify(next.stages) !== JSON.stringify(s.stages)) patch.stages = next.stages; }
      else if (next[k] !== s[k]) patch[k] = next[k];
    }
    if (!Object.keys(patch).length) { $('#dlg').close(); return; }
    if (!Number.isInteger(next.maxLoops) || next.maxLoops < 1 || next.maxLoops > 10) { setText(err, 'Fix loops must be a whole number from 1 to 10.'); err.hidden = false; c.maxLoops.focus(); return; }
    if (!Number.isInteger(next.maxParallel) || next.maxParallel < 1 || next.maxParallel > 8) { setText(err, 'Parallel runs must be a whole number from 1 to 8.'); err.hidden = false; c.maxParallel.focus(); return; }
    setBusy(submit, true);
    try {
      await api('PUT', '/api/settings', patch);
      $('#dlg').close();
      toast('good', 'Settings saved.');
      loadState().catch(() => {});
    } catch (ex) {
      setText(err, ex.message); err.hidden = false; setBusy(submit, false);
    }
  };
  const signOut = h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* cookie may already be gone */ }
    $('#dlg').close(); showExpired();
  } }, icon('logout'), h('span', null, 'Sign out'));
  const dlg = dlgShell('Settings', [
    group('Planning',
      fld('Plan approval', c.planApproval, 'Automatic starts building as soon as the plan is written. Large plans always ask.'),
      fld('Plan review', c.planReview, 'A second Claude pass checks the plan before anything is built.')),
    group('Who does what',
      h('div', { class: 'row-2' }, fld('Write the plan', c.stPlan), fld('Review the plan', c.stReview)),
      h('div', { class: 'row-2' }, fld('Verify the result', c.stVerify), h('div', { class: 'field' }, h('span', { class: 'label' }, 'Build the code'), h('p', { class: 'muted' }, 'Always Cursor.')))),
    group('Limits',
      h('div', { class: 'row-2' }, fld('Fix loops', c.maxLoops, 'Build and verify rounds before Conductor asks you.'), fld('Parallel runs', c.maxParallel, 'Runs working at the same time.')),
      fld('When Claude hits its usage limit', c.onClaudeLimit),
      fld('When a repo has no tests or lint', c.noGates, 'Unverified runs are flagged on the board.')),
    err,
  ], [signOut, h('button', { type: 'button', class: 'btn', onclick: () => { $('#dlg').close(); navigate('#/setup'); } }, icon('folder'), h('span', null, 'Repositories and setup')),
    h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn', onclick: () => $('#dlg').close() }, 'Cancel'), submit], onSubmit, true);
  dlg.showModal();
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
  const sig = JSON.stringify([st.setup, st.health, st.repos, S.route.view]);
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
      complete ? h('p', null, h('a', { class: 'btn btn-sm', href: '#/' }, icon('chevron', 'icon-back'), 'Back to board')) : null,
      h('h1', { id: 'wiz-h' }, complete ? 'Setup and repositories' : 'Set up Conductor'),
      h('p', null, complete
        ? 'Everything is connected. Add another repository or re-check a step.'
        : 'Two short steps. Conductor never pushes or merges code, and everything stays on this computer.'),
      h('div', { class: 'wiz-progress' },
        h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(WIZ_STEPS.length), 'aria-valuenow': String(done), 'aria-label': 'Setup progress' },
          (() => { const f = h('span'); f.style.setProperty('--pct', (done / WIZ_STEPS.length) * 100 + '%'); return f; })()),
        h('span', null, `${done} of ${WIZ_STEPS.length} done`))),
    h('ol', { class: 'steps' }, WIZ_STEPS.map(([id, title], idx) => wizStep(id, title, idx))),
    done === WIZ_STEPS.length ? h('section', { class: 'wiz-done', 'aria-labelledby': 'wiz-done-h' },
      h('h2', { id: 'wiz-done-h' }, 'You are set up'),
      h('p', null, 'Press New task on the board. Conductor plans it, Cursor builds it, Claude verifies it.'),
      h('a', { class: 'btn btn-primary', href: '#/', 'data-focus': 'go-board' }, 'Go to the board')) : null);
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.state && !S.expired) loadState().catch(() => {}); });
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
  boot();
}
init();
})();
