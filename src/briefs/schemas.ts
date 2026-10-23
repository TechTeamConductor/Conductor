// M8-6 §2.2/§2.3 (+ Security S1, S6, S10, S12; Reviewer N5–N7): the model-facing schemas and the PURE validation and shaping of a brief.
// - Validation runs inside `callAgent.validate`, so any error triggers the ONE corrective re-ask. Messages name the FIELD and the RULE only:
//   they never quote model text (N6: they go back into the prompt and into the user-visible error).
// - Reading is by own property only (`Object.hasOwn` + `typeof`): `__proto__` / `constructor` keys are inert, unknown keys are ignored.
// - Structure is never truncated into shape (9 parts, a bad dependency, a bad path ⇒ error). String caps after validation are display limits.
// - Shaping order (S1): sanitise → cap → redact. The same functions run again on load (T10).
import type { Schema } from '../agents/json.ts';
import { validateSchema } from '../agents/json.ts';
import { safeEntryName } from '../asks/snapshot.ts';
import { parallelGroupOf, sanitizeLine, stripInvisible } from '../pipeline/graph.ts';
import { redact } from '../redact.ts';
import { isProtectedPath } from '../git/worktree.ts';
import { SECRET_FILE } from '../policy/rules.ts';
import { MAX_PARTS, SOURCE_TYPES, type BriefPart, type PartSize, type ResearchBrief, type SourceType, type WorkBrief } from './types.ts';

const str: Schema = { type: 'string' };
export const WORK_BRIEF_SCHEMA: Schema = {
  type: 'object',
  required: ['title', 'summary', 'approach', 'files', 'acceptance', 'risks', 'parts'],
  properties: {
    title: { ...str, description: '≤ 80 characters, names the change' },
    summary: { ...str, description: 'two or three sentences: the goal and what done looks like' },
    approach: { ...str, description: 'how to do it, concretely, citing real files and symbols in `backticks`; plain text, no links' },
    files: { type: 'array', maxItems: 30, items: { type: 'object', required: ['path', 'why'], properties: { path: str, why: str } } },
    acceptance: { type: 'array', minItems: 1, maxItems: 12, items: str },
    risks: { type: 'array', maxItems: 10, items: str },
    parts: {
      type: 'array', minItems: 1, maxItems: MAX_PARTS,
      items: {
        type: 'object', required: ['title', 'summary', 'size', 'files', 'deps'],
        properties: {
          title: str, summary: str, size: { type: 'string', enum: ['S', 'M', 'L'] },
          files: { type: 'array', maxItems: 10, items: str },
          deps: { type: 'array', maxItems: 7, items: { type: 'integer' }, description: '1-based numbers of EARLIER parts this one needs. Empty between parts that share a parallelGroup.' },
          parallelGroup: { ...str, description: 'short label (letters, digits, hyphen). Parts with the same label can run together and must not depend on each other.' },
        },
      },
    },
  },
};

export const RESEARCH_BRIEF_SCHEMA: Schema = {
  type: 'object',
  required: ['title', 'objective', 'questions', 'scope', 'sourceTypes', 'deliverable'],
  properties: {
    title: str,
    objective: str,
    questions: { type: 'array', minItems: 2, maxItems: 8, items: str },
    scope: { type: 'object', required: ['in', 'out'], properties: { in: { type: 'array', maxItems: 6, items: str }, out: { type: 'array', maxItems: 6, items: str }, timeWindow: str } },
    sourceTypes: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', enum: [...SOURCE_TYPES] } },
    deliverable: str,
  },
};

/** Display caps (S1/N5). Applied by code AFTER validation; never trusted from the model. */
export const CAPS = Object.freeze({
  title: 120, summary: 600, approach: 4000, why: 200, listEntry: 300, partTitle: 120, partSummary: 600, path: 300,
  rTitle: 120, objective: 600, question: 300, scopeEntry: 200, timeWindow: 80, deliverable: 600,
});

const own = (o: unknown, k: string): unknown => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** One-line field (S1): controls, bidi, format, separators, private-use, unassigned, fillers, variation selectors removed; whitespace collapsed. */
export const line = (v: unknown, max: number): string => (typeof v === 'string' ? sanitizeLine(v, max) : '');
/** Multi-line field (S1): the same character set removed, `\n` kept — and ONLY `\n` (tab and CR are C0 controls too). */
export const block = (v: unknown, max: number): string => (typeof v === 'string' ? stripInvisible(v.replace(/\r\n?/g, '\n')).replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');

/**
 * A repository path from model text (§2.3, S10): NFKC, trimmed, one leading `./` stripped, then REJECTED (null) — never stripped — when it
 * holds any S1 character, a `:`, a backslash, or anything `safeEntryName` refuses (`..`, `.`, empty segments, absolute, any `.git` segment,
 * control characters). The returned string is the one stored, displayed and checked.
 */
export function normalizeBriefPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > CAPS.path) return null;
  let p = raw.normalize('NFKC').trim();
  if (p.startsWith('./')) p = p.slice(2);
  if (!p || p.length > CAPS.path || p.includes(':') || /[\n\t]/.test(p) || stripInvisible(p) !== p) return null;
  return safeEntryName(p) === p ? p : null;
}

// ───────────────────────────── work brief ─────────────────────────────

/** Schema + semantic rules. Returns field-path errors (empty = valid). Used as `callAgent.validate`. */
export function validateWorkBrief(j: unknown): string[] {
  const errs: string[] = [];
  const parts = own(j, 'parts');
  if (Array.isArray(parts) && parts.length > MAX_PARTS) errs.push(`$.parts: at most ${MAX_PARTS} parts — merge parts`);
  errs.push(...validateSchema(WORK_BRIEF_SCHEMA, j));
  if (errs.length) return errs.slice(0, 12);
  if (!line(own(j, 'title'), CAPS.title)) errs.push('$.title: required (not empty)');
  if (!arr(own(j, 'acceptance')).some((a) => line(a, CAPS.listEntry))) errs.push('$.acceptance: needs at least one non-empty criterion');
  const files = new Set<string>();
  arr(own(j, 'files')).forEach((f, i) => {
    const p = normalizeBriefPath(own(f, 'path'));
    if (p === null) errs.push(`$.files[${i}].path: not a valid repository path (repo-relative, no "..", no ".git", no absolute path)`);
    else files.add(p);
  });
  (parts as unknown[]).forEach((part, i) => {
    const at = `$.parts[${i}]`;
    if (!line(own(part, 'title'), CAPS.partTitle)) errs.push(`${at}.title: required (not empty)`);
    arr(own(part, 'files')).forEach((f, k) => {
      const p = normalizeBriefPath(f);
      if (p === null) errs.push(`${at}.files[${k}]: not a valid repository path`);
      else if (!files.has(p)) errs.push(`${at}.files[${k}]: not in the brief's files — every part file must be listed in $.files`);
    });
    const seen = new Set<number>();
    arr(own(part, 'deps')).forEach((d, k) => {
      const range = i === 0 ? 'part 1 cannot depend on another part' : `1–${i}`;
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > i) errs.push(`${at}.deps[${k}]: must be an earlier part number (${range})`);
      else if (seen.has(d)) errs.push(`${at}.deps[${k}]: duplicate dependency`);
      else seen.add(d);
    });
    const group = own(part, 'parallelGroup');
    if (group !== undefined && group !== '' && !parallelGroupOf(group)) errs.push(`${at}.parallelGroup: a short label of letters, digits and hyphens (at most 32 characters)`);
  });
  return errs.slice(0, 12);
}

export interface FileFacts { state: (path: string) => 'file' | 'omitted' | 'absent'; isProtected: (path: string) => boolean; isSecretLike: (path: string) => boolean }

/** A VALIDATED reply → the stored shape: sanitise → cap → redact. Unknown keys are dropped; part ids are assigned by position. */
export function shapeWorkBrief(j: unknown, secrets: readonly string[], facts: FileFacts): WorkBrief {
  const R = (s: string) => redact(s, secrets);
  const files: WorkBrief['files'] = [];
  const seen = new Set<string>();
  for (const f of arr(own(j, 'files')).slice(0, 30)) {
    const p = normalizeBriefPath(own(f, 'path'));
    if (p === null || seen.has(p)) continue; // duplicates merged (first reason kept)
    seen.add(p);
    files.push({ path: R(p), why: R(line(own(f, 'why'), CAPS.why)), state: facts.state(p), protected: facts.isProtected(p), secretLike: facts.isSecretLike(p) });
  }
  const parts: BriefPart[] = arr(own(j, 'parts')).slice(0, MAX_PARTS).map((p, i) => ({
    id: `P${i + 1}`,
    title: R(line(own(p, 'title'), CAPS.partTitle)),
    summary: R(line(own(p, 'summary'), CAPS.partSummary)),
    size: (['S', 'M', 'L'].includes(own(p, 'size') as string) ? own(p, 'size') : 'M') as PartSize,
    files: [...new Set(arr(own(p, 'files')).map(normalizeBriefPath).filter((x): x is string => x !== null && seen.has(x)))].slice(0, 10).map(R),
    deps: [...new Set(arr(own(p, 'deps')).filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= i))].sort((a, b) => a - b).map((d) => `P${d}`),
    ...(parallelGroupOf(own(p, 'parallelGroup')) ? { parallelGroup: parallelGroupOf(own(p, 'parallelGroup')) } : {}),
  }));
  return {
    title: R(line(own(j, 'title'), CAPS.title)),
    summary: R(block(own(j, 'summary'), CAPS.summary)),
    approach: R(block(own(j, 'approach'), CAPS.approach)),
    files,
    acceptance: arr(own(j, 'acceptance')).slice(0, 12).map((a) => R(line(a, CAPS.listEntry))).filter(Boolean),
    risks: arr(own(j, 'risks')).slice(0, 10).map((a) => R(line(a, CAPS.listEntry))).filter(Boolean),
    parts,
  };
}

/** A STORED work brief from untrusted bytes (T10): the same shaping re-applied; part graph re-checked (deps only to earlier parts). */
export function reshapeStoredWork(raw: unknown): WorkBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const parts = arr(own(raw, 'parts'));
  if (parts.length < 1 || parts.length > MAX_PARTS) return null;
  const files: WorkBrief['files'] = [];
  const seen = new Set<string>();
  for (const f of arr(own(raw, 'files')).slice(0, 30)) {
    const p = normalizeBriefPath(own(f, 'path'));
    if (p === null || seen.has(p)) continue;
    seen.add(p);
    const st = own(f, 'state');
    // F2: the display flags are recomputed from the path (pure), never trusted from the file; `state` needs the snapshot, so it is kept
    files.push({ path: p, why: line(own(f, 'why'), CAPS.why), state: st === 'file' || st === 'omitted' ? st : 'absent', protected: isProtectedPath(p), secretLike: SECRET_FILE.test(p) });
  }
  const out: BriefPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (own(p, 'id') !== `P${i + 1}`) return null;
    const deps = arr(own(p, 'deps'));
    if (!deps.every((d) => typeof d === 'string' && /^P[1-8]$/.test(d) && Number(d.slice(1)) <= i)) return null;
    const title = line(own(p, 'title'), CAPS.partTitle);
    if (!title) return null;
    const group = parallelGroupOf(own(p, 'parallelGroup'));
    out.push({ id: `P${i + 1}`, title, summary: line(own(p, 'summary'), CAPS.partSummary), size: (['S', 'M', 'L'].includes(own(p, 'size') as string) ? own(p, 'size') : 'M') as PartSize, files: [...new Set(arr(own(p, 'files')).map(normalizeBriefPath).filter((x): x is string => x !== null && seen.has(x)))].slice(0, 10), deps: [...new Set(deps as string[])], ...(group ? { parallelGroup: group } : {}) });
  }
  const title = line(own(raw, 'title'), CAPS.title);
  if (!title) return null;
  return {
    title, summary: block(own(raw, 'summary'), CAPS.summary), approach: block(own(raw, 'approach'), CAPS.approach), files,
    acceptance: arr(own(raw, 'acceptance')).slice(0, 12).map((a) => line(a, CAPS.listEntry)).filter(Boolean),
    risks: arr(own(raw, 'risks')).slice(0, 10).map((a) => line(a, CAPS.listEntry)).filter(Boolean),
    parts: out,
  };
}

// ───────────────────────────── research brief ─────────────────────────────

/**
 * S6(b): fetch targets a brief must not introduce. Each pattern matches a whole token; a token is allowed only when that exact substring
 * (case-insensitive) is in the user's own line. Tuned against false positives (code review M1): `metadata.labels`, `metadata.json`,
 * `Dictionary::Add`, `deadbeef::cafe`, times like 12:30:45 and versions like 1.2.3 are NOT targets.
 * Short / hex / decimal IPv4 spellings are caught where they cannot be a version or a count: `127.x[.y]` (loopback short form), `0x` + 8 hex
 * digits, and a bare 9–10 digit integer that lies inside a loopback / private / link-local range (e.g. 2130706433 = 127.0.0.1).
 * Residual (Security F3, documented): other short forms (`10.1`, `192.168.1`) and plain public host names (`evil.example/?d=`) are not
 * caught — they collide with versions ("macOS 10.15") and prose. The brief's only input is the user's own question, and the user reviews it.
 */
const TARGETS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]*/gi, // any URL scheme
  /\bwww\.[^\s"'<>)\]]*/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, // IPv4 dotted quad (incl. 169.254.169.254, ::ffff:1.2.3.4)
  /\b0x[0-9a-f]{8}\b/gi, // IPv4 as one hex number (0x7f000001)
  /(?<![\d.])127\.\d{1,3}(?:\.\d{1,3})?(?![\d.])/g, // loopback short forms (127.1, 127.0.1)
  /\[[0-9a-f:.]*:[0-9a-f:.]*\]/gi, // bracketed IPv6 ([::1])
  // IPv6 standalone token: compressed (`::`) with hex groups of ≤ 4 and at least one digit, or ≥ 4 uncompressed groups
  /(?<![\w:])(?=[0-9a-f:]*\d)(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])/gi,
  /(?<![\w:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![\w:])/gi,
  /\blocalhost\b/gi,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|internal|localhost)\b/gi,
  /\bmetadata\.(?:google\.internal|azure\.com|packet\.net|platformequinix\.com|tencentyun\.com)\b/gi, // cloud metadata hosts
  /\b(?:[a-z0-9-]+\.)*(?:nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me)\b/gi, // wildcard-DNS names that resolve to private IPs
];
/** True when `text` names a host/URL/IP the user did not type. Checked on the NFKC + invisible-stripped form (no zero-width splitting). */
export function introducesTarget(text: string, userLine: string): boolean {
  // invisible characters are REMOVED (not turned into spaces), so "local\u200Bhost" is still seen as "localhost"
  const flat = (s: string) => stripInvisible(s.normalize('NFKC')).replace(/\s+/g, ' ').slice(0, 20_000);
  const t = flat(text);
  const u = flat(userLine).toLowerCase();
  for (const re of TARGETS) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const tok = m[0].replace(/[.,;:!?]+$/, '');
      if (tok && !u.includes(tok.toLowerCase())) return true;
    }
  }
  // IPv4 as one decimal number, only inside loopback / private / link-local ranges (a count like 1234567890 users stays prose)
  for (const m of t.matchAll(/(?<![\d.])\d{9,10}(?![\d.])/g)) {
    const n = Number(m[0]);
    if (DECIMAL_PRIVATE.some(([a, b]) => n >= a && n <= b) && !u.includes(m[0])) return true;
  }
  return false;
}
const ip = (a: number, b: number, c: number, d: number): number => ((a * 256 + b) * 256 + c) * 256 + d;
/** [first, last] of 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 as 32-bit integers. */
const DECIMAL_PRIVATE: readonly (readonly [number, number])[] = [
  [ip(127, 0, 0, 0), ip(127, 255, 255, 255)], [ip(10, 0, 0, 0), ip(10, 255, 255, 255)], [ip(172, 16, 0, 0), ip(172, 31, 255, 255)],
  [ip(192, 168, 0, 0), ip(192, 168, 255, 255)], [ip(169, 254, 0, 0), ip(169, 254, 255, 255)], [ip(100, 64, 0, 0), ip(100, 127, 255, 255)],
];

export function validateResearchBrief(j: unknown, userLine: string): string[] {
  const errs = validateSchema(RESEARCH_BRIEF_SCHEMA, j).slice(0, 12);
  if (errs.length) return errs;
  if (!line(own(j, 'title'), CAPS.rTitle)) errs.push('$.title: required (not empty)');
  if (arr(own(j, 'questions')).filter((q) => line(q, CAPS.question)).length < 2) errs.push('$.questions: needs at least 2 non-empty questions');
  const rule = 'must not contain a web address, host name or IP address that is not in the user\'s question';
  const check = (v: unknown, at: string) => { if (typeof v === 'string' && introducesTarget(v, userLine)) errs.push(`${at}: ${rule}`); };
  check(own(j, 'title'), '$.title');
  check(own(j, 'objective'), '$.objective');
  check(own(j, 'deliverable'), '$.deliverable');
  arr(own(j, 'questions')).forEach((q, i) => check(q, `$.questions[${i}]`));
  const scope = own(j, 'scope');
  arr(own(scope, 'in')).forEach((q, i) => check(q, `$.scope.in[${i}]`));
  arr(own(scope, 'out')).forEach((q, i) => check(q, `$.scope.out[${i}]`));
  check(own(scope, 'timeWindow'), '$.scope.timeWindow');
  return errs.slice(0, 12);
}

/** Validated (or stored) research brief → the stored shape. With `secrets`, every string is redacted last (S1 order). */
export function shapeResearchBrief(j: unknown, secrets: readonly string[] = []): ResearchBrief | null {
  if (!j || typeof j !== 'object') return null;
  const R = (s: string) => redact(s, secrets);
  const scope = own(j, 'scope');
  const tw = line(own(scope, 'timeWindow'), CAPS.timeWindow);
  const title = R(line(own(j, 'title'), CAPS.rTitle));
  const questions = arr(own(j, 'questions')).slice(0, 8).map((q) => R(line(q, CAPS.question))).filter(Boolean);
  if (!title || questions.length < 2) return null;
  return {
    title,
    objective: R(block(own(j, 'objective'), CAPS.objective)),
    questions,
    scope: { in: arr(own(scope, 'in')).slice(0, 6).map((s) => R(line(s, CAPS.scopeEntry))).filter(Boolean), out: arr(own(scope, 'out')).slice(0, 6).map((s) => R(line(s, CAPS.scopeEntry))).filter(Boolean), ...(tw ? { timeWindow: R(tw) } : {}) },
    sourceTypes: [...new Set(arr(own(j, 'sourceTypes')).filter((s): s is SourceType => (SOURCE_TYPES as readonly unknown[]).includes(s)))].slice(0, 8),
    deliverable: R(block(own(j, 'deliverable'), CAPS.deliverable)),
  };
}

/**
 * The text the web-research session receives (S6a): built ONLY from the stored, shaped record — exactly the fields `BriefView.research`
 * shows, nothing else. Pure; the research service fences it as `research-brief`.
 */
export function renderResearchBrief(b: ResearchBrief): string {
  const L: string[] = [`Title: ${b.title}`, `Objective: ${b.objective}`, 'Key questions:', ...b.questions.map((q, i) => `${i + 1}. ${q}`)];
  L.push('In scope:', ...(b.scope.in.length ? b.scope.in.map((s) => `- ${s}`) : ['- (not stated)']));
  L.push('Out of scope:', ...(b.scope.out.length ? b.scope.out.map((s) => `- ${s}`) : ['- (not stated)']));
  if (b.scope.timeWindow) L.push(`Time window: ${b.scope.timeWindow}`);
  L.push(`Source types: ${b.sourceTypes.join(', ') || '(any)'}`, `Deliverable: ${b.deliverable}`);
  return L.join('\n');
}
