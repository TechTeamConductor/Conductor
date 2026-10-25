// Shared identity and remote-text helpers for Ship (src/git/ship.ts), the only code that pushes (test/push-static.test.ts enforces it).
// The old manual push (amend/rebase of the checkout, unscanned) is gone: the Push button runs Ship. The commit author is the developer's own git identity, never an agent.
import { git } from './exec.ts';
import { redact } from '../redact.ts';

export interface Person {
  name: string;
  email: string;
}

/** Case-insensitive substrings that make a git name or email an agent's. Fails closed (a person called Devin is blocked unless they opt in). */
export const AGENT_TERMS: readonly string[] = [
  'claude', 'cursor', 'codex', 'copilot', 'gemini', 'devin', 'openai', 'anthropic', 'grok', '[bot]',
  'github-actions', 'conductor', 'techteam', 'noreply', 'no-reply', '@localhost',
];
/** An override may never be one of these, whatever the person types. */
const OVERRIDE_REFUSED: readonly string[] = ['[bot]', 'github-actions', 'noreply', 'no-reply', '@localhost'];

function cleanIdent(v: string): boolean {
  return v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f<>]/.test(v);
}

/** True when a person-set developer identity is acceptable as an override (it must not be a bot, a no-reply or a local address; only the person can set it, so their own account name is accepted even if it contains Conductor). */
export function validDeveloperIdentity(dev: Person | null | undefined): dev is Person {
  if (!dev || typeof dev.name !== 'string' || typeof dev.email !== 'string') return false;
  const name = dev.name.trim();
  const email = dev.email.trim();
  if (!cleanIdent(name) || !cleanIdent(email) || !email.includes('@')) return false;
  const hay = `${name} ${email}`.toLowerCase();
  return !OVERRIDE_REFUSED.some((t) => hay.includes(t));
}

/**
 * True when this name or email is an agent, not a person. Empty means agent. `developerIdentity` is the person-only escape:
 * it clears exactly that name AND email pair (never anything else) and only when it is itself a valid override.
 */
export function isAgentIdentity(name: string, email: string, developerIdentity?: Person | null): boolean {
  const n = name.trim();
  const e = email.trim();
  if (!n || !e) return true;
  if (validDeveloperIdentity(developerIdentity) && developerIdentity.name.trim().toLowerCase() === n.toLowerCase() && developerIdentity.email.trim().toLowerCase() === e.toLowerCase()) return false;
  const hay = `${n} ${e}`.toLowerCase();
  return AGENT_TERMS.some((t) => hay.includes(t));
}

/** The git identity already configured for this repository. Never invents one and never writes git config. */
export async function personIdentity(repoRoot: string, developerIdentity?: Person | null): Promise<{ ok: true; person: Person } | { ok: false; detail: string }> {
  const name = (await git(repoRoot, ['config', '--get', 'user.name'])).stdout.trim();
  const email = (await git(repoRoot, ['config', '--get', 'user.email'])).stdout.trim();
  return checkPerson(name, email, developerIdentity);
}

/** Validate a name/email pair (live config or a pre-run snapshot) as the developer's identity. */
export function checkPerson(name: string, email: string, developerIdentity?: Person | null): { ok: true; person: Person } | { ok: false; detail: string } {
  if (!name || !email) {
    return { ok: false, detail: 'Git has no user.name and user.email. Set git user.name/user.email to your own name before pushing. Conductor will not sign a push as an agent.' };
  }
  if (name.includes('\n') || email.includes('\n') || name.includes('\0') || email.includes('\0')) {
    return { ok: false, detail: 'The git name or email is not usable. Set git user.name/user.email to your own name before pushing.' };
  }
  if (isAgentIdentity(name, email, developerIdentity)) {
    return { ok: false, detail: 'The git name or email looks like an agent. Set git user.name/user.email to your own name; pushing uses your name, not Conductor, Claude, or Cursor.' };
  }
  return { ok: true, person: { name, email } };
}

export async function alreadyPublished(repoRoot: string, remoteName: string, branch: string, sha: string): Promise<boolean> {
  const remote = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${branch}`]);
  if (remote.code !== 0 || !remote.stdout.trim()) return false;
  const anc = await git(repoRoot, ['merge-base', '--is-ancestor', sha, remote.stdout.trim()]);
  return anc.code === 0;
}

export function cleanRemoteText(text: string): string {
  return redact(text).replace(/https?:\/\/[^@\s/]+@/g, 'https://').replace(/\s+/g, ' ').trim().slice(0, 300);
}
