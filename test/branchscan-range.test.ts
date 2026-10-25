import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanPushRange } from '../src/git/branchscan.ts';
import { isolateGitHome, makeRepo, sg } from './helpers/tmp-repo.ts';

isolateGitHome();

const TOKEN = 'ghp_' + 'a1B2c3D4'.repeat(5);
const PEM = ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxx', 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy', '-----END ' + 'RSA PRIVATE KEY-----'].join('\n');

async function scan(r: { dir: string; head(): string }, exclude: string[], env: { name: string; value: string; multiline?: boolean }[] = []) {
  return scanPushRange({ repoRoot: r.dir, tip: r.head(), excludeTips: exclude, envEntries: env });
}
function blocked(x: Awaited<ReturnType<typeof scan>>) {
  assert.equal(x.ok, false);
  return x as Extract<typeof x, { ok: false }>;
}

describe('scanPushRange', () => {
  it('clean range passes; empty range passes', async () => {
    const r = makeRepo();
    const base = r.head();
    assert.deepEqual(await scan(r, [base]), { ok: true });
    r.write('a.md', 'hello\n');
    r.commit('add a');
    assert.deepEqual(await scan(r, [base]), { ok: true });
  });

  it('a secret added then removed in a later commit is still found, and the reason does not contain it', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('src/k.js', `const k = '${TOKEN}';\n`);
    const bad = r.commit('add key');
    r.write('src/k.js', 'const k = process.env.K;\n');
    r.commit('remove key');
    const x = blocked(await scan(r, [base]));
    assert.deepEqual(x.commits, [bad.slice(0, 10)]);
    assert.deepEqual(x.files, ['src/k.js']);
    assert.ok(!JSON.stringify(x).includes(TOKEN));
  });

  it('empty excludeTips scans the full history', async () => {
    const r = makeRepo({ files: { 'a.js': `x='${TOKEN}'\n` } });
    blocked(await scan(r, []));
    assert.equal((await scan(r, [r.head()])).ok, true);
  });

  it('multi-line PEM in a .md is caught (lines joined per file)', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('docs/key.md', `# notes\n${PEM}\n`);
    r.commit('doc');
    assert.equal(blocked(await scan(r, [base])).files[0], 'docs/key.md');
  });

  it('a line that looks like a diff header inside added content cannot hide the next file', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('a.md', '++ b/other.md\n');
    r.write('z.md', `${TOKEN}\n`);
    r.commit('tricky');
    assert.deepEqual(blocked(await scan(r, [base])).files, ['z.md']);
  });

  it('commit message and author fields are scanned', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('a.md', 'x\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', `leak ${TOKEN}`]);
    assert.deepEqual(blocked(await scan(r, [base])).files, ['(commit message or author fields)']);
    const r2 = makeRepo();
    const b2 = r2.head();
    r2.write('a.md', 'x\n');
    r2.git(['add', '-A']);
    sg(r2.dir, ['commit', '-q', '-m', 'ok', '--author', `A <${TOKEN}@x.test>`]);
    assert.equal((await scan(r2, [b2])).ok, false);
  });

  it('secret-style file names block; .env.example is exempt', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('.env.example', 'A=1\n');
    r.commit('example');
    assert.equal((await scan(r, [base])).ok, true);
    r.write('deploy/id_rsa', 'not really\n');
    r.commit('key');
    assert.deepEqual(blocked(await scan(r, [base])).files, ['deploy/id_rsa']);
  });

  it('a file over 5 MB blocks', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('big.bin', Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    r.commit('big');
    assert.match(blocked(await scan(r, [base])).reason, /larger than 5 MB/);
  });

  it('over the per-commit patch cap fails closed (truncation)', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('lots.txt', 'harmless line\n'.repeat(5000));
    r.commit('lots');
    const x = blocked(await scanPushRange({ repoRoot: r.dir, tip: r.head(), excludeTips: [base], envEntries: [], maxCommitBytes: 1024 }));
    assert.match(x.reason, /could not complete/);
  });

  it('unresolvable tip, exclude tip, option-like revs fail closed', async () => {
    const r = makeRepo();
    for (const [tip, ex] of [['f'.repeat(40), []], [r.head(), ['e'.repeat(40)]], ['--all', []], [r.head(), ['--all']]] as [string, string[]][]) {
      const x = blocked(await scanPushRange({ repoRoot: r.dir, tip, excludeTips: ex, envEntries: [] }));
      assert.match(x.reason, /could not complete/);
    }
    assert.match(blocked(await scanPushRange({ repoRoot: '/nonexistent-dir-xyz', tip: 'HEAD', excludeTips: [], envEntries: [] })).reason, /could not complete/);
  });

  it('a merge commit in the range holds', async () => {
    const r = makeRepo();
    const base = r.head();
    r.git(['checkout', '-q', '-b', 'side']);
    r.write('s.md', 's\n');
    r.commit('side');
    r.git(['checkout', '-q', 'main']);
    r.write('m.md', 'm\n');
    r.commit('main');
    r.git(['merge', '-q', '--no-ff', '-m', 'merge', 'side']);
    assert.match(blocked(await scan(r, [base])).reason, /merge commit/);
  });

  it('env entries: qualifying value blocks in .md/.json/source/readded; public value passes; multi-line PEM value caught', async () => {
    const SECRET = { name: 'SIGNING_SECRET', value: 'plainwordvalue1' };
    const PUBLIC = { name: 'APP_URL', value: 'https://app.example.com/landing' };
    for (const file of ['a.md', 'a.json', 'src/a.ts']) {
      const r = makeRepo();
      const base = r.head();
      r.write(file, `${SECRET.value}\n${PUBLIC.value}\n`);
      r.commit('x');
      assert.equal((await scan(r, [base], [SECRET, PUBLIC])).ok, false, file);
      assert.equal((await scan(r, [base], [PUBLIC])).ok, true, file);
    }
    const r = makeRepo();
    const base = r.head();
    r.write('n.md', 'middle-of-key-line-123456789\n');
    r.commit('x');
    assert.equal((await scan(r, [base], [{ name: 'WHATEVER', value: 'a\nmiddle-of-key-line-123456789\nb', multiline: true }])).ok, false);
  });
});
