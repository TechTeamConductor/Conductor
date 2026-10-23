// Push one done ticket without leaving the branch that is already checked out.
// The builder never pushes. This runs only when a person asks, and the commit author is that person's git identity.
import { git, gitOk } from './exec.ts';
import { withRepoLock } from './worktree.ts';
import { realpath } from 'node:fs/promises';

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const AGENT_NAMES = new Set(['conductor', 'claude', 'cursor', 'techteamconductor', 'openai', 'anthropic', 'copilot', 'chatgpt']);

export interface Person {
  name: string;
  email: string;
}

export interface PushTicketResult {
  branch: string;
  sha: string;
  files: string[];
  /** Old commit id → the id after the author was changed to the person. */
  replacements: Record<string, string>;
}

/** True when this name or email is an agent, not a person. */
export function isAgentIdentity(name: string, email: string): boolean {
  const n = name.trim().toLowerCase();
  const e = email.trim().toLowerCase();
  if (AGENT_NAMES.has(n)) return true;
  if (e === 'conductor@localhost') return true;
  if (/^(conductor|claude|cursor|copilot|chatgpt)@/i.test(e)) return true;
  if (/@(anthropic|openai)\.com$/i.test(e)) return true;
  return false;
}

/** The git identity already configured for this repository. Never invents one and never writes git config. */
export async function personIdentity(repoRoot: string): Promise<{ ok: true; person: Person } | { ok: false; detail: string }> {
  const name = (await git(repoRoot, ['config', '--get', 'user.name'])).stdout.trim();
  const email = (await git(repoRoot, ['config', '--get', 'user.email'])).stdout.trim();
  if (!name || !email) {
    return { ok: false, detail: 'Git has no user.name and user.email. Set them to your name before pushing. Conductor will not sign a push as an agent.' };
  }
  if (name.includes('\n') || email.includes('\n') || name.includes('\0') || email.includes('\0')) {
    return { ok: false, detail: 'The git name or email is not usable. Set them to your name before pushing.' };
  }
  if (isAgentIdentity(name, email)) {
    return { ok: false, detail: 'The git name or email looks like an agent. Pushing uses your name, not Conductor, Claude, or Cursor.' };
  }
  return { ok: true, person: { name, email } };
}

function ownedByConductor(path: string): boolean {
  return path === '.conductor' || path.startsWith('.conductor/') || path === '.cursor' || path.startsWith('.cursor/');
}

function safePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('-') || path.includes('\0') || path.includes('\\')) return false;
  if (path.split('/').some((s) => s === '..' || s === '')) return false;
  return true;
}

/** Files a ticket's own commits changed. Other commits on the branch are not included. */
export async function filesForCommits(repoRoot: string, shas: readonly string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const sha of shas) {
    if (!SHA_RE.test(sha)) continue;
    const diff = await git(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
    if (diff.code !== 0) continue;
    for (const line of diff.stdout.split('\n')) {
      const path = line.trim();
      if (safePath(path) && !ownedByConductor(path)) out.add(path);
    }
  }
  return [...out].sort();
}

async function currentBranch(repoRoot: string): Promise<string | null> {
  const head = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const name = head.stdout.trim();
  if (head.code !== 0 || !name || !BRANCH_RE.test(name) || name.includes('..')) return null;
  return name;
}

function authorEnv(person: Person): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
  };
}

/** Stage and commit only `paths`. A dirty file outside that list stays unstaged. */
async function commitOnly(repoRoot: string, paths: string[], message: string, person: Person): Promise<{ ok: true; sha: string | null } | { ok: false; detail: string }> {
  if (paths.length === 0) return { ok: true, sha: null };
  const status = await git(repoRoot, ['status', '--porcelain', '--', ...paths]);
  if (!status.stdout.trim()) return { ok: true, sha: null };
  const add = await git(repoRoot, ['add', '--', ...paths]);
  if (add.code !== 0) return { ok: false, detail: `Could not stage this ticket's files: ${add.stderr.trim().slice(0, 300)}` };
  const cached = await git(repoRoot, ['diff', '--cached', '--name-only', '-z']);
  const staged = cached.stdout.split('\0').filter(Boolean);
  const allow = new Set(paths);
  if (staged.some((p) => !allow.has(p))) {
    await git(repoRoot, ['reset', '-q']);
    return { ok: false, detail: 'Refusing to commit a file this ticket did not change.' };
  }
  if (staged.length === 0) return { ok: true, sha: null };
  const committed = await git(
    repoRoot,
    ['-c', `user.name=${person.name}`, '-c', `user.email=${person.email}`, '-c', 'commit.gpgsign=false', 'commit', '-m', message, '--', ...paths],
    { env: authorEnv(person) },
  );
  if (committed.code !== 0) {
    await git(repoRoot, ['reset', '-q']);
    return { ok: false, detail: `Could not commit this ticket's files: ${committed.stderr.trim().slice(0, 300)}` };
  }
  return { ok: true, sha: (await gitOk(repoRoot, ['rev-parse', 'HEAD'])).trim() };
}

async function authorOf(repoRoot: string, sha: string): Promise<{ name: string; email: string }> {
  const line = (await gitOk(repoRoot, ['log', '-1', '--format=%an%n%ae', sha])).split('\n');
  return { name: line[0] ?? '', email: line[1] ?? '' };
}

/** Commits of this ticket that sit at the tip, oldest last in `chain` (tip first). */
async function tipChain(repoRoot: string, shas: ReadonlySet<string>): Promise<{ base: string; chain: string[] } | null> {
  let cur = (await gitOk(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const chain: string[] = [];
  while (shas.has(cur) && chain.length < 30) {
    chain.push(cur);
    const parent = await git(repoRoot, ['rev-parse', '--verify', `${cur}^`]);
    if (parent.code !== 0) return null;
    cur = parent.stdout.trim();
  }
  if (chain.length === 0) return null;
  return { base: cur, chain };
}

async function alreadyPublished(repoRoot: string, branch: string, sha: string): Promise<boolean> {
  const remote = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (remote.code !== 0 || !remote.stdout.trim()) return false;
  const anc = await git(repoRoot, ['merge-base', '--is-ancestor', sha, remote.stdout.trim()]);
  return anc.code === 0;
}

/**
 * Put the person's name on this ticket's tip commits. Does not check out another branch and does not merge.
 * Stops when a later commit from somewhere else sits on top, or when a commit is already on the remote.
 */
async function reauthorTip(repoRoot: string, shas: ReadonlySet<string>, person: Person, branch: string): Promise<Record<string, string>> {
  const tip = await tipChain(repoRoot, shas);
  if (!tip) return {};
  let agent = false;
  for (const sha of tip.chain) {
    if (await alreadyPublished(repoRoot, branch, sha)) return {};
    const who = await authorOf(repoRoot, sha);
    if (isAgentIdentity(who.name, who.email)) agent = true;
  }
  if (!agent) return {};
  // Untracked files are not part of the commit. Staged or unstaged edits would be swept into an amend, so leave the author alone.
  const dirty = (await gitOk(repoRoot, ['status', '--porcelain'])).split('\n').filter((l) => l && !l.startsWith('??') && !l.startsWith('!!'));
  if (dirty.length) return {};
  const env = authorEnv(person);
  if (tip.chain.length === 1) {
    const amended = await git(
      repoRoot,
      ['-c', `user.name=${person.name}`, '-c', `user.email=${person.email}`, '-c', 'commit.gpgsign=false', 'commit', '--amend', '--reset-author', '--no-edit'],
      { env },
    );
    if (amended.code !== 0) return {};
    const sha = (await gitOk(repoRoot, ['rev-parse', 'HEAD'])).trim();
    return { [tip.chain[0]!]: sha };
  }
  const replayed = await git(
    repoRoot,
    ['-c', 'commit.gpgsign=false', 'rebase', '--onto', tip.base, tip.base, '-x', 'git -c commit.gpgsign=false commit --amend --reset-author --no-edit'],
    { env },
  );
  if (replayed.code !== 0) {
    await git(repoRoot, ['rebase', '--abort']);
    return {};
  }
  const fresh = (await gitOk(repoRoot, ['log', '--reverse', '--format=%H', `${tip.base}..HEAD`])).split('\n').map((s) => s.trim()).filter(Boolean);
  const oldestFirst = [...tip.chain].reverse();
  const replacements: Record<string, string> = {};
  if (fresh.length === oldestFirst.length) {
    oldestFirst.forEach((old, i) => {
      const next = fresh[i];
      if (next && next !== old) replacements[old] = next;
    });
  }
  return replacements;
}

function cleanRemoteText(text: string): string {
  return text.replace(/https?:\/\/[^@\s/]+@/g, 'https://').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Commit only this ticket's files as `person`, then push the branch that is already checked out.
 * Does not create a branch, check out another branch, or merge.
 */
export async function pushTicket(opts: {
  repoPath: string;
  key: string;
  title: string;
  shas: readonly string[];
}): Promise<{ ok: true; result: PushTicketResult } | { ok: false; detail: string }> {
  const root = await realpath(opts.repoPath);
  return withRepoLock(root, async () => {
    const branch = await currentBranch(root);
    if (!branch) return { ok: false, detail: 'This repository is not on a branch. Conductor stays on the current branch and will not create or switch one.' };
    const who = await personIdentity(root);
    if (!who.ok) return who;
    const files = await filesForCommits(root, opts.shas);
    if (files.length === 0) return { ok: false, detail: 'This ticket has no files to push.' };
    const origin = await git(root, ['remote', 'get-url', 'origin']);
    if (origin.code !== 0 || !origin.stdout.trim()) return { ok: false, detail: 'This repository has no origin remote, so there is nowhere to push.' };
    const subject = `${opts.key}: ${opts.title.replace(/[\r\n]+/g, ' ').slice(0, 80)}`;
    const committed = await commitOnly(root, files, subject, who.person);
    if (!committed.ok) return committed;
    const shas = new Set(opts.shas.filter((s) => SHA_RE.test(s)));
    if (committed.sha) shas.add(committed.sha);
    const replacements = await reauthorTip(root, shas, who.person, branch);
    const after = await currentBranch(root);
    if (after !== branch) return { ok: false, detail: 'The branch changed while preparing the push. Nothing was pushed.' };
    const pushed = await git(root, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 60_000 });
    if (pushed.code !== 0) {
      const why = cleanRemoteText(`${pushed.stderr}\n${pushed.stdout}`);
      return { ok: false, detail: why ? `The push did not finish: ${why}` : 'The push did not finish.' };
    }
    const still = await currentBranch(root);
    if (still !== branch) return { ok: false, detail: 'The branch changed during the push.' };
    const sha = (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
    return { ok: true, result: { branch, sha, files, replacements } };
  });
}
