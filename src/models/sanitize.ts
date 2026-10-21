// The one place untrusted model-discovery text is cleaned (M8-1 §2.3, Security S3/S8/S9). A LEAF module: config.ts re-exports the id
// rule from here, so this file must never import config.ts (ESM cycle / TDZ, Reviewer N12). Ids, labels and families are data: they are
// never used to build a file path, a shell string, a regex or an HTML string.
import { redact } from '../redact.ts';

/**
 * Model id rules, chosen PER PROVIDER (Security S9 widening ruling W1–W7, 2026-10-21). There is no global "wide" rule; use
 * `modelIdOk(provider, id)`.
 *  - MODEL_ID_BASE_RE (Cursor, Codex, and the default): letters/digits first (so an id can never read as an option), then letters, digits
 *    and . _ : / - (max 64). Cursor parses brackets as parameters (`id[effort=…]`) and Codex has no documented bracket meaning, so neither
 *    gets them (W3, W4).
 *  - CLAUDE_MODEL_RE: the base rule plus ONE optional suffix `[` 1–8 of [a-z0-9] `]` — Claude 2.1.304 lists an `<id>[1m]` entry
 *    (a context-size variant) with Conductor's env (W2). Max 74 characters. Any further widening goes back to Security (W7).
 */
export const MODEL_ID_BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
export const CLAUDE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(?:\[[a-z0-9]{1,8}\])?$/;
/** The narrow base rule (kept under its old name for config.ts / CODEX_MODEL_RE). For a provider's rule use `modelIdOk`. */
export const MODEL_ID_RE = MODEL_ID_BASE_RE;
/** The single entry point for "may this string be a model id for this provider" (W1). Raw check: no cleaning, no trimming. */
export function modelIdOk(provider: string, id: unknown): id is string {
  if (typeof id !== 'string') return false;
  return (provider === 'claude' ? CLAUDE_MODEL_RE : MODEL_ID_BASE_RE).test(id);
}
/** Effort levels any tool may report, in canonical order. Anything else is dropped. */
export const EFFORT_TOKENS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const MAX_MODELS = 1000;
export const LABEL_MAX = 80;
export const PLAN_MAX = 40;
export const REASON_MAX = 200;
/** S3: a plan name is kept only when it is this plain. */
export const PLAN_RE = /^[A-Za-z0-9 _-]{1,40}$/;
/** Board account key (M8-3 adds non-default ones). Used to build the cache file name: nothing else may reach a path. */
export const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION_RE = /^\d{1,6}(?:\.\d{1,9}){1,3}(?:[-+][A-Za-z0-9.]{1,24})?$/;

/** Own-property read (S8): never walks the prototype chain, so `__proto__`/`constructor` keys in hostile JSON are inert. */
export function own(o: unknown, k: string): unknown {
  return o !== null && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;
}
export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// S9: format/control/separator/private-use classes; lone surrogates are handled separately (they are not matched by \p classes reliably).
const STRIP_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/gu;

/**
 * NFC, then strip \p{Cc} \p{Cf} \p{Zl} \p{Zp} \p{Co} and lone surrogates, collapse whitespace, truncate by CODE POINT (never creates a
 * lone surrogate). Non-strings ⇒ ''.
 */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string' || !s) return '';
  // bound the work before normalising: nothing we keep is longer than a few hundred characters
  let t = s.length > 4 * 1024 ? s.slice(0, 4 * 1024) : s;
  t = dropLoneSurrogates(t).normalize('NFC');
  t = t.replace(/[\t\n\v\f\r]/g, ' '); // whitespace controls separate words: they become spaces, not nothing
  t = t.replace(STRIP_RE, '');
  t = t.replace(/\s+/gu, ' ').trim();
  const cps = Array.from(t);
  return cps.length > max ? cps.slice(0, max).join('') : t;
}

function dropLoneSurrogates(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      }
      continue; // a high surrogate without its pair
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue; // a low surrogate without its pair
    out += s[i]!;
  }
  return out;
}

/**
 * The id as the tool reported it, if it passes that provider's rule, else null (the caller drops and counts it). The rules allow ASCII
 * only, so an id is never "repaired" by cleaning: one carrying a control/format character or whitespace is refused, not altered — the
 * id stored is byte-for-byte what the tool listed.
 */
export function cleanId(s: unknown, provider: string): string | null {
  return modelIdOk(provider, s) ? s : null;
}

/** Efforts ∈ EFFORT_TOKENS, de-duplicated, canonical order, ≤ 7 (S8). Accepts strings or `{reasoningEffort}` objects (Codex). */
export function cleanEfforts(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const x of v.slice(0, 64)) {
    const raw = typeof x === 'string' ? x : own(x, 'reasoningEffort');
    if (typeof raw === 'string' && EFFORT_TOKENS.includes(raw)) seen.add(raw);
  }
  return EFFORT_TOKENS.filter((t) => seen.has(t));
}
export function cleanEffort(v: unknown): string | undefined {
  return typeof v === 'string' && EFFORT_TOKENS.includes(v) ? v : undefined;
}

/** A CLI version string reduced to its version-shaped token (≤ 40), or null. */
export function cleanVersion(v: unknown): string | null {
  const t = cleanText(v, 120);
  if (!t) return null;
  const m = /\d{1,6}(?:\.\d{1,9}){1,3}(?:[-+][A-Za-z0-9.]{1,24})?/.exec(t);
  const out = m ? m[0].slice(0, 40) : '';
  return out && VERSION_RE.test(out) ? out : null;
}

export function cleanPlan(v: unknown): string | undefined {
  const t = cleanText(v, PLAN_MAX);
  return t && PLAN_RE.test(t) ? t : undefined;
}

const EMAIL_RE = /[^\s@]{1,64}@[^\s@]{1,255}/g;
// absolute paths / home-relative paths never reach a reason (S13)
const PATH_RE = /(?:~|\/)[^\s'"`]*\/[^\s'"`]*/g;

/**
 * S3 + B5b: every reason and log detail from every provider goes through this. `redact()` with the refresh's exact identity strings
 * as secrets, an exact-match pass for short identity strings (redact ignores < 8 chars), an email-shape scrub, a path scrub, then
 * cleanText to ≤ max.
 */
export function scrubIdentity(text: unknown, identity: readonly string[] = [], max = REASON_MAX): string {
  if (typeof text !== 'string' || !text) return '';
  let t = text.length > 64 * 1024 ? text.slice(-64 * 1024) : text;
  t = redact(t, identity);
  for (const s of identity) if (s && s.length >= 3 && t.includes(s)) t = t.split(s).join('[redacted]');
  t = t.replace(EMAIL_RE, '[email]').replace(PATH_RE, '[path]');
  return cleanText(t, max);
}
