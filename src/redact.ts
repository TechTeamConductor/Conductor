import { readFileSync, existsSync } from 'node:fs';

/**
 * Common credential shapes. Every pattern is anchored at a token boundary and has BOUNDED quantifiers so a hostile
 * 200 KB string cannot make matching quadratic (security review M4: a builder-written file froze the process for 13 s).
 */
const B = '(?<![A-Za-z0-9_-])'; // token boundary
export const TOKEN_PATTERNS: RegExp[] = [
  new RegExp(`${B}lin_api_[A-Za-z0-9]{20,100}`, 'g'), // Linear personal API key
  new RegExp(`${B}lin_oauth_[A-Za-z0-9]{20,100}`, 'g'),
  new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{20,200}`, 'g'), // Anthropic
  // OpenAI-style: must start a token and contain a digit/uppercase — kebab-case words like "task-card-header-title…" are NOT keys
  new RegExp(`${B}sk-(?=[A-Za-z0-9_-]{0,200}[0-9A-Z])[A-Za-z0-9_-]{24,200}`, 'g'),
  new RegExp(`${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,100}`, 'g'), // Stripe
  new RegExp(`${B}crsr_[A-Za-z0-9]{20,100}`, 'g'), // Cursor API keys
  new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{30,100}`, 'g'), // GitHub
  new RegExp(`${B}github_pat_[A-Za-z0-9_]{40,120}`, 'g'),
  new RegExp(`${B}npm_[A-Za-z0-9]{36}`, 'g'), // npm
  new RegExp(`${B}AIza[0-9A-Za-z_-]{35}`, 'g'), // Google API key
  new RegExp(`${B}SG\\.[A-Za-z0-9_-]{16,64}\\.[A-Za-z0-9_-]{16,64}`, 'g'), // SendGrid
  new RegExp(`${B}AKIA[0-9A-Z]{16}`, 'g'), // AWS access key id
  new RegExp(`${B}xox[abprs]-[A-Za-z0-9-]{10,100}`, 'g'), // Slack
  /hooks\.slack\.com\/services\/T[A-Za-z0-9]{6,}\/B[A-Za-z0-9]{6,}\/[A-Za-z0-9]{16,}/g, // Slack webhook
  /(?<=:\/\/)[^\s:@\/]{1,100}:[^\s@\/]{3,200}(?=@)/g, // user:password@ in a URL
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{0,16000}?-----END [A-Z ]{0,30}PRIVATE KEY-----/g,
  new RegExp(`${B}eyJ[A-Za-z0-9_-]{10,2000}\\.eyJ[A-Za-z0-9_-]{10,2000}\\.[A-Za-z0-9_-]{10,2000}`, 'g'), // JWT
];

/** Beyond this we redact the head and tail only — display/log paths never need more, and it bounds worst-case cost. */
const MAX_REDACT_CHARS = 400_000;

const MARK = '[redacted]';

/** Replace known token shapes and any exact `secrets` values (>= 8 chars). */
export function redact(text: string, secrets: readonly string[] = []): string {
  if (!text) return text;
  let out = text.length > MAX_REDACT_CHARS ? `${text.slice(0, MAX_REDACT_CHARS / 2)}\n…[${text.length - MAX_REDACT_CHARS} characters omitted]…\n${text.slice(-MAX_REDACT_CHARS / 2)}` : text;
  for (const s of secrets) {
    if (s && s.length >= 8 && out.includes(s)) out = out.split(s).join(MARK);
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, MARK);
  return out;
}

/** Values (>= 8 chars) from dotenv-style files (quotes, inline comments, multi-line values); used as exact-match secrets. */
export function loadEnvSecrets(files: readonly string[]): string[] {
  const vals = new Set<string>();
  const add = (v: string) => {
    const t = v.trim();
    if (t.length >= 8) vals.add(t);
    for (const part of t.split(/\r?\n/)) if (part.trim().length >= 8) vals.add(part.trim());
  };
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(lines[i] ?? '');
        if (!m) continue;
        let v = m[1] ?? '';
        const q = v[0];
        if (q === '"' || q === "'") {
          // quoted value, possibly spanning several lines
          let body = v.slice(1);
          while (!body.includes(q) && i + 1 < lines.length) body += '\n' + (lines[++i] ?? '');
          const end = body.indexOf(q);
          v = end >= 0 ? body.slice(0, end) : body;
        } else {
          v = v.replace(/\s+#.*$/, ''); // inline comment
        }
        add(v);
      }
    } catch {
      /* unreadable env file: ignore */
    }
  }
  return [...vals];
}

/** True when the text looks like it contains a credential (used by the commit guard). */
export function looksSecret(text: string): boolean {
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      re.lastIndex = 0;
      return true;
    }
  }
  return false;
}
