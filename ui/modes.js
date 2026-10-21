/* Conductor dashboard: pure helpers (no DOM, no network, no import/export).
 * Loaded before app.js as a plain script; the same bytes are loaded by test/ui-modes.test.ts through vm.runInNewContext.
 * Defines exactly one frozen global: ConductorModes.
 */
(function () {
  'use strict';

  /* ───────── mode detection (verbatim from the approved design, Main.dc.html detectMode) ───────── */
  function detectMode(t) {
    const s = String(t == null ? '' : t).trim().toLowerCase();
    if (!s) return 'work';
    if (/\b(research|compare|comparison|versus|vs\.?|alternatives?|options for|evaluate|pros and cons|best (way|practice|library|tool)|state of the art|survey|benchmark|safest way)\b/.test(s)) return 'research';
    if (/\?\s*$/.test(s) || /^(how|what|why|where|when|which|who|does|do|is|are|can|could|should|explain|show|list|tell me|find)\b/.test(s)) return 'ask';
    return 'work';
  }

  /** Which v2 role answers each Home mode (Build: `planning` until M8-6 adds "Design the work"). */
  const MODE_META = Object.freeze({
    ask: Object.freeze({ label: 'Quick Ask', short: 'Ask', icon: 'help', role: 'context', row: 'ask' }),
    work: Object.freeze({ label: 'Engineering work', short: 'Build', icon: 'code', role: 'planning', row: 'plan' }),
    research: Object.freeze({ label: 'Deep Research', short: 'Research', icon: 'shield', role: 'research', row: 'research' }),
  });

  /* ───────── repositories ───────── */
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** The one registered repo whose name appears in the text as a whole word (case-insensitive); null for none or several. */
  function matchRepo(text, names) {
    const t = String(text == null ? '' : text);
    if (!t || !Array.isArray(names)) return null;
    const hits = [];
    for (const n of names) {
      if (typeof n !== 'string' || !n) continue;
      // a "word" is bounded by anything that cannot be part of a repo name ([A-Za-z0-9._-])
      const re = new RegExp('(^|[^A-Za-z0-9._-])' + escRe(n) + '(?=$|[^A-Za-z0-9._-]|\\.(?:$|[^A-Za-z0-9_-]))', 'i');
      if (re.test(t)) hits.push(n);
    }
    return hits.length === 1 ? hits[0] : null;
  }
  const NONE = '\u0000none';
  /**
   * May a request in this mode go without a repository? Research: always. Ask: unless exactly one repo is registered (the server
   * then picks it, so "none" would not be true). Build: never (a task needs a repo).
   */
  function noneAllowed(mode, repoCount) {
    return mode === 'research' || (mode === 'ask' && repoCount !== 1);
  }
  /**
   * Which repo a Home request goes to.
   * chosen: '' = Auto, NONE = "No repository", otherwise a repo name. A NONE choice that the mode does not allow
   * (allowNone false) counts as Auto, so a choice made in another mode never sticks where it would be untrue.
   * → { name: string | null, how: 'chosen' | 'none' | 'matched' | 'last' | 'only' | 'unresolved' }
   */
  function resolveRepo(o) {
    const names = Array.isArray(o && o.names) ? o.names.filter((n) => typeof n === 'string') : [];
    const chosen = o && typeof o.chosen === 'string' ? o.chosen : '';
    if (chosen === NONE && o.allowNone !== false) return { name: null, how: 'none' };
    if (chosen && names.includes(chosen)) return { name: chosen, how: 'chosen' };
    const m = matchRepo(o && o.text, names);
    if (m) return { name: m, how: 'matched' };
    const last = o && typeof o.lastUsed === 'string' ? o.lastUsed : '';
    if (last && names.includes(last)) return { name: last, how: 'last' };
    if (names.length === 1) return { name: names[0], how: 'only' };
    return { name: null, how: 'unresolved' };
  }

  /* ───────── Build: one line → a task ───────── */
  const TITLE_MAX = 200;
  /** title = first non-empty line, whitespace collapsed, ≤ 200 chars (word boundary ≥ 120 when clipped); description = the full text when it says more. */
  function taskFromText(text) {
    const full = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    const first = (full.split('\n').find((l) => l.trim()) || '').replace(/\s+/g, ' ').trim();
    let title = first;
    if (title.length > TITLE_MAX) {
      const cut = title.lastIndexOf(' ', TITLE_MAX - 1);
      title = (cut >= 120 ? title.slice(0, cut) : title.slice(0, TITLE_MAX - 1)).replace(/\s+$/, '') + '…';
    }
    const out = { title };
    if (full && full !== title) out.description = full;
    return out;
  }

  /* ───────── roles: the seven "Who does what" rows ───────── */
  const ROLE_ROWS = Object.freeze([
    Object.freeze({ id: 'ask', label: 'Quick Ask', role: 'context', followers: Object.freeze([]), hint: 'Answers one-line questions from your code. Nothing is changed.' }),
    Object.freeze({ id: 'research', label: 'Deep Research', role: 'research', followers: Object.freeze([]), hint: 'Searches the web and writes a report with sources.' }),
    Object.freeze({ id: 'design', label: 'Design the work', role: 'requirements', followers: Object.freeze(['architecture']), hint: 'Works out what a task needs before it is planned. Also used for architecture.' }),
    Object.freeze({ id: 'plan', label: 'Write the plan', role: 'planning', followers: Object.freeze([]), hint: 'Plans each task before anything is built.' }),
    Object.freeze({ id: 'review', label: 'Review the plan', role: 'review', followers: Object.freeze([]), hint: 'A second pass that checks the plan.' }),
    Object.freeze({ id: 'build', label: 'Build the code', role: 'implementation', followers: Object.freeze(['debugging', 'documentation']), hint: 'Writes the code in a separate worktree. Also used for debugging and documentation.' }),
    Object.freeze({ id: 'verify', label: 'Verify the result', role: 'verification', followers: Object.freeze([]), hint: 'Checks every acceptance criterion against the result.' }),
  ]);

  /** The provider that runs a role first, or null. */
  function leadOf(roles, role) {
    const e = roles && Object.prototype.hasOwnProperty.call(roles, role) ? roles[role] : null;
    return e && Array.isArray(e.providers) && typeof e.providers[0] === 'string' ? e.providers[0] : null;
  }
  /** Replace the lead (index 0), keep every other entry in order, drop duplicates (first wins). Never mutates. */
  function setLead(chain, to) {
    const c = Array.isArray(chain) ? chain.filter((p) => typeof p === 'string') : [];
    const next = c.length ? [to].concat(c.slice(1)) : [to];
    return next.filter((p, i) => next.indexOf(p) === i);
  }
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  /** A deep copy of the role's whole entry as read from GET /api/roles with only `providers` changed: every other field is echoed (fallbacks, autoByComplexity, M8-2 fields, anything newer). */
  function roleEdit(entry, to) {
    const base = entry && typeof entry === 'object' ? JSON.parse(JSON.stringify(entry)) : {};
    base.providers = setLead(base.providers, to);
    return base;
  }
  /**
   * changes: { <row id>: <provider id> } → { roles: { <role>: entry } } holding only the roles whose providers really change
   * (followers included, each edited on its own entry). An empty `roles` means nothing to send.
   */
  function rolesPatch(roles, changes) {
    const out = {};
    const ch = changes && typeof changes === 'object' ? changes : {};
    for (const row of ROLE_ROWS) {
      if (!Object.prototype.hasOwnProperty.call(ch, row.id)) continue;
      const to = ch[row.id];
      if (typeof to !== 'string' || !to) continue;
      for (const role of [row.role].concat(row.followers)) {
        const cur = roles && Object.prototype.hasOwnProperty.call(roles, role) ? roles[role] : null;
        if (!cur) continue;
        const next = roleEdit(cur, to);
        if (!sameList(next.providers, Array.isArray(cur.providers) ? cur.providers : [])) out[role] = next;
      }
    }
    return { roles: out };
  }

  /**
   * Providers the patch NEWLY adds to a role's chain whose pairing the server marks `needsAck` (isolation not verified here).
   * One entry per provider, naming every row and role it would take. Computed from a fresh GET /api/roles before the PUT.
   */
  function acksNeeded(roles, choices, patch) {
    const by = new Map();
    const pr = patch && patch.roles && typeof patch.roles === 'object' ? patch.roles : {};
    for (const role of Object.keys(pr)) {
      const cur = roles && Object.prototype.hasOwnProperty.call(roles, role) && Array.isArray(roles[role].providers) ? roles[role].providers : [];
      const next = Array.isArray(pr[role].providers) ? pr[role].providers : [];
      for (const id of next) {
        if (cur.includes(id)) continue;
        const c = choices && choices[role] && Object.prototype.hasOwnProperty.call(choices[role], id) ? choices[role][id] : null;
        if (!c || c.ok !== true || c.needsAck !== true) continue;
        if (!by.has(id)) by.set(id, { provider: id, roles: [], rows: [] });
        const e = by.get(id);
        if (!e.roles.includes(role)) e.roles.push(role);
        const row = ROLE_ROWS.find((r) => r.role === role || r.followers.includes(role));
        if (row && !e.rows.includes(row.label)) e.rows.push(row.label);
      }
    }
    return Array.from(by.values());
  }
  /** The PUT body with exactly the confirmed acknowledgements. Never mutates `patch`; an empty list adds no field. */
  function withAck(patch, ids) {
    const body = { roles: JSON.parse(JSON.stringify((patch && patch.roles) || {})) };
    const list = Array.isArray(ids) ? ids.filter((x, i) => typeof x === 'string' && ids.indexOf(x) === i) : [];
    if (list.length) body.acknowledge = list;
    return body;
  }

  /* ───────── M8-2: model choices ───────── */
  /** A job's model choice in the GET/PUT form: { model: string|null, custom, effort: string|null, fast, thinking }. */
  function selFields(sel) {
    const s = sel && typeof sel === 'object' ? sel : {};
    const model = typeof s.model === 'string' && s.model ? s.model : null;
    return { model, custom: model !== null && s.custom === true, effort: typeof s.effort === 'string' && s.effort ? s.effort : null, fast: s.fast === true, thinking: s.thinking === true };
  }
  /** The model choice a role entry holds for `tool` (the server binds a choice to the tool it was made for; another tool gets only the effort). */
  function selOf(entry, tool) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const f = selFields(e);
    if (e.tool && e.tool !== tool) return { model: null, custom: false, effort: f.effort, fast: false, thinking: false };
    return f;
  }
  const sameSel = (a, b) => { const x = selFields(a); const y = selFields(b); return x.model === y.model && x.custom === y.custom && x.effort === y.effort && x.fast === y.fast && x.thinking === y.thinking; };
  /**
   * Add each row's model choice to a roles patch (from rolesPatch). Every role of the row gets the same fields (the server never mirrors);
   * `tool` is left out of an edited entry (the server derives it). Rows not in `sels` are untouched. Never mutates its inputs.
   */
  function withSel(patch, roles, sels) {
    const out = { roles: JSON.parse(JSON.stringify((patch && patch.roles) || {})) };
    const ch = sels && typeof sels === 'object' ? sels : {};
    for (const row of ROLE_ROWS) {
      if (!Object.prototype.hasOwnProperty.call(ch, row.id)) continue;
      const f = selFields(ch[row.id]);
      for (const role of [row.role].concat(row.followers)) {
        const base = Object.prototype.hasOwnProperty.call(out.roles, role) ? out.roles[role]
          : roles && Object.prototype.hasOwnProperty.call(roles, role) ? JSON.parse(JSON.stringify(roles[role])) : null;
        if (!base) continue;
        base.model = f.model; base.custom = f.custom; base.effort = f.effort; base.fast = f.fast; base.thinking = f.thinking;
        delete base.tool;
        out.roles[role] = base;
      }
    }
    return out;
  }

  /* ───────── attribute safety for the DOM helper h() ───────── */
  /** An http(s) URL (normalised) or null. */
  function safeHttp(u) {
    try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (e) { return null; }
  }
  const DROP_ATTR = new Set(['style', 'srcdoc', 'formaction', 'innerhtml', 'outerhtml', 'srcset', 'imagesrcset', 'is']);
  // every attribute that can carry a URL the browser may load or navigate to
  const URL_ATTR = new Set(['href', 'src', 'action', 'xlink:href', 'poster', 'ping', 'background', 'cite', 'longdesc', 'manifest', 'codebase', 'data', 'icon', 'lowsrc', 'dynsrc', 'archive', 'classid', 'usemap', 'profile', 'itemtype']);
  /**
   * The value h() may write for an attribute, or null to drop it. Event handlers are added by h() as listeners (functions only);
   * a non-function on* value never becomes an attribute. URL-bearing attributes keep only in-app hashes, same-origin paths or http(s).
   */
  function safeAttr(name, value) {
    const n = String(name).toLowerCase();
    if (n.startsWith('on') || DROP_ATTR.has(n)) return null;
    const v = value === true ? '' : String(value);
    if (URL_ATTR.has(n)) {
      if (/^#\/[^\s]*$/.test(v) || v === '#') return v;
      if (/^\/(?!\/)[^\s\\]*$/.test(v)) return v;
      return safeHttp(v);
    }
    return v;
  }

  /* ───────── wording derived from roles ───────── */
  const nameOf = (labelOf, id) => (typeof labelOf === 'function' ? labelOf(id) : null) || id;
  /** "handles Quick Ask, Write the plan" for a provider, from the seven rows. */
  function toolJobs(roles, provider) {
    const jobs = ROLE_ROWS.filter((r) => leadOf(roles, r.role) === provider).map((r) => r.label);
    return jobs.length ? 'handles ' + jobs.join(', ') : 'not assigned to a job';
  }
  /** Column hints that name the assigned tool; null fields keep the static hint. */
  function colHints(roles, labelOf) {
    const p = leadOf(roles, 'planning');
    const b = leadOf(roles, 'implementation');
    const v = leadOf(roles, 'verification');
    return {
      planning: p ? nameOf(labelOf, p) + ' writes the plan' : null,
      building: b ? nameOf(labelOf, b) + ' writes the code' : null,
      verifying: v ? 'Gates, then ' + nameOf(labelOf, v) + ' checks' : null,
    };
  }
  /** The empty board's five steps, naming the tools and the approval rule. */
  function flowText(roles, planApproval, labelOf) {
    const who = (role, dflt) => { const id = leadOf(roles, role); return id ? nameOf(labelOf, id) : dflt; };
    const approve = planApproval === 'auto' ? 'Plans are approved automatically' : planApproval === 'manual' ? 'You confirm every plan' : 'You confirm the first plan per repo';
    return {
      steps: [
        { t: 'Plan', d: who('planning', 'Claude') + ' reads the card and writes a plan' },
        { t: 'Approve', d: approve },
        { t: 'Build', d: who('implementation', 'Cursor') + ' writes the code in a worktree' },
        { t: 'Verify', d: 'Gates and ' + who('verification', 'Claude') + ' check every criterion' },
        { t: 'Review', d: 'You merge. Conductor never pushes' },
      ],
      howTail: planApproval === 'auto' ? '' : ' or a plan needs approval',
    };
  }

  /* ───────── M8-6 S14/F1: the research audit lists are capped; say how many more there were ───────── */
  /** "+N more opened, not listed" when `total` (the true count) exceeds the `shown` list length; '' otherwise or for a bad total. */
  function moreNote(total, shown, what) {
    const t = typeof total === 'number' && Number.isInteger(total) ? total : 0;
    const n = t - (typeof shown === 'number' ? shown : 0);
    return n > 0 ? '+' + n + ' more ' + what + ', not listed' : '';
  }

  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };
  globalThis.ConductorModes = deepFreeze({
    detectMode, MODE_META, NONE, noneAllowed, matchRepo, resolveRepo, taskFromText, TITLE_MAX,
    ROLE_ROWS, leadOf, setLead, roleEdit, rolesPatch, acksNeeded, withAck, safeHttp, safeAttr, toolJobs, colHints, flowText,
    selFields, selOf, sameSel, withSel, moreNote,
  });
})();
