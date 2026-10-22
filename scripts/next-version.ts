// Computes the next release version from Conventional Commits since the last vX.Y.Z tag. Zero dependencies, run by Node's type stripping:
//   node scripts/next-version.ts [--bump auto|patch|minor|major]
// Prints `release=…`, `version=…`, `tag=…`, `bump=…` lines (append them to $GITHUB_OUTPUT). The git tag is the source of truth for the
// version; nothing is written back to the repository. Commit text is only ever parsed as data: git is run without a shell, and the only
// values printed are a bump keyword and a strictly validated X.Y.Z.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export type Bump = 'major' | 'minor' | 'patch';
export type Override = 'auto' | Bump;
type Kind = 'patch' | 'minor' | 'breaking';
export interface Commit { subject: string; body: string; parents: number }
export interface Next { release: boolean; version: string; tag: string; bump: Bump | 'none' }
type Semver = readonly [number, number, number];

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SUBJECT = /^([a-z]+)(\([^)\n]*\))?(!)?: \S/;
const FOOTER = /^BREAKING[ -]CHANGE: \S/m;
const MINOR_TYPES = new Set(['feat']);
const PATCH_TYPES = new Set(['fix', 'perf', 'revert']);

/** Only `vX.Y.Z` is a release tag: `v1.2.3-rc1`, `v1.2`, `foo` and friends are ignored. */
export function parseTag(tag: string): Semver | null {
  const m = TAG.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isValidVersion(v: string): boolean {
  return VERSION.test(v);
}

export function compareVersions(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The highest SemVer tag (not the newest by date, not the last alphabetically). */
export function highestTag(tags: readonly string[]): string | null {
  let best: string | null = null;
  let bestV: Semver | null = null;
  for (const t of tags) {
    const v = parseTag(t);
    if (v && (!bestV || compareVersions(v, bestV) > 0)) { best = t; bestV = v; }
  }
  return best;
}

/** What one commit asks for. Merge commits are skipped (their parents are parsed on their own); housekeeping never releases. */
export function classify(commit: Commit): Kind | null {
  if (commit.parents > 1 || /^Merge /.test(commit.subject)) return null;
  if (/^Revert "/.test(commit.subject)) return 'patch';
  const m = SUBJECT.exec(commit.subject);
  if (!m) return null;
  const type = m[1] as string;
  if (m[3] === '!' || FOOTER.test(commit.body)) return 'breaking';
  if (MINOR_TYPES.has(type)) return 'minor';
  if (PATCH_TYPES.has(type)) return 'patch';
  return null;
}

const RANK = { patch: 1, minor: 2, breaking: 3 } as const;

export function computeNext(input: { tags: readonly string[]; commits: readonly Commit[]; override?: Override }): Next {
  const none: Next = { release: false, version: '', tag: '', bump: 'none' };
  const override = input.override ?? 'auto';
  if (input.commits.length === 0) return none; // nothing new since the last tag
  let top: Kind | null = null;
  for (const c of input.commits) {
    const k = classify(c);
    if (k && (!top || RANK[k] > RANK[top])) top = k;
  }
  const base = highestTag(input.tags);
  const baseV = base ? parseTag(base) : null;
  let bump: Bump | null;
  if (override !== 'auto') bump = override;
  else if (top === null) bump = null;
  else if (top === 'breaking') bump = baseV && baseV[0] === 0 ? 'minor' : 'major'; // before 1.0 a breaking change is a minor; 1.0.0 only by override
  else bump = top;
  if (!bump) return none;
  let next: Semver;
  if (!baseV) next = bump === 'major' ? [1, 0, 0] : [0, 1, 0]; // first release
  else if (bump === 'major') next = [baseV[0] + 1, 0, 0];
  else if (bump === 'minor') next = [baseV[0], baseV[1] + 1, 0];
  else next = [baseV[0], baseV[1], baseV[2] + 1];
  const version = next.join('.');
  if (!isValidVersion(version)) throw new Error(`computed an invalid version: ${version}`);
  const tag = `v${version}`;
  if (input.tags.includes(tag)) return none; // idempotent: the release already exists
  return { release: true, version, tag, bump };
}

/** Tags plus the commits after the highest release tag (all history when there is none). Git runs without a shell. */
export function readGit(cwd: string): { tags: string[]; commits: Commit[] } {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tags = git('tag', '--list').split('\n').map((t) => t.trim()).filter(Boolean);
  const base = highestTag(tags);
  const range = base ? [`refs/tags/${base}..HEAD`] : ['HEAD'];
  const raw = git('log', '--format=%H%x1f%P%x1f%s%x1f%b%x1e', ...range);
  const commits: Commit[] = [];
  for (const rec of raw.split('\x1e')) {
    const r = rec.replace(/^\n/, '');
    if (!r.trim()) continue;
    const [, parents = '', subject = '', ...body] = r.split('\x1f');
    commits.push({ subject, body: body.join('\x1f'), parents: parents.trim() ? parents.trim().split(/\s+/).length : 0 });
  }
  return { tags, commits };
}

function main(argv: string[]): void {
  let override: Override = 'auto';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    let value: string | undefined;
    if (a === '--bump') value = argv[++i];
    else if (a.startsWith('--bump=')) value = a.slice('--bump='.length);
    else throw new Error(`unknown argument: ${a}`);
    if (value !== 'auto' && value !== 'patch' && value !== 'minor' && value !== 'major') throw new Error(`--bump must be auto, patch, minor or major (got ${JSON.stringify(value)})`);
    override = value;
  }
  const { tags, commits } = readGit(process.cwd());
  const n = computeNext({ tags, commits, override });
  process.stdout.write(`release=${n.release}\nversion=${n.version}\ntag=${n.tag}\nbump=${n.bump}\n`);
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`next-version: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
}
