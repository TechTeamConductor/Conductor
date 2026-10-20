import { readFileSync, existsSync } from 'node:fs';

/** Common credential shapes. Order matters little; all are replaced. */
export const TOKEN_PATTERNS: RegExp[] = [
  /lin_api_[A-Za-z0-9]{20,}/g, // Linear personal API key
  /lin_oauth_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  // OpenAI-style: must start a token and contain a digit/uppercase — kebab-case words like "task-card-header-title…" are NOT keys
  /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{24,}/g,
  /crsr_[A-Za-z0-9]{20,}/g, // Cursor API keys
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

const MARK = '[redacted]';

/** Replace known token shapes and any exact `secrets` values (>= 8 chars). */
export function redact(text: string, secrets: readonly string[] = []): string {
  if (!text) return text;
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8 && out.includes(s)) out = out.split(s).join(MARK);
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, MARK);
  return out;
}

/** Values (>= 8 chars) from dotenv-style files; used as exact-match redaction secrets. */
export function loadEnvSecrets(files: readonly string[]): string[] {
  const vals = new Set<string>();
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)\s*$/.exec(line);
        if (!m) continue;
        let v = m[1] ?? '';
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (v.length >= 8) vals.add(v);
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
