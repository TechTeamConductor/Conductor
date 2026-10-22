import { looksSecret } from '../redact.ts';
import { gitOk } from './exec.ts';

const SECRET_NAME = /(^|\/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx))$/i;
const SAFE_ENV_NAME = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;

/**
 * Scan EVERYTHING the branch adds relative to the base (not just what Conductor itself staged): an agent may have
 * committed on its own, bypassing the commit-time guard (security review M1). Returns human-readable findings that
 * never contain the secret itself.
 */
export async function scanBranchForSecrets(worktree: string, baseSha: string, envSecrets: readonly string[]): Promise<string[]> {
  const findings = new Set<string>();
  const names = (await gitOk(worktree, ['diff', '--name-only', '--diff-filter=AMR', '-z', `${baseSha}..HEAD`]).catch(() => '')).split('\0').filter(Boolean);
  for (const n of names) if (SECRET_NAME.test(n) && !SAFE_ENV_NAME.test(n)) findings.add(`${n} (secret-style file name)`);
  const patch = await gitOk(worktree, ['diff', '-U0', '--no-color', '--no-ext-diff', '--text', `${baseSha}..HEAD`], { maxBytes: 16 * 1024 * 1024 }).catch(() => '');
  let file = '(unknown file)';
  const long = envSecrets.filter((s) => s.length >= 8);
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : file;
      continue;
    }
    if (!line.startsWith('+')) continue;
    const content = line.slice(1);
    if (looksSecret(content)) findings.add(`${file} (credential-shaped value)`);
    else for (const v of long) if (content.includes(v)) findings.add(`${file} (a value copied from an .env file)`);
    if (findings.size >= 10) break;
  }
  return [...findings];
}
