// Ready -> Ship -> Pushed (Complete auto with the push consent), against a BARE temp remote only. Nothing here can reach a real remote:
// every push goes to a directory under the test's own temp root, and a `git` shim on PATH records every push argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git as tgit, makeHarness, type Harness } from './helpers/harness.ts';
import { isolateGitHome } from './helpers/tmp-repo.ts';
import { graphPlan, item, writes } from './helpers/graphs.ts';
import { columnOf, toDetail, toSummary } from '../src/pipeline/view.ts';

isolateGitHome();

// Ship pushes to the branch checked out in the repository: the world checks out this feature branch.
const BRANCH = 'feature/work';
const ADA = { name: 'Ada Lovelace', email: 'ada@example.test' };
// built from pieces so no scanner reading this file sees a token-shaped literal
const FAKE_TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

interface Opts {
  /** The Complete auto push confirm was accepted (default true). */
  consent?: boolean;
  runMode?: 'per-settings' | 'complete-auto';
  remote?: boolean;
  identity?: { name: string; email: string } | null;
  gates?: boolean;
}
interface World {
  h: Harness;
  bare: string;
  pushLog: string;
  hookLog: string;
  pushes(): string[];
  hookCalls(): number;
  remoteTip(): string;
}

/** A harness with a bare remote (main already pushed, like a real base branch), a logging pre-receive hook and a `git` shim that records pushes. */
async function world(o: Opts = {}): Promise<World> {
  const h = await makeHarness({
    gates: o.gates ?? false,
    config: (c) => {
      c.pipeline.runMode = o.runMode ?? 'complete-auto';
      if (o.consent === false) delete c.pipeline.completeAutoPushAck;
      else c.pipeline.completeAutoPushAck = 1700000000000;
    },
  });
  if (o.identity !== null) {
    const id = o.identity ?? ADA;
    tgit(h.repoDir, 'config', 'user.name', id.name);
    tgit(h.repoDir, 'config', 'user.email', id.email);
  }
  const bare = join(h.root, 'remote.git');
  const hookLog = join(h.root, 'hook.log');
  if (o.remote !== false) {
    tgit(h.repoDir, 'init', '--bare', '-q', bare);
    tgit(h.repoDir, 'remote', 'add', 'origin', bare);
    tgit(h.repoDir, 'push', '-q', 'origin', 'main');
    tgit(h.repoDir, 'fetch', '-q', 'origin');
    tgit(h.repoDir, 'checkout', '-q', '-b', BRANCH);
    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\nif [ -f "${join(h.root, 'reject')}" ]; then echo "rejected by test hook" >&2; exit 1; fi\necho push >> "${hookLog}"\nexit 0\n`);
    chmodSync(hook, 0o755);
  }
  const shim = join(h.root, 'shim');
  const pushLog = join(h.root, 'push.log');
  mkdirSync(shim, { recursive: true });
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shim, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = push ]; then echo "$@" >> "${pushLog}"; fi; done\nexec "${real}" "$@"\n`);
  chmodSync(join(shim, 'git'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim}:${oldPath}`;
  const cleanup = h.cleanup.bind(h);
  h.cleanup = async () => {
    process.env.PATH = oldPath;
    await cleanup();
  };
  return {
    h,
    bare,
    pushLog,
    hookLog,
    pushes: () => (existsSync(pushLog) ? readFileSync(pushLog, 'utf8').split('\n').filter((l) => l && !l.startsWith('push -q origin')) : []), // the test's own setup pushes are not the engine's
    hookCalls: () => (existsSync(hookLog) ? readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).length : 0),
    remoteTip: () => {
      try {
        return tgit(bare, 'rev-parse', '--verify', `refs/heads/${BRANCH}`);
      } catch {
        return '';
      }
    },
  };
}

/** tick + wait for jobs and the ship worker until `cond` holds. */
async function until(h: Harness, cond: () => boolean, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await h.engine.tick();
    await h.engine.idle();
    if (cond()) return;
  }
  throw new Error('until: condition not reached: ' + JSON.stringify(h.store.list().map((r) => [r.key, r.status, r.next, r.pushedAt ? 'pushed' : '', r.shipHold?.reason ?? ''])));
}

const refsOf = (bare: string): string => {
  try {
    return tgit(bare, 'for-each-ref', '--format=%(refname)');
  } catch {
    return '';
  }
};

test('Ready -> Ship -> Pushed: the finished card is pushed by sha to the feature branch, as the person, and never to main', async () => {
  const w = await world();
  const { h } = w;
  try {
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.pushedAt);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.ok(run.pushedAt && run.pushedSha && run.shipSha);
    assert.equal(run.pushedSha, run.shipSha);
    assert.equal(w.remoteTip(), run.pushedSha);
    assert.equal(columnOf(run), 'pushed');
    assert.equal(run.shipHold, undefined);
    assert.ok(run.landedShas!.includes(tgit(h.repoDir, 'rev-parse', 'HEAD')), 'the local checkout already has the work, and its commits stay recorded (Ship never moves the checkout)');
    assert.equal(tgit(w.bare, 'rev-parse', 'refs/heads/main'), tgit(h.repoDir, 'rev-parse', 'main'), 'main on the remote was not touched');
    assert.equal(tgit(w.bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', `refs/heads/${BRANCH}`), `${ADA.name} <${ADA.email}>|${ADA.name} <${ADA.email}>`);
    assert.equal(w.pushes().length, 1);
    assert.match(w.pushes()[0]!, /--no-force-with-lease/);
    assert.doesNotMatch(w.pushes()[0]!, /--force|\+refs|--no-verify/);
    const cardId = h.board.item(key)!.id;
    assert.ok(h.board.comments(cardId).some((c) => /\*\*Pushed\*\*/.test(c.body)), 'one board comment says it was pushed');
    assert.equal(toSummary(run, h.cfg, Date.now()).shipHold, null);
    assert.deepEqual(toDetail(h.store, run, h.cfg, Date.now()).landedShas, run.landedShas, 'the detail view surfaces the landed commits (read-only)');
    // a second tick never pushes again
    await h.engine.tick();
    await h.engine.idle();
    assert.equal(w.pushes().length, 1);
  } finally {
    await h.cleanup();
  }
});

test('Complete auto without the push consent, and the consent under Per settings, never invoke git push', async () => {
  for (const o of [{ consent: false, runMode: 'complete-auto' as const }, { consent: true, runMode: 'per-settings' as const }]) {
    const w = await world(o);
    const { h } = w;
    try {
      const key = h.issue('Add the greeting');
      await h.settle();
      for (let i = 0; i < 3; i++) await h.engine.tick();
      await h.engine.idle();
      const run = h.run(key);
      assert.equal(run.status, 'ready');
      assert.equal(run.pushedAt, undefined);
      assert.equal(run.shipHold, undefined);
      assert.deepEqual(w.pushes(), [], `no push under ${JSON.stringify(o)}`);
      assert.equal(refsOf(w.bare).includes(BRANCH), false);
      assert.equal(columnOf(run), 'ready');
      if (o.runMode === 'complete-auto') {
        // Complete auto pushes by itself (the button is gone); the route refuses with a clear message and pushes nothing
        await assert.rejects(h.engine.push(key), /Complete auto pushes finished cards by itself/);
        assert.deepEqual(w.pushes(), []);
      } else {
        // the manual route is Ship (scan, identity, target rules): it still works on a done card
        await h.engine.push(key);
        assert.ok(h.run(key).pushedAt, 'the person can still push by hand');
        assert.equal(h.run(key).pushedBranch, BRANCH);
      }
    } finally {
      await h.cleanup();
    }
  }
});

test('an agent git identity holds the card at Ready with the reason; nothing is pushed and dependants are not deadlocked', async () => {
  const w = await world({ identity: { name: 'Claude Code', email: 'noreply@anthropic.com' } });
  const { h } = w;
  try {
    const first = h.issue('Add the greeting');
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [h.board.item(first)!.id] }).key;
    await until(h, () => !!h.store.get(second) && h.store.get(second)!.status === 'ready' && !!h.store.get(second)!.shipHold);
    const a = h.run(first);
    assert.equal(a.status, 'ready', 'a hold never fails the card');
    assert.match(a.shipHold?.reason ?? '', /agent|your own name/i);
    assert.equal(a.pushedAt, undefined);
    assert.equal(toSummary(a, h.cfg, Date.now()).shipHold?.reason, a.shipHold?.reason);
    assert.deepEqual(w.pushes(), []);
    assert.equal(w.remoteTip(), '');
    assert.ok(h.store.get(second), 'the dependant started: a held Ship falls back to Done-gating');
    // exactly one comment per distinct reason, however many ticks pass
    for (let i = 0; i < 3; i++) await h.engine.tick();
    await h.engine.idle();
    const cards = h.board.comments(h.board.item(first)!.id).filter((c) => /Not pushed yet/.test(c.body));
    assert.equal(cards.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a commit of the user\'s own below the card holds Ship, names it, and pushes nothing', async () => {
  const w = await world();
  const { h } = w;
  try {
    writeFileSync(join(h.repoDir, 'my-wip.txt'), 'mine\n');
    tgit(h.repoDir, 'add', '-A');
    tgit(h.repoDir, 'commit', '-q', '-m', 'my own unpushed work');
    const mine = tgit(h.repoDir, 'rev-parse', 'HEAD');
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.shipHold);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.match(run.shipHold!.reason, new RegExp(mine.slice(0, 8)));
    assert.match(run.shipHold!.reason, /not one Conductor made|did not hand over/);
    assert.deepEqual(w.pushes(), []);
  } finally {
    await h.cleanup();
  }
});

test('a merge commit in the range holds Ship', async () => {
  const w = await world();
  const { h } = w;
  try {
    tgit(h.repoDir, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(h.repoDir, 'side.txt'), 'side\n');
    tgit(h.repoDir, 'add', '-A');
    tgit(h.repoDir, 'commit', '-q', '-m', 'side work');
    tgit(h.repoDir, 'push', '-q', 'origin', 'side'); // the side commit is published, so only the merge commit is new
    tgit(h.repoDir, 'checkout', '-q', 'main');
    writeFileSync(join(h.repoDir, 'main-only.txt'), 'm\n');
    tgit(h.repoDir, 'add', '-A');
    tgit(h.repoDir, 'commit', '-q', '-m', 'main work');
    tgit(h.repoDir, 'push', '-q', 'origin', 'main');
    tgit(h.repoDir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.shipHold);
    assert.match(h.run(key).shipHold!.reason, /merge commit/i);
    assert.deepEqual(w.pushes(), []);
  } finally {
    await h.cleanup();
  }
});

test('Ship rewrites agent-authored unpushed commits to the person, persists before pushing, and a failed push re-runs without re-amending', async () => {
  const w = await world({ identity: { name: 'Conductor', email: 'conductor@localhost' } });
  const { h } = w;
  try {
    writeFileSync(join(h.root, 'reject'), 'x');
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.shipHold); // the snapshot is an agent identity: held, nothing pushed
    assert.match(h.run(key).shipHold!.reason, /agent|your own name/i);
    assert.deepEqual(w.pushes(), []);
    const original = h.run(key).commitSha!;
    assert.equal(tgit(h.repoDir, 'log', '-1', '--format=%an', original), 'Conductor');

    // the person fixes their git identity and presses Retry; the remote refuses the first push (a crash after persist looks the same)
    tgit(h.repoDir, 'config', 'user.name', ADA.name);
    tgit(h.repoDir, 'config', 'user.email', ADA.email);
    h.store.update(key, (r) => void (r.shipIdentity = undefined)); // as a run from before the snapshot existed
    await h.engine.retry(key);
    await until(h, () => !!h.store.get(key)?.shipHold && w.pushes().length >= 1);
    let run = h.run(key);
    assert.match(run.shipHold!.reason, /did not finish|rejected/i);
    assert.equal(w.remoteTip(), '');
    assert.ok(run.shipSha, 'the scanned sha was persisted BEFORE the push');
    assert.notEqual(run.shipSha, original);
    assert.equal(run.commitSha, original, 'commitSha stays the LOCAL commit (build, verify and graph recovery need it on the checkout)');
    assert.equal(run.shipBase, original, 'shipSha is only the push tip while it was derived from the current commitSha');
    assert.equal(tgit(h.repoDir, 'merge-base', '--is-ancestor', run.commitSha!, 'HEAD') === '', true, 'commitSha is an ancestor of the checkout HEAD');
    assert.ok(run.landedShas!.includes(original) && run.landedShas!.includes(run.shipSha!), 'old and new commits stay recorded');
    assert.equal(tgit(h.repoDir, 'rev-parse', 'HEAD'), original, 'the local branch was not rewritten');
    const persisted = run.shipSha!;

    rmSync(join(h.root, 'reject'));
    await h.engine.retry(key);
    await until(h, () => !!h.store.get(key)?.pushedAt);
    run = h.run(key);
    assert.equal(run.pushedSha, persisted, 'the rerun pushed exactly the persisted sha: no second amend');
    assert.equal(w.remoteTip(), persisted);
    assert.equal(tgit(w.bare, 'log', '-1', '--format=%an <%ae>|%cn', `refs/heads/${BRANCH}`), `${ADA.name} <${ADA.email}>|${ADA.name}`);
    assert.doesNotMatch(tgit(w.bare, 'log', '-1', '--format=%B', `refs/heads/${BRANCH}`), /Built by Conductor/);
    assert.equal(w.hookCalls(), 1);
  } finally {
    await h.cleanup();
  }
});

test('a crash after the push but before pushedAt is recorded re-runs as a no-op (the remote already has the sha)', async () => {
  const w = await world();
  const { h } = w;
  try {
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.pushedAt);
    const done = h.run(key);
    assert.equal(w.pushes().length, 1);
    // forget that it was pushed, as a crash between the remote accepting and the run being written would
    h.store.update(key, (r) => {
      r.pushedAt = undefined;
      r.pushedSha = undefined;
    });
    await until(h, () => !!h.store.get(key)?.pushedAt);
    assert.equal(h.run(key).pushedSha, done.pushedSha);
    assert.equal(w.pushes().length, 1, 'no second git push');
    assert.equal(w.hookCalls(), 1);
  } finally {
    await h.cleanup();
  }
});

test('unrelated untracked files in the checkout do not block the local merge or Ship, and are not pushed', async () => {
  const w = await world();
  const { h } = w;
  try {
    mkdirSync(join(h.repoDir, '.techteam', 'research'), { recursive: true });
    writeFileSync(join(h.repoDir, '.techteam', 'research', 'notes.md'), 'untracked\n');
    writeFileSync(join(h.repoDir, 'scratch.txt'), 'untracked\n');
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.pushedAt);
    const files = tgit(w.bare, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`).split('\n');
    assert.ok(files.includes(`feature-${key.toLowerCase()}.mjs`));
    assert.ok(!files.includes('scratch.txt') && !files.some((f) => f.startsWith('.techteam/')));
    assert.ok(existsSync(join(h.repoDir, 'scratch.txt')) && existsSync(join(h.repoDir, '.techteam', 'research', 'notes.md')), 'the person\'s untracked files are still there');
    assert.match(tgit(h.repoDir, 'status', '--porcelain'), /scratch\.txt/);
  } finally {
    await h.cleanup();
  }
});

test('dependants wait for the dependency to be Pushed when Ship is in effect', async () => {
  const w = await world();
  const { h } = w;
  try {
    const first = h.issue('Add the greeting');
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [h.board.item(first)!.id] }).key;
    // drive ticks by hand until the first card is Ready, then look at the claim decision of the very next tick
    for (let i = 0; i < 40 && h.store.get(first)?.status !== 'ready'; i++) {
      await h.engine.tick();
      await h.engine.idle();
      if (h.store.get(first)?.pushedAt) break;
    }
    assert.equal(h.board.item(first)!.lane, 'done');
    // the tick that finds it Ready asks for the push; until the push lands the dependant must not exist
    const seenWaiting = h.engine.status().ignored.some((i) => i.key === second && /pushed/.test(i.reason));
    const pushedAlready = !!h.store.get(first)?.pushedAt;
    assert.ok(pushedAlready || seenWaiting || !h.store.get(second), 'a card whose dependency is Done but not Pushed is not started');
    await until(h, () => !!h.store.get(first)?.pushedAt && !!h.store.get(second) && h.store.get(second)!.status === 'ready' && !!h.store.get(second)!.pushedAt);
    assert.equal(h.run(second).status, 'ready');
    assert.ok(h.run(first).pushedAt! <= h.run(second).createdAt, 'the dependant started only after the first was pushed');
  } finally {
    await h.cleanup();
  }
});

test('the claim gate itself: Done is not enough while the push is pending, and the fallbacks never deadlock', async () => {
  const w = await world();
  const { h } = w;
  try {
    const first = h.issue('Add the greeting');
    await h.settle();
    h.engine.setPaused(true); // no Ship, no claims: the board answers from the run records alone
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [h.board.item(first)!.id] });
    const asks = () => h.board.claimable(['work'], (dep, dependant) => (h.engine as any).dependencyShipped(dep, dependant)).some((c) => c.id === second.id);
    h.store.update(first, (r) => {
      r.pushedAt = undefined;
      r.pushedSha = undefined;
      r.shipHold = undefined;
    });
    assert.equal(asks(), false, 'Ready and not pushed: the dependant waits');
    h.store.update(first, (r) => void (r.shipHold = { reason: 'x', at: Date.now() }));
    assert.equal(asks(), true, 'a held Ship falls back to Done-gating');
    h.store.update(first, (r) => {
      r.shipHold = undefined;
      r.pushedAt = Date.now();
    });
    assert.equal(asks(), true, 'pushed');
    h.store.update(first, (r) => {
      r.pushedAt = undefined;
      r.answered = true;
    });
    assert.equal(asks(), true, 'nothing to ship (an answer)');
    h.store.update(first, (r) => {
      r.answered = undefined;
      r.status = 'finished';
    });
    assert.equal(asks(), true, 'marked done by a person');
    h.store.update(first, (r) => void (r.status = 'ready'));
    assert.equal(asks(), false);
    delete h.cfg.pipeline.completeAutoPushAck;
    assert.equal(asks(), true, 'no push consent: today\'s Done-gating');
    h.cfg.pipeline.completeAutoPushAck = 1700000000000;
    h.cfg.pipeline.runMode = 'per-settings';
    assert.equal(asks(), true, 'Per settings: today\'s Done-gating');
  } finally {
    await h.cleanup();
  }
});

test('no remote: Ship holds with the reason and dependants fall back to Done-gating (no deadlock)', async () => {
  const w = await world({ remote: false });
  const { h } = w;
  try {
    const first = h.issue('Add the greeting');
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [h.board.item(first)!.id] }).key;
    await until(h, () => !!h.store.get(second) && h.store.get(second)!.status === 'ready');
    assert.match(h.run(first).shipHold?.reason ?? '', /no git remote named origin/i);
    assert.deepEqual(w.pushes(), []);
  } finally {
    await h.cleanup();
  }
});

test('"Unblock dependants": a person releases dependants of a finished card that is not pushed yet; it is recorded and nothing is pushed', async () => {
  const w = await world();
  const { h } = w;
  try {
    const first = h.issue('Add the greeting');
    await h.settle();
    h.engine.setPaused(true);
    h.store.update(first, (r) => {
      r.pushedAt = undefined;
      r.pushedSha = undefined;
    });
    const summary = toSummary(h.run(first), h.cfg, Date.now());
    assert.equal(summary.canUnblockDependants, true);
    await h.engine.unblockDependants(first);
    const run = h.run(first);
    assert.ok(run.shipUnblockedAt);
    assert.ok(run.history.some((e) => /Dependants released by you/.test(e.text)));
    assert.ok(h.board.comments(h.board.item(first)!.id).some((c) => /Dependants released/.test(c.body)), 'an explicit note on the card');
    assert.equal(toSummary(run, h.cfg, Date.now()).canUnblockDependants, false);
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [h.board.item(first)!.id] });
    assert.equal(h.board.claimable(['work'], (dep, dependant) => (h.engine as any).dependencyShipped(dep, dependant)).some((c) => c.id === second.id), true);
    assert.deepEqual(w.pushes().filter((p) => /feature\/work/.test(p)).length, 1, 'only the earlier automatic push exists; the override pushed nothing');
    // it only makes sense for a finished, unpushed card
    h.store.update(first, (r) => void (r.pushedAt = Date.now()));
    await assert.rejects(h.engine.unblockDependants(first), /not been pushed|Only a finished card/);
    delete h.cfg.pipeline.completeAutoPushAck;
    await assert.rejects(h.engine.unblockDependants(first), /not in effect/);
  } finally {
    await h.cleanup();
  }
});

test('the unblock route is a POST on /api/runs/:key/unblock and the engine refuses it for a card that is not waiting', async () => {
  const { Api } = await import('../src/server/api.ts');
  assert.equal(typeof Api, 'function');
  const src = readFileSync(new URL('../src/server/api.ts', import.meta.url), 'utf8');
  assert.match(src, /\(approve\|retry\|resume\|abort\|cleanup\|open\|push\|unblock\)\$\/\.exec\(path\)\) && method === 'POST'/);
});

test('a credential-shaped string in a test file: passes locally, is caught at Ship, rewritten once by the builder, folded into the commit that introduced it, then pushed', async () => {
  const w = await world();
  const { h } = w;
  try {
    h.scenario({
      cursor: {
        '*': {
          build: [
            writes('test/auth.test.mjs', `export const token = "${FAKE_TOKEN}";\n`),
            writes('test/auth.test.mjs', 'export const token = "not-a-real-token";\n'),
          ],
        },
      },
    });
    const key = h.issue('Add auth tests');
    await until(h, () => !!h.store.get(key)?.pushedAt, 80);
    const run = h.run(key);
    assert.equal(run.shipFixtureRewrites, 1, 'one builder rewrite');
    assert.equal(w.pushes().length, 1, 'one push, after the fixture was fixed');
    assert.equal(tgit(w.bare, 'log', '--format=%H', '-S', FAKE_TOKEN, `refs/heads/${BRANCH}`), '', 'no pushed commit ever contained the token');
    assert.equal(tgit(w.bare, 'show', `refs/heads/${BRANCH}:test/auth.test.mjs`).trim(), 'export const token = "not-a-real-token";');
    assert.equal(run.commitSha, tgit(h.repoDir, 'rev-parse', 'HEAD'), 'commitSha is the local commit, and the local branch keeps its original commits');
    assert.notEqual(run.pushedSha, run.commitSha, 'what was pushed is the rewritten commit');
    assert.match(tgit(h.repoDir, 'log', '--format=%H', '-S', FAKE_TOKEN), /[0-9a-f]{40}/, 'the local commit that carried it is untouched');
  } finally {
    await h.cleanup();
  }
});

test('a fixture the builder does not fix holds Ship on the second pass: the card stays Ready, nothing is pushed, dependants fall back', async () => {
  const w = await world();
  const { h } = w;
  try {
    h.scenario({ cursor: { '*': { build: [writes('test/auth.test.mjs', `export const token = "${FAKE_TOKEN}";\n`), writes('test/other.test.mjs', 'export const x = 1;\n')] } } });
    const first = h.issue('Add auth tests');
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [h.board.item(first)!.id] }).key;
    await until(h, () => !!h.store.get(second) && h.store.get(second)!.status !== 'queued' && h.store.get(second)!.status !== 'running', 80);
    const run = h.run(first);
    assert.equal(run.status, 'ready');
    assert.match(run.shipHold?.reason ?? '', /secret scan blocked the push/);
    assert.doesNotMatch(run.shipHold?.reason ?? '', new RegExp(FAKE_TOKEN));
    assert.equal(run.shipFixtureRewrites, 1);
    assert.deepEqual(w.pushes(), []);
    assert.equal(w.remoteTip(), '');
  } finally {
    await h.cleanup();
  }
});

test('a secret in a source (non-test) file still stops at the local commit, exactly as before', async () => {
  const w = await world();
  const { h } = w;
  try {
    h.scenario({ cursor: { '*': { build: [writes('src/leak.mjs', `export const token = "${FAKE_TOKEN}";\n`)] } } });
    const key = h.issue('Leak');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(h.run(key).needsHuman!.reason, /refused to commit/, 'the commit guard itself refuses (the branch scan is a second line)');
    assert.deepEqual(w.pushes(), []);
  } finally {
    await h.cleanup();
  }
});

test('a task graph (several commits, one per task) ships as one range', async () => {
  const w = await world();
  const { h } = w;
  try {
    const plan = graphPlan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] })]);
    h.scenario({ claude: { '*': { plan: [{ json: plan }] } }, cursor: { '*': { build: [writes('t1.mjs'), writes('t2.mjs')] } } });
    const key = h.issue('Two tasks');
    await until(h, () => !!h.store.get(key)?.pushedAt, 80);
    const run = h.run(key);
    assert.equal(run.pushedSha, w.remoteTip());
    const files = tgit(w.bare, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`).split('\n');
    assert.ok(files.includes('t1.mjs') && files.includes('t2.mjs'));
    assert.equal(w.pushes().length, 1);
    assert.ok((run.landedShas ?? []).length >= 2, 'every landed commit is recorded');
  } finally {
    await h.cleanup();
  }
});

test('Retry on a card Ship is holding runs Ship again and does not re-plan it', async () => {
  const w = await world({ identity: { name: 'Claude Code', email: 'noreply@anthropic.com' } });
  const { h } = w;
  try {
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.shipHold);
    const before = h.run(key);
    tgit(h.repoDir, 'config', 'user.name', ADA.name);
    tgit(h.repoDir, 'config', 'user.email', ADA.email);
    h.store.update(key, (r) => void (r.shipIdentity = undefined));
    await h.engine.retry(key);
    assert.equal(h.run(key).rev, before.rev, 'not re-planned');
    assert.equal(h.run(key).shipHold, undefined);
    await until(h, () => !!h.store.get(key)?.pushedAt);
    assert.equal(h.run(key).rev, before.rev);
    assert.equal(w.remoteTip(), h.run(key).pushedSha);
  } finally {
    await h.cleanup();
  }
});

test('the identity is snapshotted once, before any agent run, and is what Ship signs with even if the config changes mid-run', async () => {
  const w = await world();
  const { h } = w;
  try {
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.pushedAt);
    assert.deepEqual(h.run(key).shipIdentity, ADA);
  } finally {
    await h.cleanup();
  }
  const w2 = await world();
  try {
    const key = w2.h.issue('Add the greeting');
    await w2.h.engine.tick(); // claim
    // someone (the builder, in the worst case) changes the repo identity after the run started
    await until(w2.h, () => (w2.h.store.get(key)?.agentRuns ?? 0) >= 1 || w2.h.store.get(key)?.status === 'ready');
    assert.deepEqual(w2.h.run(key).shipIdentity, ADA, 'recorded at the start of the first job');
    tgit(w2.h.repoDir, 'config', 'user.name', 'Claude Code');
    tgit(w2.h.repoDir, 'config', 'user.email', 'noreply@anthropic.com');
    await w2.h.settle();
    await until(w2.h, () => !!w2.h.store.get(key)?.pushedAt || !!w2.h.store.get(key)?.shipHold);
    assert.deepEqual(w2.h.run(key).shipIdentity, ADA, 'never re-read');
    assert.ok(w2.h.run(key).pushedAt, 'Ship signed with the snapshot, not with the live config');
    assert.equal(tgit(w2.bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', `refs/heads/${BRANCH}`), `${ADA.name} <${ADA.email}>|${ADA.name} <${ADA.email}>`);
  } finally {
    await w2.h.cleanup();
  }
});

test('security F2: Ship never runs while an agent job is running in the same repository, then runs once it ends; the card is never failed', async () => {
  const w = await world({ consent: false });
  const { h } = w;
  try {
    const key = h.issue('Add the greeting');
    await until(h, () => h.store.get(key)?.status === 'ready');
    h.cfg.pipeline.completeAutoPushAck = 1700000000000;
    let release!: () => void;
    const jobs = (h.engine as unknown as { jobs: Map<string, { ac: AbortController; promise: Promise<void> }> }).jobs;
    jobs.set('OTHER-1', { ac: new AbortController(), promise: new Promise<void>((r) => (release = r)) }); // a builder of another card, same repository
    for (let i = 0; i < 4; i++) {
      await h.engine.tick();
      await (h.engine as unknown as { shipWorker: Promise<void> | null }).shipWorker; // if Ship had started, let it finish, so a push would be visible
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.deepEqual(w.pushes(), [], 'nothing was pushed while a job ran');
    assert.equal(h.run(key).pushedAt, undefined);
    assert.equal(h.run(key).shipHold, undefined, 'Ship was not even started (no hold recorded, nothing scanned)');
    assert.equal(h.run(key).status, 'ready', 'never failed');
    jobs.delete('OTHER-1');
    release();
    await until(h, () => !!h.store.get(key)?.pushedAt);
    assert.equal(w.pushes().length, 1);
  } finally {
    await h.cleanup();
  }
});

test('security F2: git config planted in the repository while Ship is checking holds the push, and nothing is pushed', async () => {
  const w = await world();
  const { h } = w;
  try {
    // the git shim plants core.sshCommand the first time Ship looks at the remote (between its first snapshot and the push)
    const real = execFileSync('which', ['-a', 'git'], { encoding: 'utf8' }).split('\n').filter((x) => x && !x.startsWith(join(h.root, 'shim')))[0]!;
    writeFileSync(join(h.root, 'shim', 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = ls-remote ]; then "${real}" -C "${h.repoDir}" config core.sshCommand 'touch ${join(h.root, 'pwned')}'; fi; done\nexec "${real}" "$@"\n`);
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.shipHold);
    assert.match(h.run(key).shipHold!.reason, /core\.sshcommand|settings or hooks changed/i);
    assert.equal(h.run(key).status, 'ready');
    assert.equal(w.remoteTip(), '', 'nothing was pushed');
    assert.equal(existsSync(join(h.root, 'pwned')), false, 'the planted command never ran');
    assert.throws(() => tgit(h.repoDir, 'config', '--local', '--get-all', 'core.sshCommand'), 'git config exits 1 when the key is gone');
    assert.ok(true, 'and the planted setting was removed, so a retry cannot take it as its baseline');
  } finally {
    await h.cleanup();
  }
});

test('shipping gate: a card that becomes claimable while Ship holds its repository is not started until the push ends, then starts and nothing fails', async () => {
  const w = await world();
  const { h } = w;
  try {
    const first = h.issue('Add the greeting');
    await until(h, () => h.store.get(first)?.status === 'ready');
    // hold the push open: the shim blocks inside `git push` until the release file exists
    const real = execFileSync('which', ['-a', 'git'], { encoding: 'utf8' }).split('\n').filter((x) => x && !x.startsWith(join(h.root, 'shim')))[0]!;
    const entered = join(h.root, 'push-entered');
    const release = join(h.root, 'push-release');
    writeFileSync(join(h.root, 'shim', 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = push ]; then echo "$@" >> "${w.pushLog}"; : > "${entered}"; while [ ! -f "${release}" ]; do sleep 0.05; done; fi; done\nexec "${real}" "$@"\n`);
    await h.engine.tick(); // Ship starts (the push consent is given) and parks inside the push
    for (let i = 0; i < 200 && !existsSync(entered); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(entered), 'Ship is inside git push');
    const second = h.issue('Another change');
    for (let i = 0; i < 4; i++) {
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    const mid = h.store.get(second);
    assert.ok(!mid || mid.status === 'queued', `the new card is not started during Ship (status ${mid?.status})`);
    assert.equal((h.engine as unknown as { jobs: Map<string, unknown> }).jobs.size, 0, 'no job runs while Ship holds the repository');
    writeFileSync(release, '');
    await until(h, () => !!h.store.get(first)?.pushedAt && h.store.get(second)?.status === 'ready');
    assert.notEqual(h.run(second).status, 'failed');
    assert.equal(h.run(first).shipHold, undefined);
    assert.equal((h.engine as unknown as { shipping: Set<string> }).shipping.size, 0, 'the gate is released');
  } finally {
    writeFileSync(join(h.root, 'push-release'), '');
    await h.cleanup();
  }
});

test('shipping gate: Ship for another repository never blocks this one', async () => {
  const w = await world({ consent: false });
  const { h } = w;
  try {
    (h.engine as unknown as { shipping: Set<string> }).shipping.add('some-other-repo');
    const key = h.issue('Add the greeting');
    await until(h, () => h.store.get(key)?.status === 'ready');
    assert.equal(h.run(key).status, 'ready');
  } finally {
    await h.cleanup();
  }
});

test('a protected checked-out branch (main) is never pushed to: the card is pushed to conductor/<KEY> and says so', async () => {
  const w = await world();
  const { h } = w;
  try {
    tgit(h.repoDir, 'checkout', '-q', 'main');
    const key = h.issue('Add the greeting');
    await until(h, () => !!h.store.get(key)?.pushedAt);
    const run = h.run(key);
    assert.equal(run.pushedBranch, `conductor/${key}`);
    assert.equal(tgit(w.bare, 'rev-parse', `refs/heads/conductor/${key}`), run.pushedSha);
    assert.equal(tgit(w.bare, 'rev-parse', 'refs/heads/main'), tgit(h.repoDir, 'rev-parse', 'main~1'), 'main on the remote did not move');
    assert.ok(run.history.some((e) => e.text.includes(`conductor/${key}`)));
    assert.match(toSummary(run, h.cfg, Date.now()).activity ?? '', new RegExp(`conductor/${key}`));
  } finally {
    await h.cleanup();
  }
});

test('per-repo kill switch: a repository with no push remote never pushes, and its dependants do not wait', async () => {
  const w = await world();
  const { h } = w;
  try {
    h.cfg.repos[0]!.pushRemote = null;
    const first = h.issue('Add the greeting');
    await h.settle();
    for (let i = 0; i < 3; i++) await h.engine.tick();
    await h.engine.idle();
    const run = h.run(first);
    assert.equal(run.status, 'ready');
    assert.equal(run.pushedAt, undefined);
    assert.equal(run.shipHold, undefined);
    assert.deepEqual(w.pushes(), []);
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [h.board.item(first)!.id] });
    assert.equal(h.board.claimable(['work'], (dep, dependant) => (h.engine as any).dependencyShipped(dep, dependant)).some((c) => c.id === second.id), true, 'Done-gating, not waiting for a push that never happens');
    await assert.rejects(h.engine.unblockDependants(first).then(() => h.engine.push(first)), /never push|Complete auto/);
  } finally {
    await h.cleanup();
  }
});

test('a repository whose push remote does not exist: dependants fall back to Done-gating before Ship has even tried', async () => {
  const w = await world({ remote: false });
  const { h } = w;
  try {
    const first = h.issue('Add the greeting');
    await h.settle();
    h.engine.setPaused(true);
    h.store.update(first, (r) => void (r.shipHold = undefined)); // as if Ship had not held yet: the missing remote alone releases the dependants
    assert.equal(h.run(first).status, 'ready');
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [h.board.item(first)!.id] });
    assert.equal(h.board.claimable(['work'], (dep, dependant) => (h.engine as any).dependencyShipped(dep, dependant)).some((c) => c.id === second.id), true);
  } finally {
    await h.cleanup();
  }
});

test('without the push consent the card stays Ready, nothing runs through Ship, and the settings say consent is needed', async () => {
  const w = await world({ consent: false });
  const { h } = w;
  try {
    const key = h.issue('Add the greeting');
    await h.settle();
    for (let i = 0; i < 3; i++) await h.engine.tick();
    await h.engine.idle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).pushedAt, undefined);
    assert.deepEqual(w.pushes(), []);
    assert.equal(h.engine.shipEffective(), false);
    const { toSettings } = await import('../src/config.ts');
    assert.equal(toSettings(h.cfg).pushConsentNeeded, true);
  } finally {
    await h.cleanup();
  }
});
