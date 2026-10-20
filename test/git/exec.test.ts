import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitError, git, gitOk, run, safeEnv } from '../../src/git/exec.ts';
import { alive, isolateGitHome, tmpDir, waitFor } from '../helpers/tmp-repo.ts';

isolateGitHome();

const SECRET_VARS = ['LINEAR_API_KEY', 'CURSOR_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

afterEach(() => {
  for (const k of SECRET_VARS) delete process.env[k];
});

describe('run', () => {
  it('captures stdout, stderr and exit code', async () => {
    const r = await run('sh', ['-c', 'echo out; echo err >&2; exit 3'], { cwd: tmpDir() });
    assert.equal(r.code, 3);
    assert.equal(r.stdout, 'out\n');
    assert.equal(r.stderr, 'err\n');
    assert.equal(r.timedOut, false);
    assert.equal(r.aborted, false);
  });

  it('feeds input to stdin', async () => {
    const r = await run('cat', [], { cwd: tmpDir(), input: 'hello stdin' });
    assert.equal(r.stdout, 'hello stdin');
  });

  it('gives /dev/null as stdin when there is no input (nothing can hang waiting for it)', async () => {
    const r = await run('cat', [], { cwd: tmpDir(), timeoutMs: 3000 });
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
  });

  it('keeps the TAIL when output exceeds maxBytes', async () => {
    const r = await run('sh', ['-c', 'i=0; while [ $i -lt 3000 ]; do echo line$i; i=$((i+1)); done'], { cwd: tmpDir(), maxBytes: 1000 });
    assert.ok(Buffer.byteLength(r.stdout) <= 1000, `stdout is ${Buffer.byteLength(r.stdout)} bytes`);
    assert.ok(r.stdout.endsWith('line2999\n'));
    assert.equal(r.stdoutTruncated, true);
    assert.equal(r.stderrTruncated, false);
  });

  it('defaults the environment to the allowlist (parent secrets are not inherited)', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_should_not_leak_0123456789';
    const r = await run('sh', ['-c', 'echo "[$LINEAR_API_KEY][$HOME]"'], { cwd: tmpDir() });
    assert.equal(r.stdout.trim(), `[][${process.env.HOME}]`);
  });

  it('rejects when the binary or cwd does not exist', async () => {
    await assert.rejects(run('definitely-not-a-binary-xyz', [], { cwd: tmpDir() }), /ENOENT/);
    await assert.rejects(run('echo', ['x'], { cwd: join(tmpDir(), 'missing') }), /ENOENT/);
  });

  it('timeout: kills the whole process group (grandchildren too) and reports timedOut', async () => {
    const dir = tmpDir();
    const t0 = Date.now();
    const r = await run('sh', ['-c', `sleep 60 & echo $! > "${join(dir, 'pid')}"; wait`], { cwd: dir, timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
    assert.ok(Date.now() - t0 < 4000, 'returned promptly after SIGTERM');
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
    assert.ok(pid > 1);
    assert.ok(await waitFor(() => !alive(pid), 3000), 'grandchild was killed with the group');
  });

  it('timeout: escalates to SIGKILL after the 5 s grace for processes that ignore SIGTERM', async () => {
    const dir = tmpDir();
    const t0 = Date.now();
    const r = await run('sh', ['-c', `trap '' TERM; sleep 120 & echo $! > "${join(dir, 'pid')}"; while true; do sleep 1; done`], {
      cwd: dir,
      timeoutMs: 200,
    });
    const took = Date.now() - t0;
    assert.equal(r.timedOut, true);
    assert.ok(took >= 4500, `waited for the grace period (took ${took} ms)`);
    assert.ok(took < 12000, `then killed (took ${took} ms)`);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
    assert.ok(await waitFor(() => !alive(pid), 3000), 'stubborn grandchild was SIGKILLed');
  });

  it('abort: AbortSignal kills the group; a pre-aborted signal never spawns', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await run('sh', ['-c', 'sleep 60'], { cwd: tmpDir(), signal: ac.signal });
    assert.equal(r.aborted, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.code, null);

    const dir = tmpDir();
    const pre = new AbortController();
    pre.abort();
    const r2 = await run('sh', ['-c', `touch "${join(dir, 'ran')}"`], { cwd: dir, signal: pre.signal });
    assert.equal(r2.aborted, true);
    assert.equal(await waitFor(() => false, 200), false);
    assert.throws(() => readFileSync(join(dir, 'ran')), /ENOENT/);
  });

  it('does not hang when a background process keeps the pipes open after the leader exits (and reaps it)', async () => {
    const dir = tmpDir();
    const t0 = Date.now();
    const r = await run('sh', ['-c', `sleep 60 & echo $! > "${join(dir, 'pid')}"; echo done`], { cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'done\n');
    assert.ok(Date.now() - t0 < 5000);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
    assert.ok(await waitFor(() => !alive(pid), 3000), 'stray background process reaped');
  });
});

describe('safeEnv', () => {
  it('forwards only the allowlist and never secrets', () => {
    for (const k of SECRET_VARS) process.env[k] = 'x'.repeat(24);
    process.env.SOME_RANDOM_VAR = 'nope';
    const env = safeEnv();
    for (const k of SECRET_VARS) assert.equal(env[k], undefined, `${k} must not be forwarded`);
    assert.equal(env.SOME_RANDOM_VAR, undefined);
    assert.ok(env.PATH && env.PATH.length > 0);
    assert.equal(env.HOME, process.env.HOME);
    delete process.env.SOME_RANDOM_VAR;
  });

  it('layers `extra` on top', () => {
    const env = safeEnv({ FOO: 'bar', PATH: '/custom' });
    assert.equal(env.FOO, 'bar');
    assert.equal(env.PATH, '/custom');
  });
});

describe('git / gitOk', () => {
  it('runs with GIT_TERMINAL_PROMPT=0 and LC_ALL=C and without secrets', async () => {
    for (const k of SECRET_VARS) process.env[k] = 'y'.repeat(24);
    const r = await git(tmpDir(), ['-c', 'alias.penv=!env', 'penv']);
    assert.equal(r.code, 0, r.stderr);
    const env = r.stdout;
    assert.match(env, /^GIT_TERMINAL_PROMPT=0$/m);
    assert.match(env, /^LC_ALL=C$/m);
    for (const k of SECRET_VARS) assert.doesNotMatch(env, new RegExp(`^${k}=`, 'm'));
  });

  it('opts.env adds variables on top of the safe environment', async () => {
    const r = await git(tmpDir(), ['-c', 'alias.penv=!env', 'penv'], { env: { MY_EXTRA: 'hello' } });
    assert.match(r.stdout, /^MY_EXTRA=hello$/m);
    assert.match(r.stdout, /^GIT_TERMINAL_PROMPT=0$/m);
  });

  it('gitOk returns trimmed stdout', async () => {
    const dir = tmpDir();
    await gitOk(dir, ['init', '-q']);
    writeFileSync(join(dir, 'a.txt'), 'x');
    const out = await gitOk(dir, ['rev-parse', '--show-toplevel']);
    assert.ok(out.endsWith(dir.split('/').pop()!) && !out.endsWith('\n'));
  });

  it('gitOk throws a typed GitError with code and stderr (no secrets in the message)', async () => {
    const dir = tmpDir();
    await assert.rejects(
      gitOk(dir, ['rev-parse', '--verify', 'refs/heads/nope']),
      (e: unknown) => {
        assert.ok(e instanceof GitError);
        assert.equal(e.name, 'GitError');
        assert.equal(typeof e.code, 'number');
        assert.notEqual(e.code, 0);
        assert.equal(typeof e.stderr, 'string');
        assert.deepEqual(e.args.slice(0, 1), ['rev-parse']);
        return true;
      },
    );
    await assert.rejects(gitOk(dir, ['fetch', 'https://user:ghp_' + 'a'.repeat(36) + '@127.0.0.1:9/x.git']), (e: unknown) => {
      assert.ok(e instanceof GitError);
      assert.doesNotMatch(e.message, /ghp_a{36}/);
      return true;
    });
  });

  it('git() resolves (does not throw) for a non-zero exit', async () => {
    const r = await git(tmpDir(), ['rev-parse', '--git-dir']);
    assert.notEqual(r.code, 0);
  });
});
