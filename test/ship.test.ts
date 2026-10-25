// Ship (R4-2/3/6/7, Addendum A): real temp repos and a BARE temp remote only. Nothing here can reach a real remote.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fingerprint, isolateGitHome, makeBareRemote, makeRepo, refsOf, sg, sgt, sgTry, tmpDir } from './helpers/tmp-repo.ts';
import type { ScanFn } from '../src/git/ship.ts';

isolateGitHome();
// SHIP_IMPL lets the mutation runner point these same tests at a deliberately broken copy of ship.ts.
const ship = (await import(process.env.SHIP_IMPL ?? '../src/git/ship.ts')) as typeof import('../src/git/ship.ts');

// Ship pushes to the branch checked out in the repository: the tests check out this one (a plain feature branch).
const TARGET = 'work/ship';
const AGENT = { name: 'Conductor', email: 'conductor@localhost' };
const AGENT_MSG = (k: string): string => `${k}: add feature\n\nBuilt by Conductor (${k})\nCo-Authored-By: Claude <noreply@anthropic.com>\n`;

function commitAs(dir: string, who: { name: string; email: string }, msg: string, file: string, content: string, committer = who): string {
  execFileSync('sh', ['-c', `mkdir -p "$(dirname "${file}")" && printf %s "$CONTENT" > "${file}"`], { cwd: dir, env: { ...process.env, CONTENT: content } });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email,
    GIT_AUTHOR_DATE: '2026-01-02T03:04:05+00:00', GIT_COMMITTER_DATE: '2026-01-02T03:04:06+00:00', GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim();
}

interface World {
  r: ReturnType<typeof makeRepo> & { remote: string | null };
  remote: string;
  shas: string[];
  owners: Record<string, string>;
  base: Parameters<typeof ship.prepareShip>[0];
  scanCalls: Array<{ tip: string; excludeTips: string[] }>;
}

function world(opts: { author?: { name: string; email: string }; n?: number; identity?: boolean } = {}): World {
  const r = makeRepo({ withRemote: true });
  if (opts.identity !== false) {
    sg(r.dir, ['config', 'user.name', 'Ada Lovelace']);
    sg(r.dir, ['config', 'user.email', 'ada@example.test']);
  }
  sg(r.dir, ['checkout', '-q', '-b', TARGET]);
  const shas: string[] = [];
  const owners: Record<string, string> = {};
  for (let i = 1; i <= (opts.n ?? 2); i++) {
    const s = commitAs(r.dir, opts.author ?? AGENT, AGENT_MSG(`KEE-${i}`), `src/f${i}.js`, `export const f${i} = ${i};\n`);
    shas.push(s);
    owners[s] = `KEE-${i}`;
  }
  const scanCalls: Array<{ tip: string; excludeTips: string[] }> = [];
  const scan: ScanFn = async (o) => {
    scanCalls.push({ tip: o.tip, excludeTips: o.excludeTips });
    return { ok: true };
  };
  return { r, remote: r.remote!, shas, owners, scanCalls, base: { repoRoot: r.dir, remote: 'origin', key: 'KEE-1', recordedShas: shas, owners, scan } };
}

const remoteRefs = (w: World): string => refsOf(w.remote);
const remoteLog = (w: World): string[] => sgt(w.remote, ['log', '--format=%an <%ae>|%cn <%ce>|%B%x1e', `refs/heads/main..refs/heads/${TARGET}`]).split('\x1e').map((s) => s.trim()).filter(Boolean);
const reason = (x: { ok: boolean; hold?: { reason: string } }): string => (x.ok ? '' : x.hold!.reason);

describe('ship: the happy path and what it must not touch', () => {
  it('pushes the scanned sha to the checked-out branch, as the developer, with agent trailers stripped, and leaves the checkout alone', async () => {
    const w = world();
    const before = fingerprint(w.r.dir);
    const branch = sgt(w.r.dir, ['symbolic-ref', 'HEAD']);
    const res = await ship.ship(w.base);
    assert.equal(res.ok, true, reason(res));
    if (!res.ok) return;
    assert.equal(res.pushed, true);
    assert.deepEqual([res.prepared.target, res.prepared.fallback, res.prepared.checkedOut], [TARGET, false, TARGET]);
    assert.equal(sgt(w.remote, ['rev-parse', `refs/heads/${TARGET}`]), res.prepared.sha);
    assert.equal(Object.keys(res.prepared.replacements).length, 2);
    for (const line of remoteLog(w)) {
      assert.match(line, /^Ada Lovelace <ada@example\.test>\|Ada Lovelace <ada@example\.test>\|/);
      assert.doesNotMatch(line, /Built by Conductor|Co-Authored-By|Claude|noreply/i);
    }
    assert.match(remoteRefs(w), /refs\/heads\/main /);
    assert.equal(sgt(w.remote, ['rev-parse', 'refs/heads/main']), sgt(w.r.dir, ['rev-parse', 'origin/main']));
    assert.equal(fingerprint(w.r.dir), before, 'the user checkout, index and branch are untouched');
    assert.equal(sgt(w.r.dir, ['symbolic-ref', 'HEAD']), branch);
    assert.equal(sgt(w.r.dir, ['rev-parse', 'HEAD']), w.shas[1]);
  });

  it('scans exactly the sha it then pushes, over the range base', async () => {
    const w = world();
    const res = await ship.ship(w.base);
    assert.ok(res.ok);
    assert.ok(w.scanCalls.length >= 1, 'the scanner is called');
    assert.equal(w.scanCalls[w.scanCalls.length - 1]!.tip, res.ok ? res.prepared.sha : '');
    assert.ok(w.scanCalls[0]!.excludeTips.includes(sgt(w.r.dir, ['rev-parse', 'origin/main'])), 'the known remote tip is excluded, the rest is scanned');
  });

  it('commits that are already the developer’s, with clean messages, are pushed as they are (nothing is rewritten)', async () => {
    const w = world({ n: 0 });
    const clean = commitAs(w.r.dir, { name: 'Ada Lovelace', email: 'ada@example.test' }, 'KEE-1: plain message\n', 'src/plain.js', 'x\n');
    const res = await ship.prepareShip({ ...w.base, recordedShas: [clean] });
    assert.ok(res.ok, reason(res));
    if (res.ok) {
      assert.equal(res.prepared.sha, clean);
      assert.deepEqual(res.prepared.replacements, {});
    }
  });

  it('only a committer that is an agent is replaced, and the author date is kept', async () => {
    const w = world({ n: 0 });
    const s = commitAs(w.r.dir, { name: 'Grace Hopper', email: 'grace@example.test' }, 'real author\n', 'src/g.js', 'g\n', AGENT);
    const res = await ship.prepareShip({ ...w.base, recordedShas: [s] });
    assert.ok(res.ok, reason(res));
    if (!res.ok) return;
    assert.equal(sgt(w.r.dir, ['log', '-1', '--format=%an|%cn|%aI', res.prepared.sha]), 'Grace Hopper|Ada Lovelace|2026-01-02T03:04:05Z');
  });
});

describe('ship: target and remote validation (R4-2)', () => {
  it('the pure name rules: protected and invalid names are refused as a direct target, the fallback needs the conductor/ prefix', () => {
    for (const bad of ['main', 'master', 'MAIN', 'trunk', 'develop', 'dev', 'HEAD', 'head', 'release', 'release/1.0', 'Release-2', 'refs/heads/main', 'refs/heads/refs/heads/master', '', 'a b', 'a:b', 'a@{1}', 'x.lock', 'a..b', '-x', 'x/', '/x', 'a//b', '.hidden', 'x/.y', 'x~1', 'x^', 'x*']) {
      assert.ok(ship.directTargetRefusal(bad), JSON.stringify(bad));
    }
    for (const ok of ['feature/x', 'work/ship', 'conductor/new-development', 'my-branch_1.2', 'devops', 'maintenance']) assert.equal(ship.directTargetRefusal(ok), null, ok);
    for (const bad of ['main', 'feature/x', 'conductor/main', 'conductor/Develop', 'conductor/release-1', 'conductor/HEAD', 'conductor/a b', 'conductor/a:b', 'conductor/x.lock', 'conductor/', '', 'Conductor/x', 'refs/heads/conductor/x']) {
      assert.ok(ship.badTargetName(bad), JSON.stringify(bad));
    }
    assert.equal(ship.badTargetName('conductor/new-development'), null);
    assert.equal(ship.fallbackBranchName('feature/login page', 'KEE-4'), 'conductor/feature-login-page');
    for (const b of ['main', 'release/1.0', null, 'dev', '...']) assert.equal(ship.fallbackBranchName(b, 'KEE-4'), 'conductor/KEE-4', String(b));
  });

  it('refuses a remote that is a URL, unknown, or has credentials, ext::/fd::/file: schemes, or a bad push URL; never prints the URL', async () => {
    const w = world();
    const refs = remoteRefs(w);
    sg(w.r.dir, ['remote', 'add', 'cred', 'https://user:' + 'hunter2secret@example.invalid/o/r.git']);
    sg(w.r.dir, ['remote', 'add', 'tok', 'https://gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789@example.invalid/o/r.git']);
    sg(w.r.dir, ['remote', 'add', 'ext', 'ext::sh -c touch% /nonexistent-ship-proof']);
    sg(w.r.dir, ['remote', 'add', 'fd', 'fd::17/foo']);
    sg(w.r.dir, ['remote', 'add', 'filescheme', `file://${w.remote}`]);
    sg(w.r.dir, ['remote', 'add', 'pushurl', w.remote]);
    sg(w.r.dir, ['remote', 'set-url', '--push', 'pushurl', 'https://user:' + 'pw12345678@example.invalid/o/r.git']);
    for (const remote of [w.remote, 'https://example.invalid/x.git', 'nope', 'cred', 'tok', 'ext', 'fd', 'filescheme', 'pushurl', '-o', '']) {
      const res = await ship.ship({ ...w.base, remote });
      assert.equal(res.ok, false, remote);
      assert.doesNotMatch(reason(res), /hunter2|ghp_|pw12345678|example\.invalid|nonexistent-ship-proof/);
    }
    assert.equal(remoteRefs(w), refs);
    assert.equal(w.scanCalls.length, 0);
  });

  it('when the live default branch of the remote is the checked-out branch, it is never pushed to: the conductor/ fallback is used', async () => {
    const w = world();
    sg(w.remote, ['update-ref', `refs/heads/${TARGET}`, sgt(w.remote, ['rev-parse', 'refs/heads/main'])]);
    sg(w.remote, ['symbolic-ref', 'HEAD', `refs/heads/${TARGET}`]);
    const res = await ship.ship(w.base);
    assert.ok(res.ok, reason(res));
    if (!res.ok) return;
    assert.deepEqual([res.prepared.target, res.prepared.fallback], ['conductor/work-ship', true]);
    assert.equal(sgt(w.remote, ['rev-parse', `refs/heads/${TARGET}`]), sgt(w.remote, ['rev-parse', 'refs/heads/main']), 'the default branch did not move');
  });

  it('refuses when the live lookup fails (remote unreachable)', async () => {
    const w = world();
    sg(w.r.dir, ['remote', 'add', 'gone', `${tmpDir('nowhere')}/missing.git`]);
    const res = await ship.ship({ ...w.base, remote: 'gone' });
    assert.equal(res.ok, false);
    assert.match(reason(res), /default branch|nothing is pushed/i);
  });
});

describe('ship: what may leave the machine (R4-3, A5, A6)', () => {
  it('holds on a commit Conductor did not record, naming it, and pushes nothing', async () => {
    const w = world();
    const mine = commitAs(w.r.dir, { name: 'Ada Lovelace', email: 'ada@example.test' }, 'my own wip\n', 'wip.txt', 'wip\n');
    const refs = remoteRefs(w);
    const res = await ship.ship(w.base);
    assert.equal(res.ok, false);
    assert.ok(reason(res).includes(mine.slice(0, 8)), reason(res));
    assert.equal(remoteRefs(w), refs);
    assert.equal(w.scanCalls.length, 0);
  });

  it('holds on any merge commit in the range, even a recorded one', async () => {
    const w = world({ n: 1 });
    sg(w.r.dir, ['checkout', '-q', '-b', 'side', 'origin/main']);
    const side = commitAs(w.r.dir, AGENT, 'side\n', 'side.txt', 's\n');
    sg(w.r.dir, ['checkout', '-q', 'main']);
    sg(w.r.dir, ['-c', 'user.name=Ada Lovelace', '-c', 'user.email=ada@example.test', 'merge', '--no-ff', '-q', '-m', 'merge side', 'side']);
    const merge = sgt(w.r.dir, ['rev-parse', 'HEAD']);
    const refs = remoteRefs(w);
    const res = await ship.ship({ ...w.base, recordedShas: [...w.shas, side, merge] });
    assert.equal(res.ok, false);
    assert.match(reason(res), /merge commit/);
    assert.equal(remoteRefs(w), refs);
  });

  it('a scan failure holds, names the owning ticket’s commit (A6), and pushes nothing', async () => {
    const w = world();
    const bad = w.shas[0]!;
    const scan: ScanFn = async (o) => {
      const replaced = sgt(w.r.dir, ['log', '--format=%H', '--reverse', o.tip, '--not', ...o.excludeTips]).split('\n')[0]!;
      return { ok: false, reason: 'secret-style file name', commits: [replaced], files: ['.env'] };
    };
    const refs = remoteRefs(w);
    const res = await ship.ship({ ...w.base, scan });
    assert.equal(res.ok, false);
    assert.match(reason(res), /KEE-1's commit [0-9a-f]{8}/, 'names the card that owns the commit even after the commit was reauthored');
    assert.ok(bad);
    assert.equal(remoteRefs(w), refs);
  });

  it('a scanner that throws, or none available, fails closed', async () => {
    const w = world();
    const refs = remoteRefs(w);
    const res = await ship.ship({ ...w.base, scan: async () => { throw new Error('boom'); } });
    assert.equal(res.ok, false);
    assert.equal(remoteRefs(w), refs);
  });

  it('when the remote tip of the target is not present locally, scans against everything the remote has', async () => {
    const w = world();
    const other = tmpDir('clone');
    sg(other, ['clone', '-q', w.remote, 'c']);
    const c = `${other}/c`;
    commitAs(c, { name: 'Someone', email: 's@example.test' }, 'remote only\n', 'r.txt', 'r\n');
    sg(c, ['push', '-q', 'origin', `HEAD:refs/heads/${TARGET}`]);
    const res = await ship.prepareShip(w.base);
    // the push would not be a fast-forward; prepare is allowed to proceed (the push itself is what refuses), but it must have scanned vs known remote refs
    assert.ok(res.ok, reason(res));
    assert.ok(w.scanCalls[0]!.excludeTips.length >= 1);
    assert.ok(!w.scanCalls[0]!.excludeTips.includes(sgt(c, ['rev-parse', 'HEAD'])), 'an object that is not local is not used as a base');
  });
});

describe('ship: scan range uses live tips only (security F1)', () => {
  it('a stale remote-tracking ref never narrows the scanned range, with or without a live target tip', async () => {
    const w = world();
    // a tracking ref left behind by a branch that no longer exists on the remote, pointing at a commit that was never pushed
    sg(w.r.dir, ['update-ref', 'refs/remotes/origin/ghost', w.shas[1]!]);
    const res = await ship.prepareShip(w.base);
    assert.ok(res.ok, reason(res));
    const call = w.scanCalls[0]!;
    assert.ok(!call.excludeTips.includes(w.shas[1]!), 'the stale tracking tip is not an exclusion');
    assert.ok(call.excludeTips.includes(sgt(w.remote, ['rev-parse', 'refs/heads/main'])), 'the live remote tips are');
    assert.deepEqual(sgt(w.r.dir, ['rev-list', '--reverse', call.tip, '--not', ...call.excludeTips]).split('\n').length >= 2, true, 'both commits are in the scanned range');
  });

  it('a live target tip that exists locally is the only exclusion; one that is not local falls back to live heads, still never tracking refs', async () => {
    const w = world();
    sg(w.r.dir, ['update-ref', 'refs/remotes/origin/ghost', w.shas[1]!]);
    const other = tmpDir('clone2');
    sg(other, ['clone', '-q', w.remote, 'c']);
    const c = `${other}/c`;
    commitAs(c, { name: 'Someone', email: 's@example.test' }, 'remote only\n', 'r.txt', 'r\n');
    sg(c, ['push', '-q', 'origin', `HEAD:refs/heads/${TARGET}`]);
    const res = await ship.prepareShip(w.base);
    assert.ok(res.ok, reason(res));
    assert.ok(!w.scanCalls[0]!.excludeTips.includes(w.shas[1]!), 'ghost tracking ref is not used');
  });
});

describe('ship: last check before the push (security F2)', () => {
  it('a beforePush hold pushes nothing and runs after persist; a clean check pushes', async () => {
    const w = world();
    const refs = remoteRefs(w);
    const order: string[] = [];
    const held = await ship.ship({ ...w.base, persist: () => void order.push('persist'), beforePush: () => (order.push('before'), 'git settings changed') });
    assert.equal(held.ok, false);
    assert.match(reason(held), /git settings changed/);
    assert.deepEqual(order, ['persist', 'before']);
    assert.equal(remoteRefs(w), refs, 'nothing was pushed');
    const throwing = await ship.ship({ ...w.base, beforePush: () => { throw new Error('boom'); } });
    assert.equal(throwing.ok, false, 'a check that cannot run is a hold');
    assert.equal(remoteRefs(w), refs);
    const ok = await ship.ship({ ...w.base, beforePush: () => null });
    assert.ok(ok.ok && ok.pushed, reason(ok));
  });
});

describe('ship: identity (R4-6, A7)', () => {
  it('no developer identity holds with the exact instruction and rewrites nothing', async () => {
    const w = world({ identity: false });
    const refs = remoteRefs(w);
    const res = await ship.ship(w.base);
    assert.equal(res.ok, false);
    assert.match(reason(res), /set git user\.name\/user\.email to your own name/i);
    assert.equal(remoteRefs(w), refs);
    assert.equal(w.scanCalls.length, 0);
  });

  it('an agent-looking git identity holds', async () => {
    const w = world();
    sg(w.r.dir, ['config', 'user.name', 'Claude Code']);
    const res = await ship.ship(w.base);
    assert.equal(res.ok, false);
    assert.match(reason(res), /own name/);
  });

  it('the pre-run snapshot wins over a later config change by the builder', async () => {
    const w = world();
    sg(w.r.dir, ['config', 'user.name', 'Cursor Agent']);
    sg(w.r.dir, ['config', 'user.email', 'cursor@localhost']);
    const res = await ship.ship({ ...w.base, identity: { name: 'Grace Hopper', email: 'grace@example.test' } });
    assert.ok(res.ok, reason(res));
    for (const line of remoteLog(w)) assert.match(line, /^Grace Hopper <grace@example\.test>\|Grace Hopper/);
  });

  it('a snapshot that itself looks like an agent holds even when live config is a person', async () => {
    const w = world();
    const res = await ship.ship({ ...w.base, identity: { name: 'Conductor', email: 'conductor@localhost' } });
    assert.equal(res.ok, false);
  });

  it('a person-only override lets a developer actually named Claude push, and only that exact pair', async () => {
    const w = world();
    const dev = { name: 'Claude Reyes', email: 'claude.reyes@example.test' };
    sg(w.r.dir, ['config', 'user.name', dev.name]);
    sg(w.r.dir, ['config', 'user.email', dev.email]);
    assert.equal((await ship.prepareShip(w.base)).ok, false, 'blocked without the override');
    const ok = await ship.ship({ ...w.base, developerIdentity: dev });
    assert.ok(ok.ok, reason(ok));
    for (const line of remoteLog(w)) assert.match(line, /^Claude Reyes <claude\.reyes@example\.test>/);
    const w2 = world();
    sg(w2.r.dir, ['config', 'user.name', dev.name]);
    sg(w2.r.dir, ['config', 'user.email', dev.email]);
    assert.equal((await ship.prepareShip({ ...w2.base, developerIdentity: { name: 'Claude Reyes', email: 'someone.else@example.test' } })).ok, false);
  });

  it('an override that is itself a bot or a local/no-reply address is refused', async () => {
    for (const dev of [{ name: 'dependabot[bot]', email: 'd@example.test' }, { name: 'Ada', email: 'a@localhost' }]) {
      const w = world();
      sg(w.r.dir, ['config', 'user.name', dev.name]);
      sg(w.r.dir, ['config', 'user.email', dev.email]);
      assert.equal((await ship.prepareShip({ ...w.base, developerIdentity: dev })).ok, false, dev.name);
    }
  });

  it('a commit that still has an agent committer after the rewrite would be refused (post-check), proven by an agent-looking person that bypasses nothing', async () => {
    const w = world();
    // the person's own identity is fine; an author named like an agent is replaced, never pushed
    const res = await ship.prepareShip(w.base);
    assert.ok(res.ok);
    if (res.ok) for (const c of res.prepared.range) assert.doesNotMatch(sgt(w.r.dir, ['log', '-1', '--format=%an %ae %cn %ce', c]), /conductor|claude/i);
  });
});

describe('ship: fixture fixup (A2)', () => {
  function secretWorld(): World {
    const w = world({ n: 0 });
    const a = commitAs(w.r.dir, AGENT, AGENT_MSG('KEE-1'), 'test/cred.test.ts', 'const t = "BADSECRETVALUE";\n');
    const b = commitAs(w.r.dir, AGENT, AGENT_MSG('KEE-1'), 'src/after.js', 'export const z = 1;\n');
    const c = commitAs(w.r.dir, AGENT, AGENT_MSG('KEE-1'), 'src/more.js', 'export const m = 3;\n');
    w.shas.push(a, b, c);
    w.base.recordedShas = [a, b, c];
    w.base.scan = async (o) => {
      w.scanCalls.push({ tip: o.tip, excludeTips: o.excludeTips });
      const hit = sgTry(w.r.dir, ['log', '--format=%H', '-S', 'BADSECRETVALUE', o.tip, '--not', ...o.excludeTips]).stdout.split('\n').filter(Boolean);
      return hit.length ? { ok: false, reason: 'credential-shaped value', commits: hit, files: ['test/cred.test.ts'] } : { ok: true };
    };
    return w;
  }

  it('without a hook the secret commit holds', async () => {
    const w = secretWorld();
    const res = await ship.ship(w.base);
    assert.equal(res.ok, false);
    assert.equal(sgTry(w.remote, ['rev-parse', '--verify', '-q', `refs/heads/${TARGET}`]).code, 1);
  });

  it('with a hook the introducing commit is fixed up, the secret is gone from every pushed commit, and it is re-scanned', async () => {
    const w = secretWorld();
    const fixture = async (ctx: { commits: string[] }): Promise<Record<string, Record<string, string | null>>> => ({ [ctx.commits[0]!]: { 'test/cred.test.ts': 'const t = "placeholder";\n' } });
    const res = await ship.ship({ ...w.base, fixtureRewrite: fixture });
    assert.ok(res.ok, reason(res));
    assert.equal(sgTry(w.remote, ['log', '--format=%H', '-S', 'BADSECRETVALUE', `refs/heads/${TARGET}`]).stdout.trim(), '', 'no pushed commit ever contained the secret');
    assert.ok(w.scanCalls.length >= 2, 'scanned again after the fixup');
    assert.equal(sgt(w.remote, ['show', `refs/heads/${TARGET}:test/cred.test.ts`]), 'const t = "placeholder";');
    assert.equal(sgt(w.remote, ['rev-list', '--count', `refs/heads/main..refs/heads/${TARGET}`]), '3');
    assert.equal(sgt(w.remote, ['show', `refs/heads/${TARGET}:src/more.js`]), 'export const m = 3;');
    for (const line of remoteLog(w)) assert.match(line, /^Ada Lovelace/);
  });

  it('a later commit that touches the same lines cannot be replayed cleanly, so it holds (never a silent partial rewrite)', async () => {
    const w = secretWorld();
    const d = commitAs(w.r.dir, AGENT, AGENT_MSG('KEE-1'), 'test/cred.test.ts', 'const t = "BADSECRETVALUE";\nconst u = 2;\n');
    w.base.recordedShas = [...w.base.recordedShas, d];
    const res = await ship.ship({ ...w.base, fixtureRewrite: async (ctx) => ({ [ctx.commits[0]!]: { 'test/cred.test.ts': 'const t = "placeholder";\n' } }) });
    assert.equal(res.ok, false);
    assert.match(reason(res), /no longer applies cleanly/);
    assert.equal(sgTry(w.remote, ['rev-parse', '--verify', '-q', `refs/heads/${TARGET}`]).code, 1);
  });

  it('a hook that leaves the secret in place still holds (re-scanned)', async () => {
    const w = secretWorld();
    const res = await ship.ship({ ...w.base, fixtureRewrite: async (ctx) => Object.fromEntries(ctx.commits.map((c) => [c, { 'README.md': 'unrelated\n' }])) });
    assert.equal(res.ok, false);
    assert.equal(sgTry(w.remote, ['rev-parse', '--verify', '-q', `refs/heads/${TARGET}`]).code, 1);
  });

  it('a commit that is already published is never rewritten', async () => {
    const w = world({ n: 1 });
    // the agent commit also exists on another remote branch, and the target already exists behind it
    sg(w.r.dir, ['push', '-q', 'origin', `${w.shas[0]}:refs/heads/wip`]);
    sg(w.r.dir, ['push', '-q', 'origin', `origin/main:refs/heads/${TARGET}`]);
    const res = await ship.prepareShip(w.base);
    assert.equal(res.ok, false);
    assert.match(reason(res), /already on the remote/);
  });
});

describe('ship: the pinned push (A4) and idempotency (R4-7, A1)', () => {
  it('argv has -c options before push, a sha:refs/heads refspec, and none of force, +, --no-verify', () => {
    const argv = ship.pushArgv('origin', 'a'.repeat(40), TARGET);
    assert.equal(argv.indexOf('push'), 6);
    assert.deepEqual(argv.slice(0, 6), ['-c', 'push.pushOption=', '-c', 'push.default=nothing', '-c', 'push.followTags=false']);
    for (const f of ['--no-force-with-lease', '--no-follow-tags', '--no-recurse-submodules', '--no-tags']) assert.ok(argv.includes(f), f);
    assert.equal(argv[argv.length - 1], `${'a'.repeat(40)}:refs/heads/${TARGET}`);
    assert.ok(!argv.some((a) => /force$|^--force|^\+|--no-verify|--mirror|--all|--delete|--tags$/.test(a) && a !== '--no-force-with-lease' && a !== '--no-tags'));
  });

  it('the real argv works against a bare remote and pushes only the one ref: no tags, no configured force refspec, no extra branches', async () => {
    const w = world();
    sg(w.r.dir, ['tag', '-a', 'v1', '-m', 'v1', w.shas[1]!]);
    sg(w.r.dir, ['config', 'remote.origin.push', '+refs/heads/*:refs/heads/*']);
    sg(w.r.dir, ['config', 'push.followTags', 'true']);
    sg(w.r.dir, ['config', 'push.default', 'matching']);
    sg(w.r.dir, ['branch', 'unrelated-local']);
    const res = await ship.ship(w.base);
    assert.ok(res.ok, reason(res));
    assert.equal(remoteRefs(w).split('\n').map((l) => l.split(' ')[0]).sort().join(','), `refs/heads/main,refs/heads/${TARGET}`);
  });

  it('a non-fast-forward remote branch is never forced: the commit goes to the conductor/ fallback and the remote branch is unchanged', async () => {
    const w = world();
    const other = tmpDir('clone');
    sg(other, ['clone', '-q', w.remote, 'c']);
    const c = `${other}/c`;
    commitAs(c, { name: 'Someone', email: 's@example.test' }, 'remote only\n', 'r.txt', 'r\n');
    sg(c, ['push', '-q', 'origin', `HEAD:refs/heads/${TARGET}`]);
    const tip = sgt(w.remote, ['rev-parse', `refs/heads/${TARGET}`]);
    const res = await ship.ship(w.base);
    assert.ok(res.ok, reason(res));
    if (!res.ok) return;
    assert.deepEqual([res.prepared.target, res.prepared.fallback], ['conductor/work-ship', true]);
    assert.equal(sgt(w.remote, ['rev-parse', `refs/heads/${TARGET}`]), tip, 'the diverged remote branch is untouched');
    assert.equal(sgt(w.remote, ['rev-parse', 'refs/heads/conductor/work-ship']), res.prepared.sha);
  });

  it('a second ship, and a rerun of the same push, are no-op successes', async () => {
    const w = world();
    const first = await ship.ship(w.base);
    assert.ok(first.ok);
    const refs = remoteRefs(w);
    const again = await ship.ship(w.base);
    assert.ok(again.ok, reason(again) + ' ' + JSON.stringify(again));
    if (again.ok) {
      assert.equal(again.pushed, false, 'same inputs after a successful push push nothing');
      assert.equal(again.prepared.sha, first.ok ? first.prepared.sha : '', 'deterministic');
    }
    const viaNew = await ship.ship({ ...w.base, tip: first.ok ? first.prepared.sha : '', recordedShas: [...w.shas, ...(first.ok ? Object.values(first.prepared.replacements) : [])] });
    assert.ok(viaNew.ok && !viaNew.pushed && viaNew.prepared.alreadyPublished, 'from the persisted tip it is recognised as already published');
    const sha = first.ok ? first.prepared.sha : '';
    const p = await ship.pushShip({ ...pin(w), target: TARGET, sha });
    assert.ok(p.ok && !p.pushed);
    assert.equal(remoteRefs(w), refs);
  });

  it('crash between prepare and push: persist saw the sha before the push; a rerun makes the same sha and does not re-amend', async () => {
    const w = world();
    let seenAtPersist = '';
    const crashed = await ship.ship({
      ...w.base,
      persist: (p) => {
        seenAtPersist = remoteRefs(w);
        assert.equal(sgTry(w.remote, ['rev-parse', '--verify', '-q', `refs/heads/${TARGET}`]).code, 1, 'persist runs before the push');
        throw new Error('simulated crash after persist');
      },
    });
    assert.equal(crashed.ok, false);
    assert.equal(remoteRefs(w), seenAtPersist, 'nothing was pushed');
    const first = await ship.prepareShip(w.base);
    assert.ok(first.ok);
    if (!first.ok) return;
    // the engine persisted the replacement shas as recorded; the rerun starts from the new tip
    const recorded = [...w.shas, ...Object.values(first.prepared.replacements)];
    const logBefore = sgt(w.r.dir, ['for-each-ref', 'refs/heads', 'refs/tags']);
    const rerun = await ship.prepareShip({ ...w.base, tip: first.prepared.sha, recordedShas: recorded });
    assert.ok(rerun.ok, reason(rerun));
    if (!rerun.ok) return;
    assert.equal(rerun.prepared.sha, first.prepared.sha);
    assert.deepEqual(rerun.prepared.replacements, {}, 'no re-amend');
    // and a rerun from the ORIGINAL inputs (persist never happened) is deterministic too
    const again = await ship.prepareShip(w.base);
    assert.ok(again.ok && again.prepared.sha === first.prepared.sha);
    const pushed = await ship.pushShip({ ...pin(w), target: TARGET, sha: first.prepared.sha });
    assert.ok(pushed.ok && pushed.pushed, reason(pushed));
    assert.equal(sgt(w.remote, ['rev-parse', `refs/heads/${TARGET}`]), first.prepared.sha);
    assert.equal(sgt(w.r.dir, ['for-each-ref', 'refs/heads', 'refs/tags']), logBefore, 'no local branch moved');
  });

  it('pushShip refuses any sha that did not pass prepare (never an unscanned sha)', async () => {
    const w = world();
    const refs = remoteRefs(w);
    const res = await ship.pushShip({ ...pin(w), target: TARGET, sha: w.shas[1]! });
    assert.equal(res.ok, false);
    const prep = await ship.prepareShip(w.base);
    assert.ok(prep.ok);
    const stale = await ship.pushShip({ ...pin(w), target: TARGET, sha: w.shas[1]! });
    assert.equal(stale.ok, false, 'the original tip differs from the prepared one');
    assert.equal(remoteRefs(w), refs);
  });

  it('pushShip revalidates the target itself', async () => {
    const w = world();
    const prep = await ship.prepareShip(w.base);
    assert.ok(prep.ok);
    const refs = remoteRefs(w);
    const res = await ship.pushShip({ ...pin(w), target: 'main', sha: prep.ok ? prep.prepared.sha : '' });
    assert.equal(res.ok, false);
    assert.equal(remoteRefs(w), refs);
  });

  it('a throwing persist callback pushes nothing; hold reasons never contain a URL or a token', async () => {
    const w = world();
    const refs = remoteRefs(w);
    const res = await ship.ship({ ...w.base, persist: () => { throw new Error('disk full gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789'); } });
    assert.equal(res.ok, false);
    assert.doesNotMatch(reason(res), /ghp_|\.git\b/);
    assert.equal(remoteRefs(w), refs);
  });

  it('a remote that rejects the push has its text redacted and the URL withheld', async () => {
    const w = world();
    execFileSyncHook(w.remote, 'pre-receive', `#!/bin/sh\necho "denied ${'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789'} at ${w.remote}" >&2\nexit 1\n`);
    const res = await ship.ship(w.base);
    assert.equal(res.ok, false);
    assert.doesNotMatch(reason(res), /ghp_abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(reason(res), new RegExp(w.remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

/** The checked-out branch and HEAD a pushShip caller got from prepare. */
function pin(w: World): { repoRoot: string; remote: string; checkedOut: string | null; headSha: string | null } {
  return { repoRoot: w.r.dir, remote: 'origin', checkedOut: sgt(w.r.dir, ['symbolic-ref', '--short', 'HEAD']), headSha: sgt(w.r.dir, ['rev-parse', 'HEAD']) };
}

function execFileSyncHook(bare: string, name: string, body: string): void {
  execFileSync('sh', ['-c', `mkdir -p hooks && printf %s "$BODY" > hooks/${name} && chmod +x hooks/${name}`], { cwd: bare, env: { ...process.env, BODY: body } });
}
