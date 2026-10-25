// Ship: the ONLY push path (the engine's Done -> Pushed and the manual click both come here). The builder never pushes.
//
// Target = the branch checked out in repoRoot, read ONCE at the start of prepareShip and re-verified (name and HEAD) immediately before the push.
// Refused as a direct target: detached HEAD, the remote's live default branch, protected names, invalid refs, and a non-fast-forward.
// Then (bounded, never force) the commit goes to conductor/<sanitised branch | KEY> by sha. The user's checkout, index and local branch are never touched.
//
// Two phases so the engine can persist between them (a crash after prepare re-runs as a no-op, never re-amends):
//   prepareShip  read branch -> validate remote/target -> developer identity -> reauthor + message cleanup -> (fixture fixup) -> scan -> final sha X
//   pushShip     push exactly X (pinned argv, no force, no +refspec, no --no-verify) to refs/heads/<target>
// Nothing here writes the board or the run. Every expected refusal is returned as { ok: false, hold: { reason } } (redacted, never a URL).
// Rewrites happen with plumbing (merge-tree + commit-tree) onto a Conductor-owned ref: the user's checkout, index and branch are never touched.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact } from '../redact.ts';
import { git } from './exec.ts';
import { withRepoLock } from './worktree.ts';
import { AGENT_TERMS, checkPerson, cleanRemoteText, isAgentIdentity } from './push-ticket.ts';
import type { Person } from './push-ticket.ts';

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_RANGE = 500;
const NET_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const REJECTED_SEGMENTS = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'head']);

export interface EnvEntry {
  name: string;
  value: string;
  multiline?: boolean;
}
export type ScanResult = { ok: true } | { ok: false; reason: string; commits: string[]; files: string[] };
export type ScanFn = (opts: { repoRoot: string; tip: string; excludeTips: string[]; envEntries: EnvEntry[]; maxCommitBytes?: number }) => Promise<ScanResult>;
/** sha (as it is in the range when asked) -> { repo path -> new content, or null to delete the file }. */
export type FixtureEdits = Record<string, Record<string, string | null>>;
export type FixtureRewriteFn = (ctx: { repoRoot: string; reason: string; commits: string[]; files: string[] }) => Promise<FixtureEdits | null>;

export interface ShipInput {
  repoRoot: string;
  /** Validated config value only (repos[].pushRemote). Never run, agent or board text. */
  remote: string;
  /** The ticket key (fallback branch name conductor/<KEY> when the checked-out branch cannot be used). */
  key: string;
  /** Commit to ship. Default HEAD. */
  tip?: string;
  /** Every commit Conductor recorded for these runs (commitSha, landedShas, revert and replacement commits). Anything else in the range holds. */
  recordedShas: readonly string[];
  /** sha -> ticket key, so a hold can say "blocked by KEE-n's commit". */
  owners?: Readonly<Record<string, string>>;
  /** Identity snapshot taken before any agent run. Falls back to live git config. */
  identity?: Person | null;
  /** Person-only override (config). */
  developerIdentity?: Person | null;
  envEntries?: EnvEntry[];
  maxCommitBytes?: number;
  /** Injected scanner. Default: scanPushRange from ./branchscan.ts (lazy import). */
  scan?: ScanFn;
  /** Injected: when the scan names credential-shaped fixtures, returns edits that are folded into the introducing commit. */
  fixtureRewrite?: FixtureRewriteFn;
  /** Runs after persist, immediately BEFORE the push. A string is a hold reason: nothing is pushed (git config/hooks moved, a builder started, ...). */
  beforePush?: () => Promise<string | null> | string | null;
}

export interface Hold {
  ok: false;
  hold: { reason: string };
}
export interface Prepared {
  /** The scanned sha. Persist it BEFORE pushShip. */
  sha: string;
  /** Old commit -> commit that replaced it (author, message or fixture rewrite). Persist atomically with commitSha/landedShas. */
  replacements: Record<string, string>;
  remote: string;
  /** The remote branch actually used: the checked-out branch, or the conductor/ fallback. */
  target: string;
  /** The branch checked out when prepare read it (null = detached HEAD) and HEAD's sha then. pushShip re-verifies both. */
  checkedOut: string | null;
  headSha: string | null;
  /** target is the conductor/ fallback, not the checked-out branch. */
  fallback: boolean;
  /** The remote branch already contains sha: nothing to push. */
  alreadyPublished: boolean;
  /** Commits that will leave the machine, oldest first. */
  range: string[];
}
export type PrepareResult = { ok: true; prepared: Prepared } | Hold;
export interface PushInput {
  repoRoot: string;
  remote: string;
  target: string;
  sha: string;
  checkedOut: string | null;
  headSha: string | null;
}
export type PushResult = { ok: true; sha: string; pushed: boolean } | Hold;

const hold = (reason: string): Hold => ({ ok: false, hold: { reason: redact(reason).slice(0, 600) } });
const short = (sha: string): string => sha.slice(0, 8);

// ───────────────────────────── target / remote validation ─────────────────────────────

/** Remote URL that may carry credentials or run code. Plain paths and ssh/scp-style user@host are fine. */
export function unsafeRemoteUrl(url: string): boolean {
  const u = url.trim();
  if (!u || /[\u0000-\u001f\u007f\s]/.test(u) || u.startsWith('-')) return true;
  if (/^[A-Za-z0-9+.-]*::/.test(u) || /^file:/i.test(u)) return true;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(u);
  if (m) {
    const at = m[2]!.lastIndexOf('@');
    if (at >= 0) {
      const userinfo = m[2]!.slice(0, at);
      if (/^(https?|ftps?|git)$/i.test(m[1]!) || userinfo.includes(':')) return true;
    }
  }
  return /[?&](token|access_token|password|auth)=/i.test(u);
}

const PROTECTED_DIRECT = /^(main|master|trunk|develop|dev|head|release.*)$/i;

function plainNameProblem(name: string): string | null {
  if (typeof name !== 'string' || !name) return 'No push branch.';
  if (name.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(name)) return 'The push branch name has characters that are not allowed.';
  if (name.includes('@{') || name.includes('..') || name.includes('//') || name.endsWith('.lock') || name.endsWith('/') || name.endsWith('.') || name.startsWith('/') || name.startsWith('-')) return 'The push branch name is not allowed.';
  if (name.split('/').some((seg) => seg === '' || seg.startsWith('.') || seg.endsWith('.lock'))) return 'The push branch name is not allowed.';
  return null;
}

/** Why the checked-out branch cannot be pushed to directly (a protected name or an invalid ref), or null. The live default branch is checked separately. */
export function directTargetRefusal(name: string): string | null {
  let n = typeof name === 'string' ? name : '';
  while (/^refs\/heads\//i.test(n)) n = n.replace(/^refs\/heads\//i, '');
  const bad = plainNameProblem(n);
  if (bad) return bad;
  if (PROTECTED_DIRECT.test(n)) return 'The checked-out branch is a protected name. Conductor never pushes there.';
  return null;
}

/** The fallback branch name check (prefix required, reserved segments refused). Returns a reason or null. */
export function badTargetName(target: string): string | null {
  if (typeof target !== 'string' || !target) return 'No push branch.';
  if (!target.startsWith('conductor/')) return 'The fallback push branch must start with conductor/.';
  const bad = plainNameProblem(target);
  if (bad) return bad;
  for (const seg of target.split('/')) {
    const s = seg.toLowerCase();
    if (REJECTED_SEGMENTS.has(s) || s.startsWith('release')) return 'The push branch name is reserved. Conductor pushes only to its own conductor/ branch.';
  }
  return null;
}

/** conductor/<sanitised checked-out name>, or conductor/<KEY> when that name is unusable, reserved or there is no branch (detached). */
export function fallbackBranchName(branch: string | null, key: string): string {
  if (branch) {
    const s = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
    const cand = `conductor/${s}`;
    if (s && !badTargetName(cand)) return cand;
  }
  return `conductor/${key}`;
}

export interface Target {
  remote: string;
  target: string;
  /** Live tip of refs/heads/<target> on the remote, or null when the branch does not exist yet. */
  liveTip: string | null;
  /** Live branch tips of the remote (all heads). */
  liveHeads: string[];
  urls: string[];
}

export interface RemoteInfo {
  remote: string;
  urls: string[];
  refs: Map<string, string>;
  heads: string[];
  defaultRef: string;
}

/** The remote name, its URLs (all vetted) and the LIVE ls-remote (the default-branch refusal source). Holds on any problem. */
export async function inspectRemote(repoRoot: string, remote: string): Promise<{ ok: true; info: RemoteInfo } | Hold> {
  if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(remote)) return hold('The push remote must be the name of a configured git remote, not a URL.');
  const list = await git(repoRoot, ['remote']);
  if (list.code !== 0 || !list.stdout.split('\n').map((s) => s.trim()).includes(remote)) return hold(`There is no git remote named ${remote.slice(0, 60)}.`);
  const urls: string[] = [];
  for (const args of [['remote', 'get-url', '--all', remote], ['remote', 'get-url', '--push', '--all', remote]]) {
    const r = await git(repoRoot, args);
    if (r.code !== 0 || !r.stdout.trim()) return hold('The push remote has no usable URL.');
    for (const u of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (unsafeRemoteUrl(u)) return hold('The push remote URL is not allowed (credentials in the URL, or a scheme that can run code). Use an ssh remote or a credential helper.');
      urls.push(u);
    }
  }
  const ls = await git(repoRoot, ['ls-remote', '--symref', remote], { timeoutMs: NET_TIMEOUT_MS });
  if (ls.code !== 0 || ls.timedOut) return hold(`Could not look up the remote's default branch, so nothing is pushed: ${sanitize(`${ls.stderr}\n${ls.stdout}`, urls) || 'no answer'}`);
  const refs = new Map<string, string>();
  const heads: string[] = [];
  let defaultRef = '';
  for (const line of ls.stdout.split('\n')) {
    const sym = /^ref:\s+(\S+)\s+HEAD$/.exec(line.trim());
    if (sym) {
      defaultRef = sym[1]!;
      continue;
    }
    const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim());
    if (!m) continue;
    refs.set(m[2]!, m[1]!);
    if (m[2]!.startsWith('refs/heads/')) heads.push(m[1]!);
  }
  return { ok: true, info: { remote, urls, refs, heads: [...new Set(heads)], defaultRef } };
}

const isDefaultBranch = (info: RemoteInfo, name: string): boolean => !!info.defaultRef && info.defaultRef.toLowerCase() === `refs/heads/${name}`.toLowerCase();
const targetOf = (info: RemoteInfo, name: string): Target => ({ remote: info.remote, target: name, liveTip: info.refs.get(`refs/heads/${name}`) ?? null, liveHeads: info.heads, urls: info.urls });
const refOk = async (root: string, name: string): Promise<boolean> => (await git(root, ['check-ref-format', '--branch', name])).code === 0;

/** The checked-out branch of repoRoot, or null when detached or unusable. */
async function checkedOutBranch(root: string): Promise<string | null> {
  const r = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const name = r.stdout.trim();
  return r.code === 0 && name ? name : null;
}
async function headSha(root: string): Promise<string | null> {
  const r = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).stdout.trim();
  return SHA_RE.test(r) ? r : null;
}

/** Re-validate a CHOSEN target against the live remote (used right before the push). `fallback` targets must carry the conductor/ prefix. */
export async function validateTarget(repoRoot: string, remote: string, target: string, fallback: boolean): Promise<{ ok: true; t: Target } | Hold> {
  const bad = fallback ? badTargetName(target) : directTargetRefusal(target);
  if (bad) return hold(bad);
  if (!(await refOk(repoRoot, target))) return hold('The push branch name is not a valid git branch name.');
  const v = await inspectRemote(repoRoot, remote);
  if (!v.ok) return v;
  if (isDefaultBranch(v.info, target)) return hold('The push branch is the remote default branch. Conductor never pushes there.');
  return { ok: true, t: targetOf(v.info, target) };
}

/**
 * Pick the branch to push `tip` to. Direct (the checked-out branch) unless it is detached, protected, invalid, the live default branch, or the remote
 * branch would not fast-forward; then conductor/<name|KEY>. Never a force; a fallback that itself would not fast-forward holds.
 */
async function chooseTarget(root: string, info: RemoteInfo, branch: string | null, key: string, tip: string): Promise<{ ok: true; t: Target; fallback: boolean } | Hold> {
  const contains = async (liveTip: string): Promise<'same' | 'ff' | 'published' | 'diverged'> => {
    if (liveTip === tip) return 'same';
    if (!(await hasObject(root, liveTip))) return 'diverged';
    if (await isAncestor(root, liveTip, tip)) return 'ff';
    if (await isAncestor(root, tip, liveTip)) return 'published';
    // the same tree under rewritten commits (our own earlier push of the re-authored range, rerun from the unrewritten tip): not a divergence
    const a = (await git(root, ['rev-parse', '--verify', '--quiet', `${liveTip}^{tree}`])).stdout.trim();
    const b = (await git(root, ['rev-parse', '--verify', '--quiet', `${tip}^{tree}`])).stdout.trim();
    if (SHA_RE.test(a) && a === b) return 'published';
    return 'diverged';
  };
  if (branch && !directTargetRefusal(branch) && !isDefaultBranch(info, branch) && (await refOk(root, branch))) {
    const t = targetOf(info, branch);
    if (!t.liveTip || (await contains(t.liveTip)) !== 'diverged') return { ok: true, t, fallback: false };
  }
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(key)) return hold('The ticket key is not usable for a fallback branch name, so nothing is pushed.');
  const name = fallbackBranchName(branch, key);
  if (badTargetName(name) || !(await refOk(root, name)) || isDefaultBranch(info, name)) return hold('No safe branch to push to was found. Nothing was pushed.');
  const t = targetOf(info, name);
  if (t.liveTip && (await contains(t.liveTip)) === 'diverged') return hold(`The remote branch ${name} has commits Conductor does not have, so it is not a fast-forward. Nothing was forced.`);
  return { ok: true, t, fallback: true };
}

function sanitize(text: string, urls: readonly string[]): string {
  let out = text;
  for (const u of urls) if (u) out = out.split(u).join('<remote>');
  return cleanRemoteText(redact(out));
}

// ───────────────────────────── identity and messages ─────────────────────────────

const TRAILER_KEYS = /^\s*(co-authored-by|signed-off-by|reviewed-by|helped-by|generated-by)\s*:/i;
const AGENT_BOILERPLATE = /^\s*(?:🤖\s*)?(built by conductor|generated (?:with|by)\b.*|created (?:with|by)\b.*(claude|cursor|conductor|codex|copilot|gemini))/i;

function trailerIsAgent(line: string): boolean {
  if (AGENT_BOILERPLATE.test(line) && /(conductor|claude|cursor|codex|copilot|gemini|anthropic|openai|techteam)/i.test(line)) return true;
  if (!TRAILER_KEYS.test(line)) return false;
  const low = line.toLowerCase();
  return AGENT_TERMS.some((t) => low.includes(t));
}

/** Remove agent trailers ("Built by Conductor", Co-Authored-By an agent, "Generated with ..."). Other text is untouched. */
export function cleanMessage(message: string): string {
  const kept = message.replace(/\r\n/g, '\n').split('\n').filter((l) => !trailerIsAgent(l));
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${text || 'Update'}\n`;
}
const TICKET_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;
const ANY_KEY_PREFIX_RE = /^\s*[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}:/;
/** True when the subject (first line) starts with some ticket key (`KEY-n:`), whichever one. */
export const subjectHasAnyKey = (message: string): boolean => ANY_KEY_PREFIX_RE.test(message);
/** True when the subject (first line) starts with `KEY:`. */
export const subjectHasKey = (message: string, key: string): boolean => message.replace(/^\s+/, '').startsWith(`${key}:`);
/** Prepend `KEY: ` to the subject when it is missing. Everything else is untouched. */
export function withTicketKey(message: string, key: string | null | undefined): string {
  if (!key || !TICKET_KEY_RE.test(key) || subjectHasKey(message, key)) return message;
  return `${key}: ${message.replace(/^\s+/, '')}`;
}
export const messageHasAgentTrailer = (message: string): boolean => message.split('\n').some(trailerIsAgent);

interface Info {
  sha: string;
  parents: string[];
  an: string;
  ae: string;
  ad: string;
  cn: string;
  ce: string;
  cd: string;
  message: string;
}

async function infoOf(repoRoot: string, shas: string[]): Promise<Info[] | null> {
  if (shas.length === 0) return [];
  const out: Info[] = [];
  for (const sha of shas) {
    const r = await git(repoRoot, ['log', '--no-walk', '--no-color', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B', sha]);
    if (r.code !== 0) return null;
    const f = r.stdout.replace(/\n$/, '').split('\x1f');
    if (f.length < 9) return null;
    out.push({ sha: f[0]!, parents: f[1]!.split(' ').filter(Boolean), an: f[2]!, ae: f[3]!, ad: f[4]!, cn: f[5]!, ce: f[6]!, cd: f[7]!, message: f.slice(8).join('\x1f') });
  }
  return out;
}

// ───────────────────────────── range, replay ─────────────────────────────

async function rangeOf(repoRoot: string, tip: string, exclude: string[]): Promise<string[] | null> {
  const r = await git(repoRoot, ['rev-list', '--topo-order', '--reverse', tip, '--not', ...exclude]);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function hasObject(repoRoot: string, sha: string): Promise<boolean> {
  return (await git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`])).code === 0;
}

async function isAncestor(repoRoot: string, a: string, b: string): Promise<boolean> {
  return (await git(repoRoot, ['merge-base', '--is-ancestor', a, b])).code === 0;
}

export function safeEditPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.startsWith('-') || p.includes('\0') || p.includes('\\')) return false;
  if (p.split('/').some((s) => s === '..' || s === '' || s === '.git')) return false;
  return !(p === '.conductor' || p.startsWith('.conductor/') || p.startsWith('.cursor/'));
}

export async function applyEdits(repoRoot: string, tree: string, edits: Record<string, string | null>): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-ship-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    if ((await git(repoRoot, ['read-tree', tree], { env })).code !== 0) return null;
    for (const [path, content] of Object.entries(edits)) {
      if (!safeEditPath(path)) return null;
      const cur = await git(repoRoot, ['ls-files', '-s', '--', path], { env });
      const mode = cur.stdout.split(' ')[0] ?? '';
      if (mode === '120000' || mode === '160000') return null;
      if (content === null) {
        if ((await git(repoRoot, ['update-index', '--force-remove', '--', path], { env })).code !== 0) return null;
        continue;
      }
      const blob = await git(repoRoot, ['hash-object', '-w', '--stdin'], { env, input: content });
      if (blob.code !== 0 || !SHA_RE.test(blob.stdout.trim())) return null;
      const add = await git(repoRoot, ['update-index', '--add', '--cacheinfo', `${mode || '100644'},${blob.stdout.trim()},${path}`], { env });
      if (add.code !== 0) return null;
    }
    const wrote = await git(repoRoot, ['write-tree'], { env });
    return wrote.code === 0 && SHA_RE.test(wrote.stdout.trim()) ? wrote.stdout.trim() : null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface Replayed {
  tip: string;
  map: Record<string, string>;
}

/**
 * Rebuild the range (oldest first) with plumbing only. A commit is rewritten when its author or committer is an agent, its
 * message carries an agent trailer, it has fixture edits, or its parent changed. Dates are preserved, so a rerun makes the same shas.
 * Returns an error string when a replay step cannot be done cleanly (the caller holds).
 */
async function replay(
  repoRoot: string,
  infos: Info[],
  person: Person,
  developer: Person | null | undefined,
  edits: FixtureEdits,
  keyFor?: (sha: string, message: string) => string | null,
): Promise<Replayed | string> {
  const map: Record<string, string> = {};
  let newParent: string | null = null;
  let changed = false;
  for (const c of infos) {
    const oldParent = c.parents[0]!;
    const authorAgent = isAgentIdentity(c.an, c.ae, developer);
    const committerAgent = isAgentIdentity(c.cn, c.ce, developer);
    const msg = withTicketKey(cleanMessage(c.message), keyFor?.(c.sha, c.message));
    const dirty = msg.trimEnd() !== c.message.replace(/\r\n/g, '\n').trimEnd();
    const edit = edits[c.sha];
    const own = authorAgent || committerAgent || dirty || !!edit;
    if (!own && !changed) {
      newParent = c.sha;
      continue;
    }
    const base: string = newParent ?? oldParent;
    let tree: string;
    if (base === oldParent) {
      tree = (await git(repoRoot, ['rev-parse', `${c.sha}^{tree}`])).stdout.trim();
    } else {
      const mt = await git(repoRoot, ['merge-tree', '--write-tree', `--merge-base=${oldParent}`, base, c.sha]);
      if (mt.code !== 0) return `commit ${short(c.sha)} no longer applies cleanly after an earlier commit was rewritten`;
      tree = mt.stdout.split('\n')[0]!.trim();
    }
    if (!SHA_RE.test(tree)) return `could not rebuild commit ${short(c.sha)}`;
    if (edit) {
      const t2 = await applyEdits(repoRoot, tree, edit);
      if (!t2) return `could not apply the fixture rewrite to commit ${short(c.sha)}`;
      tree = t2;
    }
    const env = {
      GIT_AUTHOR_NAME: authorAgent ? person.name : c.an,
      GIT_AUTHOR_EMAIL: authorAgent ? person.email : c.ae,
      GIT_AUTHOR_DATE: c.ad,
      GIT_COMMITTER_NAME: committerAgent ? person.name : c.cn,
      GIT_COMMITTER_EMAIL: committerAgent ? person.email : c.ce,
      GIT_COMMITTER_DATE: c.cd,
    };
    const made = await git(repoRoot, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', base, '-F', '-'], { env, input: msg });
    const sha = made.stdout.trim();
    if (made.code !== 0 || !SHA_RE.test(sha)) return `could not write the rebuilt commit for ${short(c.sha)}`;
    newParent = sha;
    if (sha !== c.sha) {
      map[c.sha] = sha;
      changed = true;
    }
  }
  return { tip: newParent ?? infos[infos.length - 1]!.sha, map };
}

const tempRef = (remote: string, target: string): string => `refs/conductor/ship/${createHash('sha256').update(`${remote}\0${target}`).digest('hex').slice(0, 24)}`;

// ───────────────────────────── prepare ─────────────────────────────

async function defaultScan(): Promise<ScanFn | null> {
  try {
    const m = (await import('./branchscan.ts')) as unknown as { scanPushRange?: ScanFn };
    return typeof m.scanPushRange === 'function' ? m.scanPushRange : null;
  } catch {
    return null;
  }
}

/** Violations that stop a push: merge/root commits, agent identity (author AND committer), agent trailers. First one wins. */
function rangeProblem(infos: Info[], developer: Person | null | undefined, owners: Readonly<Record<string, string>>, back: Record<string, string>): string | null {
  for (const c of infos) {
    const who = nameOf(c.sha, owners, back);
    if (c.parents.length !== 1) return `${who} is a ${c.parents.length === 0 ? 'root' : 'merge'} commit. Conductor does not push merge commits.`;
    if (isAgentIdentity(c.an, c.ae, developer) || isAgentIdentity(c.cn, c.ce, developer)) return `${who} still carries an agent name as author or committer. Set git user.name/user.email to your own name.`;
    if (messageHasAgentTrailer(c.message)) return `${who} has an agent trailer in its message.`;
  }
  return null;
}

function nameOf(sha: string, owners: Readonly<Record<string, string>>, back: Record<string, string>): string {
  const key = owners[sha] ?? owners[back[sha] ?? ''];
  return key ? `${key}'s commit ${short(sha)}` : `commit ${short(sha)}`;
}

async function prepareUnlocked(input: ShipInput): Promise<PrepareResult> {
  let root: string;
  try {
    root = await realpath(input.repoRoot);
  } catch {
    return hold('The repository path is not available.');
  }
  // the checked-out branch is read ONCE, here; pushShip re-verifies it (and HEAD) immediately before the push
  const branch = await checkedOutBranch(root);
  const head = await headSha(root);
  const insp = await inspectRemote(root, input.remote);
  if (!insp.ok) return insp;
  const tipRef = (await git(root, ['rev-parse', '--verify', '--quiet', `${input.tip ?? 'HEAD'}^{commit}`])).stdout.trim();
  if (!SHA_RE.test(tipRef)) return hold('There is nothing to ship: the commit to push does not exist.');
  const chosen = await chooseTarget(root, insp.info, branch, input.key, tipRef);
  if (!chosen.ok) return chosen;
  const t = chosen.t;
  const owners = input.owners ?? {};
  const recorded = new Set(input.recordedShas.filter((s) => SHA_RE.test(s)));

  // Idempotent: the remote branch already holds this commit (a crash after the push, or a second click).
  if (t.liveTip && (t.liveTip === tipRef || ((await hasObject(root, t.liveTip)) && (await isAncestor(root, tipRef, t.liveTip))))) {
    return { ok: true, prepared: { sha: tipRef, replacements: {}, remote: t.remote, target: t.target, checkedOut: branch, headSha: head, fallback: chosen.fallback, alreadyPublished: true, range: [] } };
  }

  // 1. identity: the developer, from the snapshot taken before any agent ran
  const me = input.identity ? checkPerson(input.identity.name, input.identity.email, input.developerIdentity) : await live(root, input.developerIdentity);
  if (!me.ok) return hold(me.detail);

  // 2. range = the commits that would leave the machine
  const local = t.liveTip ? await hasObject(root, t.liveTip) : false;
  // only LIVE ls-remote tips that exist locally bound the range. A tracking ref can be stale (branch deleted or purged on the remote), and
  // excluding through it would push commits that were never scanned.
  const publishedTips: string[] = [];
  for (const s of t.liveHeads) if (SHA_RE.test(s) && !publishedTips.includes(s) && (await hasObject(root, s))) publishedTips.push(s);
  const exclude = t.liveTip && local ? [t.liveTip] : publishedTips;
  const range = await rangeOf(root, tipRef, exclude);
  if (!range) return hold('Could not work out which commits would be pushed.');
  if (range.length > MAX_RANGE) return hold(`More than ${MAX_RANGE} commits would be pushed. Ship holds.`);
  let infos = await infoOf(root, range);
  if (!infos) return hold('Could not read the commits that would be pushed.');
  for (const c of infos) {
    if (c.parents.length !== 1) return hold(`${nameOf(c.sha, owners, {})} is a ${c.parents.length === 0 ? 'root' : 'merge'} commit. Conductor does not push merge commits.`);
    if (!recorded.has(c.sha)) {
      if (owners[c.sha]) return hold(`Blocked by ${nameOf(c.sha, owners, {})}: its card is not finished (or was canceled), and its commit is on the branch below this one. It is pushed only once that card is done.`);
      return hold(`${nameOf(c.sha, owners, {})} is not one Conductor made. Conductor never pushes work you did not hand over. Push or move it first.`);
    }
  }

  // 3. reauthor + message cleanup. Only commits that need it; only unpublished ones; never the checked-out branch.
  const developer = input.developerIdentity;
  // UNPUBLISHED commits Conductor recorded whose subject lacks the ticket key get `KEY: ` prepended by the replay. Never a published or non-Conductor commit.
  // The owning card's key when known. A recorded commit with no known owner (e.g. a replacement sha from an earlier pass) already
  // carrying some ticket key is left alone, so a rerun never double-prefixes.
  const keyFor = (sha: string, message: string): string | null => {
    if (!recorded.has(sha) && !recorded.has(back[sha] ?? '')) return null;
    const owner = owners[sha] ?? owners[back[sha] ?? ''];
    if (owner) return owner;
    return subjectHasAnyKey(message) ? null : input.key;
  };
  const lacksKey = (c: Info): boolean => {
    const k = keyFor(c.sha, c.message);
    return !!k && TICKET_KEY_RE.test(k) && !subjectHasKey(c.message, k);
  };
  const needs = (list: Info[]): Info[] => list.filter((c) => isAgentIdentity(c.an, c.ae, developer) || isAgentIdentity(c.cn, c.ce, developer) || messageHasAgentTrailer(c.message) || lacksKey(c));
  const back: Record<string, string> = {};
  const replacements: Record<string, string> = {};
  const fold = (map: Record<string, string>): void => {
    for (const [o, n] of Object.entries(map)) {
      const origin = Object.keys(replacements).find((k) => replacements[k] === o) ?? o;
      replacements[origin] = n;
      back[n] = origin;
    }
  };
  let finalTip = tipRef;
  const rewrite = async (edits: FixtureEdits): Promise<string | null> => {
    const pending = needs(infos!).concat(infos!.filter((c) => edits[c.sha]));
    for (const c of pending) {
      for (const p of publishedTips) if (p === c.sha || (await isAncestor(root, c.sha, p))) return `${nameOf(c.sha, owners, back)} is already on the remote, so it cannot be rewritten.`;
    }
    const out = await replay(root, infos!, me.person, developer, edits, keyFor);
    if (typeof out === 'string') return out;
    fold(out.map);
    finalTip = out.tip;
    const again = await rangeOf(root, finalTip, exclude);
    const info2 = again ? await infoOf(root, again) : null;
    if (!info2) return 'Could not re-read the commits after rewriting them.';
    infos = info2;
    return null;
  };
  if (needs(infos).length) {
    const err = await rewrite({});
    if (err) return hold(err);
  }
  let problem = rangeProblem(infos, developer, owners, back);
  if (problem) return hold(problem);

  // 4. scan the final range (the range that is pushed). Fail closed: an unavailable scanner is a hold.
  const scan = input.scan ?? (await defaultScan());
  if (!scan) return hold('The push scan is not available, so nothing is pushed.');
  const runScan = async (): Promise<ScanResult> => {
    try {
      return await scan({ repoRoot: root, tip: finalTip, excludeTips: exclude, envEntries: input.envEntries ?? [], ...(input.maxCommitBytes ? { maxCommitBytes: input.maxCommitBytes } : {}) });
    } catch (e) {
      return { ok: false, reason: `the scan failed to run (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`, commits: [], files: [] };
    }
  };
  let scanned = await runScan();
  if (!scanned.ok && input.fixtureRewrite) {
    // fixup the introducing Conductor-only commit; the secret commit leaves the range
    let edits: FixtureEdits | null = null;
    try {
      edits = await input.fixtureRewrite({ repoRoot: root, reason: redact(scanned.reason), commits: scanned.commits, files: scanned.files });
    } catch {
      edits = null;
    }
    const inRange = new Set(infos.map((c) => c.sha));
    if (edits && Object.keys(edits).length && Object.keys(edits).every((s) => inRange.has(s))) {
      const err = await rewrite(edits);
      if (err) return hold(err);
      problem = rangeProblem(infos, developer, owners, back);
      if (problem) return hold(problem);
      scanned = await runScan();
    }
  }
  if (!scanned.ok) {
    const names = scanned.commits.slice(0, 5).map((s) => nameOf(s, owners, back));
    return hold(`Blocked by ${names.length ? names.join(', ') : 'the push scan'}: ${scanned.reason}`);
  }

  // 5. the sha that was scanned is the sha that is pushed
  const again = (await git(root, ['rev-parse', '--verify', '--quiet', `${finalTip}^{commit}`])).stdout.trim();
  if (again !== finalTip) return hold('The commit to push changed while it was being checked. Nothing was pushed.');
  const ref = await git(root, ['update-ref', tempRef(t.remote, t.target), finalTip]);
  if (ref.code !== 0) return hold('Could not record the commit to push.');
  return { ok: true, prepared: { sha: finalTip, replacements, remote: t.remote, target: t.target, checkedOut: branch, headSha: head, fallback: chosen.fallback, alreadyPublished: false, range: infos.map((c) => c.sha) } };
}

async function live(root: string, dev: Person | null | undefined): Promise<ReturnType<typeof checkPerson>> {
  const name = (await git(root, ['config', '--get', 'user.name'])).stdout.trim();
  const email = (await git(root, ['config', '--get', 'user.email'])).stdout.trim();
  return checkPerson(name, email, dev);
}

/**
 * Re-run the push scan over the commits that would leave the machine, for callers that just changed commits (the Stuck resolver after an exclude,
 * rewrite or revert). Same range rule as prepareShip (bounded by the live remote tip of the checked-out branch, else every published head that exists
 * locally) and fail-closed: an unavailable scanner, an unreachable remote or a scan that throws is { ok: false }.
 */
export async function rescanRange(input: { repoRoot: string; remote: string; tip: string; envEntries?: EnvEntry[]; maxCommitBytes?: number; scan?: ScanFn }): Promise<ScanResult> {
  const fail = (reason: string): ScanResult => ({ ok: false, reason: redact(reason).slice(0, 300), commits: [], files: [] });
  let root: string;
  try {
    root = await realpath(input.repoRoot);
  } catch {
    return fail('the repository path is not available');
  }
  if (!SHA_RE.test(input.tip) || !(await hasObject(root, input.tip))) return fail('the commit to scan does not exist');
  const insp = await inspectRemote(root, input.remote);
  if (!insp.ok) return fail(insp.hold.reason);
  const branch = await checkedOutBranch(root);
  const own = branch ? insp.info.refs.get(`refs/heads/${branch}`) : undefined;
  const exclude: string[] = [];
  if (own && (await hasObject(root, own))) exclude.push(own);
  else for (const h of insp.info.heads) if (await hasObject(root, h)) exclude.push(h);
  const scan = input.scan ?? (await defaultScan());
  if (!scan) return fail('the push scan is not available');
  try {
    return await scan({ repoRoot: root, tip: input.tip, excludeTips: exclude, envEntries: input.envEntries ?? [], ...(input.maxCommitBytes ? { maxCommitBytes: input.maxCommitBytes } : {}) });
  } catch (e) {
    return fail(`the scan failed to run (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`);
  }
}

// ───────────────────────────── push ─────────────────────────────

/** The one pinned argv. Exported for the argv test; `-c` options come BEFORE `push`. */
export function pushArgv(remote: string, sha: string, target: string): string[] {
  return [
    '-c', 'push.pushOption=', '-c', 'push.default=nothing', '-c', 'push.followTags=false',
    'push', '--no-force-with-lease', '--no-follow-tags', '--no-recurse-submodules', '--no-tags',
    remote, `${sha}:refs/heads/${target}`,
  ];
}

async function pushUnlocked(input: PushInput): Promise<PushResult> {
  let root: string;
  try {
    root = await realpath(input.repoRoot);
  } catch {
    return hold('The repository path is not available.');
  }
  const sha = input.sha;
  if (!SHA_RE.test(sha)) return hold('The commit to push is not a valid commit id.');
  const fallback = input.target.startsWith('conductor/') && input.target !== input.checkedOut;
  const v = await validateTarget(root, input.remote, input.target, fallback);
  if (!v.ok) return v;
  const t = v.t;
  const now = (await git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).stdout.trim();
  if (now !== sha) return hold('The commit to push is not in this repository. Nothing was pushed.');
  const prepared = (await git(root, ['rev-parse', '--verify', '--quiet', tempRef(t.remote, t.target)])).stdout.trim();
  if (prepared !== sha) return hold('That commit was not the one that passed the push scan. Nothing was pushed.');
  if (t.liveTip && (t.liveTip === sha || ((await hasObject(root, t.liveTip)) && (await isAncestor(root, sha, t.liveTip))))) return { ok: true, sha, pushed: false };
  // immediately before the push: the checked-out branch and HEAD are what prepare saw (the user switched, committed or reset => hold, retry later)
  if ((await checkedOutBranch(root)) !== input.checkedOut || (await headSha(root)) !== input.headSha) return hold('The checked-out branch or its tip changed while the push was being prepared. Nothing was pushed. Conductor tries again later.');
  if (t.liveTip && !(t.liveTip === sha || ((await hasObject(root, t.liveTip)) && (await isAncestor(root, t.liveTip, sha))))) return hold('The remote branch moved and the push is no longer a fast-forward. Nothing was forced. Conductor tries again later.');
  const out = await git(root, pushArgv(t.remote, sha, t.target), { timeoutMs: PUSH_TIMEOUT_MS });
  if (out.code !== 0) {
    const why = sanitize(`${out.stderr}\n${out.stdout}`, t.urls);
    if (/non-fast-forward|fetch first|rejected/i.test(why)) return hold(`The remote branch has commits Conductor does not have, so it is not a fast-forward. Nothing was forced. ${why}`);
    return hold(out.timedOut ? 'The push timed out.' : why ? `The push did not finish: ${why}` : 'The push did not finish.');
  }
  return { ok: true, sha, pushed: true };
}

// ───────────────────────────── public API (serialized per repo) ─────────────────────────────

export async function prepareShip(input: ShipInput): Promise<PrepareResult> {
  return withRepoLock(await keyOf(input.repoRoot), () => prepareUnlocked(input));
}

export async function pushShip(input: PushInput): Promise<PushResult> {
  return withRepoLock(await keyOf(input.repoRoot), () => pushUnlocked(input));
}

/**
 * Prepare, let the engine persist (`persist` runs after the scan and BEFORE the push; if it throws, nothing is pushed), then push.
 * `replacements` and `sha` are in `prepared`.
 */
export async function ship(input: ShipInput & { persist?: (p: Prepared) => Promise<void> | void }): Promise<({ ok: true; prepared: Prepared; pushed: boolean } | Hold)> {
  return withRepoLock(await keyOf(input.repoRoot), async () => {
    const prep = await prepareUnlocked(input);
    if (!prep.ok) return prep;
    if (input.persist) {
      try {
        await input.persist(prep.prepared);
      } catch {
        return hold('Could not record the commit to push, so nothing was pushed.');
      }
    }
    if (prep.prepared.alreadyPublished) return { ok: true, prepared: prep.prepared, pushed: false };
    if (input.beforePush) {
      let why: string | null;
      try {
        why = await input.beforePush();
      } catch {
        why = 'The last check before pushing could not run.';
      }
      if (why) return hold(why);
    }
    const res = await pushUnlocked({ repoRoot: input.repoRoot, remote: input.remote, target: prep.prepared.target, sha: prep.prepared.sha, checkedOut: prep.prepared.checkedOut, headSha: prep.prepared.headSha });
    if (!res.ok) return res;
    return { ok: true, prepared: prep.prepared, pushed: res.pushed };
  });
}

async function keyOf(repoRoot: string): Promise<string> {
  try {
    return await realpath(repoRoot);
  } catch {
    return repoRoot;
  }
}
