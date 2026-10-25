/**
 * Secret-likeness of values copied out of `.env` files (autopilot-self-heal C1, Security rev-4 adjustments).
 *
 * `loadEnvSecrets` (src/redact.ts, untouched) keeps feeding redaction with EVERY value. The branch / push scan instead
 * matches only the values that `envValueIsSecretLike` accepts, so a public URL, a region or a hostname copied into a doc
 * no longer stops a run, while anything that could be a credential still does. Everything fails closed: on doubt the
 * value qualifies. Erasable TypeScript, node built-ins only.
 */
import { existsSync, readFileSync } from 'node:fs';

export interface EnvEntry {
  name: string;
  value: string;
  /** The value spans several lines (always secret-like; inherits the name). */
  multiline: boolean;
}

/** Values shorter than this are never matched as literals (a 3-char value would match every diff). */
export const MIN_MATCH_LEN = 8;

/** dotenv-style parse keeping the variable NAME (the quoting / inline-comment / multi-line rules of `loadEnvSecrets`). */
export function loadEnvEntries(files: readonly string[]): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(lines[i] ?? '');
        if (!m) continue;
        const name = m[1] ?? '';
        let v = m[2] ?? '';
        const q = v[0];
        let multi = false;
        if (q === '"' || q === "'") {
          let body = v.slice(1);
          while (!body.includes(q) && i + 1 < lines.length) {
            body += '\n' + (lines[++i] ?? '');
            multi = true;
          }
          const end = body.indexOf(q);
          v = end >= 0 ? body.slice(0, end) : body; // unbalanced quote: keep the rest (fail closed, longer value)
          if (end < 0) multi = true;
        } else {
          v = v.replace(/\s+#.*$/, '');
        }
        const value = v.trim();
        if (value) out.push({ name, value, multiline: multi || /[\r\n]/.test(value) });
      }
    } catch {
      /* unreadable env file: ignore (same as loadEnvSecrets) */
    }
  }
  return out;
}

const STRONG_SUBSTRINGS = ['SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'PRIVATE', 'APIKEY', 'AUTHORIZATION', 'MNEMONIC'];
const NAME_TOKENS = new Set([
  'SECRET', 'TOKEN', 'KEY', 'PASS', 'PASSWORD', 'PASSWD', 'PWD', 'SALT', 'SIGNATURE', 'SIG', 'COOKIE', 'SESSION', 'CERT', 'BEARER',
  'WEBHOOK', 'CREDENTIAL', 'CREDENTIALS', 'PRIVATE', 'AUTH', 'DSN', 'ACCESS', 'JWT', 'HMAC', 'SEED', 'MNEMONIC', 'PIN', 'OTP',
  'LICENSE', 'LICENCE', 'CONNECTION', 'URI',
]);

/** Name tokens: split on non-alphanumerics and camelCase boundaries, upper-cased. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toUpperCase());
}

function secretName(name: string): boolean {
  const up = name.toUpperCase();
  if (up.replace(/[^A-Z0-9]/g, '').includes('DATABASEURL')) return true;
  if (STRONG_SUBSTRINGS.some((s) => up.includes(s))) return true;
  return nameTokens(name).some((t) => NAME_TOKENS.has(t));
}

const BOOL_WORD = /^(true|false|yes|no|on|off|null|none|undefined)$/i;
const SECRET_QUERY_KEY = /(^|[^a-z])(secret|token|key|pass|password|passwd|pwd|salt|sig|signature|auth|session|cookie|cert|bearer|credential|access|jwt|hmac|api[-_]?key|code|otp|pin)([^a-z]|$)/i;

const TLDS = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'cloud', 'local', 'internal', 'test', 'example', 'localhost', 'lan', 'corp', 'co', 'ai', 'edu', 'gov', 'info', 'biz', 'xyz', 'tech', 'online', 'site', 'store', 'cc', 'me', 'tv']);

/** A real-looking DNS name: lower-case labels, no digit-letter passphrase mix, last label a known TLD (or a 2-letter country code). `Summer2024.Company.Passw0rd` is not one. */
function hostnameShaped(v: string): boolean {
  if (v.length > 255 || /\s/.test(v) || !v.includes('.') || !HOST.test(v) || !/^[a-z]/.test(v) || v !== v.toLowerCase()) return false;
  const labels = v.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (!(TLDS.has(tld) || /^[a-z]{2}$/.test(tld))) return false;
  return !labels.some(opaqueSegment);
}

/** One plain word (lower, UPPER, Capitalized) or one number: the only 8-15 character values a non-secret name may carry unscanned. */
function benignShort(v: string): boolean {
  return /^[a-z]+$/.test(v) || /^[A-Z]+$/.test(v) || /^[A-Z][a-z]+$/.test(v) || /^[0-9]+$/.test(v);
}

function classes(s: string): number {
  return (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) + (/[0-9]/.test(s) ? 1 : 0) + (/[^A-Za-z0-9]/.test(s) ? 1 : 0);
}

/** A path / URL segment that could itself be a credential (long and mixed, or long hex). */
function opaqueSegment(seg: string): boolean {
  if (seg.length < 16) return false;
  if (/^[0-9a-f]+$/i.test(seg)) return true;
  if (/^[A-Za-z]+([-_.][A-Za-z]+)*$/.test(seg)) return false; // words and kebab-case words
  return classes(seg) >= 2;
}

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** `scheme://host[:port][/path]` with no userinfo, query, fragment or opaque path segment. */
function bareUrl(v: string): boolean {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#@\s]+)((?:\/[^?#@\s]*)?)$/.exec(v);
  if (!m) return false;
  const hostport = m[1] ?? '';
  const host = hostport.replace(/:\d{1,5}$/, '');
  if (!HOST.test(host) && !/^\[[0-9a-fA-F:]+\]$/.test(host)) return false;
  return !(m[2] ?? '').split('/').some(opaqueSegment);
}

function urlSecretLike(v: string): boolean {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.*)$/s.exec(v);
  if (!m) return false;
  const rest = m[1] ?? '';
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) return true; // userinfo: postgres://u:p@h
  const q = rest.indexOf('?');
  if (q >= 0) {
    for (const pair of rest.slice(q + 1).split(/[&;]/)) {
      const k = pair.split('=', 1)[0] ?? '';
      if (SECRET_QUERY_KEY.test(decodeURIComponentSafe(k))) return true;
      const val = pair.includes('=') ? pair.slice(pair.indexOf('=') + 1) : '';
      if (opaqueSegment(val)) return true;
    }
  }
  return false;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const PLAIN_PATH = /^(?:~|\.{1,2})?(?:\/[A-Za-z0-9._@+%=,-]+)+\/?$|^\.{1,2}\/?$/;

function arnExempt(v: string): boolean {
  if (!/^arn:[a-z0-9-]+:[a-z0-9-]*:[a-z0-9-]*:[0-9]*:[A-Za-z0-9._:/-]+$/.test(v)) return false;
  const segs = v.split(/[:/]/);
  return !segs.some((s) => opaqueSegment(s)) && !segs.some((s) => nameTokens(s).some((t) => ['SECRET', 'TOKEN', 'PASSWORD', 'KEY', 'CREDENTIAL', 'PRIVATE'].includes(t)));
}

/**
 * True when a value copied from a `.env` file could be a credential. Precedence, in code order (first match wins):
 *   1. multi-line value                          -> true (always; PEM blocks, JSON keys)
 *   2. secret-style NAME (tokens/substrings)     -> true, whatever the value looks like
 *   3. URL with userinfo or a secret-looking query -> true  (`postgres://u:p@h`, `?token=`)
 *   4. exemptions: boolean word, region, bare scheme+host(+path) URL, single hostname, ARN without a secret segment,
 *      plain path, short pure number, lower-case kebab/snake word list -> false. These run BEFORE the entropy rules (a bare URL is >=16 chars
 *      with three character classes and would otherwise qualify).
 *   5. >=20 chars hex / base64 / base64url (not a plain word list) -> true
 *   6. >=16 chars, no whitespace, >=3 of {lower, upper, digit, symbol} -> true
 *   7. whitespace-bearing / unparseable / anything else of >=16 chars  -> true (doubt fails closed)
 *   8. 8-15 chars that are not a single plain word (lower, UPPER or Capitalized letters) or a single number -> true (`Tr0ub4dor&3`, `P@ssw0rd123`)
 *   9. anything shorter, or such a plain word/number, under a non-secret name -> false
 */
export function envValueIsSecretLike(name: string, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/[\r\n]/.test(v)) return true; // 1
  if (secretName(name)) return true; // 2
  if (urlSecretLike(v)) return true; // 3
  if (BOOL_WORD.test(v) || REGION.test(v) || bareUrl(v) || arnExempt(v)) return false; // 4
  if (hostnameShaped(v)) return false;
  if (PLAIN_PATH.test(v) && !v.split('/').some(opaqueSegment)) return false;
  if (/^[0-9]{1,15}$/.test(v)) return false;
  if (/^[a-z]+(?:[-_][a-z]+)+$/.test(v) && v.split(/[-_]/).every((w) => w.length <= 12)) return false; // kebab/snake word list: a service or env name
  if (v.length >= 20 && /^[A-Za-z0-9+/_=-]+$/.test(v) && !/^[A-Za-z]+([-_][A-Za-z]+)+$/.test(v)) return true; // 5
  if (v.length >= 16 && !/\s/.test(v) && classes(v) >= 3) return true; // 6
  if (v.length >= 16) return true; // 7
  if (/["']/.test(v) && v.length >= 4) return true; // stray quotes: parse doubt
  if (v.length >= 8 && !benignShort(v)) return true; // 8: 8-15 chars survive only as one plain word or one number, never as a password-shaped mix
  return false; // 9
}

/**
 * The exact strings the scan must look for: for each value, qualifying when ANY entry carrying that value qualifies
 * (the same value under a harmless name and a secret name is a secret). Multi-line values contribute the whole value and
 * every substantial line. Values under MIN_MATCH_LEN are not matchable.
 */
export function secretLikeEnvValues(entries: readonly { name: string; value: string; multiline?: boolean }[]): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (t.length >= MIN_MATCH_LEN) out.add(t);
  };
  for (const e of entries) {
    const multi = e.multiline === true || /[\r\n]/.test(e.value);
    const qualifies = multi || envValueIsSecretLike(e.name, e.value);
    // ANY entry carrying the value qualifies it: handled by union semantics of the set.
    if (!qualifies) continue;
    add(e.value.replace(/\r\n/g, '\n'));
    if (multi) {
      for (const line of e.value.split(/\r?\n/)) {
        const l = line.trim();
        if (l.length >= 16 && !l.startsWith('-----')) add(l);
      }
    }
  }
  return [...out];
}
