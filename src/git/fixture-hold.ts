// Complete auto may ask the builder once to rewrite credential-SHAPED text that appears only in tests or fixtures.
// It never skips the scan: secret file names, copied .env values, and the same shapes in any other path still stop the run.

const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/i;
const FIXTURE_DIR = /(?:^|\/)(?:fixtures|__fixtures__)(?:\/|$)/;

/** A repository-relative path that is a test file or lives under a fixtures directory. */
export function testOrFixturePath(p: string): boolean {
  const n = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  return TEST_FILE.test(n) || FIXTURE_DIR.test(n);
}

export interface FixtureContentHold {
  paths: string[];
  /** True when the secret is already on a commit (branch scan). False when commitAll refused and the tree is still dirty. */
  committed: boolean;
}

const COMMIT_PREFIX = 'Conductor refused to commit: ';
const COMMIT_SUFFIX = '. Nothing was committed.';
const BRANCH_PREFIX = 'The branch contains what looks like a secret (';
const BRANCH_SUFFIX = '). Nothing was pushed. Remove it from the branch history before continuing.';

/**
 * A hold Conductor may turn into one rewrite, or null when any cited problem is not credential-shaped content in a test/fixture path.
 * Parses the two messages the envelope actually emits (commit guard, branch scan). Anything else is not a fixture hold.
 */
export function fixtureContentHold(reason: string): FixtureContentHold | null {
  const text = reason.replace(/\r\n/g, '\n').trim();
  if (text.startsWith(COMMIT_PREFIX) && text.endsWith(COMMIT_SUFFIX)) {
    const detail = text.slice(COMMIT_PREFIX.length, text.length - COMMIT_SUFFIX.length);
    const paths: string[] = [];
    for (const line of detail.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const m = /^secret-looking content in added lines: (\S+)$/.exec(t);
      if (!m || !testOrFixturePath(m[1]!)) return null;
      paths.push(m[1]!);
    }
    return paths.length ? { paths, committed: false } : null;
  }
  if (text.startsWith(BRANCH_PREFIX) && text.endsWith(BRANCH_SUFFIX)) {
    const detail = text.slice(BRANCH_PREFIX.length, text.length - BRANCH_SUFFIX.length);
    const paths: string[] = [];
    for (const part of detail.split(';')) {
      const t = part.trim();
      if (!t) continue;
      const m = /^(\S+) \(credential-shaped value\)$/.exec(t);
      if (!m || !testOrFixturePath(m[1]!)) return null;
      paths.push(m[1]!);
    }
    return paths.length ? { paths, committed: true } : null;
  }
  return null;
}

/** Instruction handed to the next build. Static wording plus the paths — never the secret text. */
export function fixtureRewriteNote(paths: readonly string[]): string {
  const list = paths.slice(0, 8).join(', ');
  return `Conductor refused to record this change because ${list} contain credential-shaped text. Rewrite those strings to obvious placeholders that are not real tokens (no ghp_, sk-, eyJ JWT, PEM private keys, or similar). Keep the tests. Do not commit or push — Conductor commits on this local worktree only, and never pushes.`;
}

export interface FixtureRewritePlan {
  paths: string[];
  note: string;
  committed: boolean;
  nextUsed: number;
}

/** One rewrite per counter. `used >= 1` (or a hold that is not test/fixture content) returns null — the caller asks a person. */
export function planFixtureRewrite(used: number | undefined, reason: string): FixtureRewritePlan | null {
  if ((used ?? 0) >= 1) return null;
  const hold = fixtureContentHold(reason);
  if (!hold) return null;
  return { paths: hold.paths, note: fixtureRewriteNote(hold.paths), committed: hold.committed, nextUsed: (used ?? 0) + 1 };
}
