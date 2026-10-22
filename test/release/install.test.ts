// install/install.sh end to end, offline: a locally packed release goes through the real verification, unpacking, swap and launcher code
// (CONDUCTOR_LOCAL_DIR replaces only the download). Everything runs in a temp HOME; nothing touches the real home or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..', '..');
const INSTALL_SH = join(ROOT, 'install', 'install.sh');
const skip = process.platform === 'win32' ? 'the shell installer is not for Windows' : false;
const NODE_DIR = dirname(process.execPath);

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), `${p}-`));
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A minimal ustar writer so the tests can build hostile archives (traversal, absolute paths, links) deterministically. */
interface Entry { name: string; type?: '0' | '1' | '2' | '5'; linkname?: string; content?: string }
function makeTgz(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.content ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    if (e.linkname) h.write(e.linkname, 157, 100);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const goodPackage = (version = '1.2.3', name = 'conductor'): Entry[] => [
  { name: 'package/package.json', content: JSON.stringify({ name, version }) },
  { name: 'package/bin/conductor.mjs', content: `console.log(${JSON.stringify(version)});\n` },
];

/** A release folder: conductor.tgz + SHA256SUMS.txt (correct unless told otherwise). */
function release(tgz: Buffer, sums?: (hash: string) => string): string {
  const dir = tmp('release');
  writeFileSync(join(dir, 'conductor.tgz'), tgz);
  writeFileSync(join(dir, 'SHA256SUMS.txt'), (sums ?? ((h) => `${h}  conductor.tgz\n`))(sha(tgz)));
  return dir;
}

interface Run { status: number | null; out: string; err: string; home: string; app: string; bin: string }
function run(opts: { args?: string[]; env?: Record<string, string>; home?: string; localDir?: string; path?: string }): Run {
  const home = opts.home ?? join(tmp('home'), 'my home'); // a space on purpose
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { HOME: home, PATH: opts.path ?? `${NODE_DIR}:/usr/bin:/bin`, LANG: 'C', ...opts.env };
  if (opts.localDir) env.CONDUCTOR_LOCAL_DIR = opts.localDir;
  const r = spawnSync('bash', [INSTALL_SH, ...(opts.args ?? [])], { env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr, home, app: env.CONDUCTOR_INSTALL_DIR ?? join(home, '.conductor-app'), bin: env.CONDUCTOR_BIN_DIR ?? join(home, '.local', 'bin') };
}
const nothingInstalled = (r: Run): void => {
  assert.equal(existsSync(r.app), false, 'no app folder');
  assert.equal(existsSync(join(r.bin, 'conductor')), false, 'no launcher');
};
const leftovers = (r: Run): string[] => (existsSync(dirname(r.app)) ? readdirSync(dirname(r.app)).filter((n) => n.startsWith('.conductor-install')) : []);

test('install: a real npm-packed release installs, the launcher works from a HOME with a space, and the app reports its version', { skip }, () => {
  const out = tmp('pack');
  const name = execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop() as string;
  const tgz = readFileSync(join(out, name));
  const r = run({ localDir: release(tgz) });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /Conductor 0\.0\.0-dev is installed/);
  assert.match(r.out, /conductor start/);
  assert.ok(existsSync(join(r.app, 'bin', 'conductor.mjs')) && existsSync(join(r.app, 'ui')) && existsSync(join(r.app, 'prompts')));
  assert.ok(existsSync(join(r.app, '.conductor-installer')));
  const shim = readFileSync(join(r.bin, 'conductor'), 'utf8');
  assert.match(shim, /^# conductor-installer-shim v1$/m);
  const v = spawnSync(join(r.bin, 'conductor'), ['version'], { env: { HOME: r.home, PATH: `${NODE_DIR}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(v.stdout.trim(), '0.0.0-dev');
  assert.deepEqual(leftovers(r), [], 'no lock or temp folder left behind');
  // the packed copy contains exactly what the product needs and none of the internal files
  const listing = execFileSync('tar', ['-tzf', join(out, name)], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of listing) assert.match(f, /^package\/(package\.json|README\.md|bin\/|src\/|ui\/|prompts\/|fixtures\/fake-(claude|agent)\.mjs$)/, f);
});

test('install: conductor doctor runs from the extracted copy (outside node_modules)', { skip }, () => {
  const out = tmp('pack');
  const name = execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop() as string;
  const r = run({ localDir: release(readFileSync(join(out, name))) });
  assert.equal(r.status, 0, r.err);
  for (const f of ['fixtures/fake-claude.mjs', 'fixtures/fake-agent.mjs']) assert.ok(existsSync(join(r.app, f)), f);
  const d = spawnSync(join(r.bin, 'conductor'), ['doctor'], { env: { HOME: r.home, PATH: `${NODE_DIR}:/usr/bin:/bin`, CONDUCTOR_HOME: join(r.home, 'data') }, encoding: 'utf8', timeout: 60000 });
  assert.match(d.stdout, /setup check/);
});

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(port)); });
  srv.on('error', reject);
});
const probe = (port: number): Promise<number> => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on('error', () => resolve(0));
  req.on('timeout', () => { req.destroy(); resolve(0); });
});

test('install: the demo and the dashboard start from the installed launcher (HOME with a space)', { skip }, async () => {
  const out = tmp('pack');
  const name = execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop() as string;
  const r = run({ localDir: release(readFileSync(join(out, name))) });
  assert.equal(r.status, 0, r.err);
  const env = { HOME: r.home, PATH: `${NODE_DIR}:/usr/bin:/bin`, CONDUCTOR_HOME: join(r.home, 'data') };
  for (const args of [['demo', '--no-open'], ['start', '--no-open']]) {
    const port = await freePort();
    const child = spawn(join(r.bin, 'conductor'), [...args, '--port', String(port)], { env, stdio: 'ignore' });
    try {
      let code = 0;
      for (let i = 0; i < 80 && ![200, 302, 401].includes(code); i++) {
        code = await probe(port);
        if (![200, 302, 401].includes(code)) await new Promise((res) => setTimeout(res, 250));
      }
      assert.ok([200, 302, 401].includes(code), `${args[0]} did not answer (${code})`);
    } finally {
      child.kill('SIGTERM');
      await new Promise((res) => { child.once('exit', res); setTimeout(res, 3000); });
    }
  }
});

test('install: re-running updates in place and leaves no .old folder', { skip }, () => {
  const r1 = run({ localDir: release(makeTgz(goodPackage('1.0.0'))) });
  assert.equal(r1.status, 0, r1.err);
  const r2 = run({ home: r1.home, localDir: release(makeTgz(goodPackage('1.1.0'))) });
  assert.equal(r2.status, 0, r2.err);
  assert.match(r2.out, /Conductor 1\.1\.0 is installed/);
  assert.equal(JSON.parse(readFileSync(join(r2.app, 'package.json'), 'utf8')).version, '1.1.0');
  assert.equal(existsSync(`${r2.app}.old`), false);
});

test('install: a wrong checksum, a missing line, a duplicate line and a malformed line all abort and change nothing', { skip }, () => {
  const tgz = makeTgz(goodPackage());
  const bad = 'a'.repeat(64);
  for (const sums of [(h: string) => `${bad}  conductor.tgz\n`, () => 'nothing useful\n', (h: string) => `${h}  other.tgz\n`, (h: string) => `${h}  conductor.tgz\n${h}  conductor.tgz\n`, (h: string) => `${h.toUpperCase()}  conductor.tgz\n`, (h: string) => `${h} conductor.tgz\n`]) {
    const r = run({ localDir: release(tgz, sums) });
    assert.equal(r.status, 1);
    assert.match(r.err, /checksum|SHA256SUMS/i);
    nothingInstalled(r);
    assert.deepEqual(leftovers(r), []);
  }
});

test('install: CRLF line endings in SHA256SUMS.txt are accepted', { skip }, () => {
  const r = run({ localDir: release(makeTgz(goodPackage()), (h) => `${h}  conductor.tgz\r\n`) });
  assert.equal(r.status, 0, r.err);
});

test('install: a tampered tarball (checksum no longer matches) is refused', { skip }, () => {
  const tgz = makeTgz(goodPackage());
  const dir = release(tgz);
  const evil = Buffer.from(tgz);
  evil[evil.length - 12] ^= 0xff;
  writeFileSync(join(dir, 'conductor.tgz'), evil);
  const r = run({ localDir: dir });
  assert.equal(r.status, 1);
  assert.match(r.err, /checksum mismatch/);
  nothingInstalled(r);
});

test('install: hostile archives are refused before anything is unpacked (traversal, absolute path, link, wrong layout, wrong name)', { skip }, () => {
  const cases: [string, Entry[], RegExp][] = [
    ['traversal', [...goodPackage(), { name: 'package/../../evil.txt', content: 'x' }], /unsafe path/],
    ['traversal start', [...goodPackage(), { name: '../evil.txt', content: 'x' }], /unsafe path/],
    ['absolute', [...goodPackage(), { name: '/tmp/evil.txt', content: 'x' }], /unsafe path/],
    ['backslash', [...goodPackage(), { name: 'package\\evil.txt', content: 'x' }], /unsafe path/],
    ['symlink', [...goodPackage(), { name: 'package/link', type: '2', linkname: '/etc/passwd' }], /links or special/],
    ['hardlink', [...goodPackage(), { name: 'package/hard', type: '1', linkname: 'package/package.json' }], /links or special/],
    ['outside package/', [...goodPackage(), { name: 'other/file.txt', content: 'x' }], /unexpected entry/],
    ['wrong package name', goodPackage('1.2.3', 'not-conductor'), /not a Conductor package/],
    ['no entry point', [{ name: 'package/package.json', content: JSON.stringify({ name: 'conductor', version: '1.2.3' }) }], /missing bin/],
    ['bad version', goodPackage('1.2.3; rm -rf /'), /invalid version/],
  ];
  for (const [label, entries, msg] of cases) {
    const r = run({ localDir: release(makeTgz(entries)) });
    assert.equal(r.status, 1, label);
    assert.match(r.err, msg, label);
    nothingInstalled(r);
    assert.equal(existsSync(join(dirname(r.home), 'evil.txt')) || existsSync('/tmp/evil.txt'), false, `${label}: nothing escaped`);
  }
});

test('install: a truncated archive (checksum matches the truncated file) installs nothing', { skip }, () => {
  const whole = makeTgz(goodPackage());
  const r = run({ localDir: release(whole.subarray(0, Math.floor(whole.length / 2))) });
  assert.notEqual(r.status, 0);
  nothingInstalled(r);
  assert.deepEqual(leftovers(r), []);
});

test('the launcher explains itself when node is not on PATH', { skip }, () => {
  const r = run({ localDir: release(makeTgz(goodPackage())) });
  assert.equal(r.status, 0, r.err);
  const v = spawnSync('/bin/sh', [join(r.bin, 'conductor'), 'version'], { env: { HOME: r.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(v.status, 1);
  assert.match(v.stderr, /needs Node\.js 22\.18/);
});

test('install: CONDUCTOR_INSTALL_VERSION is strictly validated before anything else happens', { skip }, () => {
  for (const v of ['1.2', 'v1.2.3', '1.2.3\n', '1.2.3 ', '1.2.3; ls', '', 'latest', '１.２.３', '1.2.3-rc1', '1.2.3/../x']) {
    const r = run({ env: { CONDUCTOR_INSTALL_VERSION: v }, localDir: release(makeTgz(goodPackage())) });
    assert.equal(r.status, 1, JSON.stringify(v));
    assert.match(r.err, /CONDUCTOR_INSTALL_VERSION/, JSON.stringify(v));
    nothingInstalled(r);
  }
});

test('install: an archive whose version differs from the requested one is refused', { skip }, () => {
  const r = run({ env: { CONDUCTOR_INSTALL_VERSION: '2.0.0' }, localDir: release(makeTgz(goodPackage('1.2.3'))) });
  assert.equal(r.status, 1);
  assert.match(r.err, /version 1\.2\.3 but release v2\.0\.0/);
  nothingInstalled(r);
});

test('install: Node older than 22.18 (or missing) stops with an explanation and changes nothing', { skip }, () => {
  const fake = tmp('fakenode');
  writeFileSync(join(fake, 'node'), '#!/bin/sh\necho 20.11.0\n');
  chmodSync(join(fake, 'node'), 0o755);
  const old = run({ path: `${fake}:/usr/bin:/bin`, localDir: release(makeTgz(goodPackage())) });
  assert.equal(old.status, 1);
  assert.match(old.err, /22\.18 or newer is required \(you have 20\.11\.0\)/);
  nothingInstalled(old);
  const none = run({ path: '/usr/bin:/bin', localDir: release(makeTgz(goodPackage())) });
  assert.equal(none.status, 1);
  assert.match(none.err, /Node\.js 22\.18 or newer is required/);
  nothingInstalled(none);
});

test('install: it never overwrites a conductor it did not create, nor an app folder it did not create', { skip }, () => {
  const home = join(tmp('home'), 'h');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'conductor'), '#!/bin/sh\necho mine\n');
  const r = run({ home, localDir: release(makeTgz(goodPackage())) });
  assert.equal(r.status, 1);
  assert.match(r.err, /another 'conductor' already exists/);
  assert.equal(readFileSync(join(home, '.local', 'bin', 'conductor'), 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(existsSync(r.app), false);
  const home2 = join(tmp('home'), 'h');
  mkdirSync(join(home2, '.conductor-app'), { recursive: true });
  writeFileSync(join(home2, '.conductor-app', 'precious.txt'), 'keep');
  const r2 = run({ home: home2, localDir: release(makeTgz(goodPackage())) });
  assert.equal(r2.status, 1);
  assert.match(r2.err, /was not created by this installer/);
  assert.equal(readFileSync(join(home2, '.conductor-app', 'precious.txt'), 'utf8'), 'keep');
});

test('install: unsafe install or launcher folders are refused', { skip }, () => {
  const unsafe: Record<string, string>[] = [{ CONDUCTOR_INSTALL_DIR: "/tmp/it's" }, { CONDUCTOR_INSTALL_DIR: '/tmp/a$b' }, { CONDUCTOR_BIN_DIR: '/tmp/a`b' }, { CONDUCTOR_INSTALL_DIR: '/tmp/a"b' }, { CONDUCTOR_INSTALL_DIR: '/tmp/a\\b' }, { CONDUCTOR_INSTALL_DIR: '/tmp/a\nb' }, { CONDUCTOR_INSTALL_DIR: 'relative/dir' }];
  for (const env of unsafe) {
    const r = run({ env, localDir: release(makeTgz(goodPackage())) });
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.match(r.err, /unsupported characters/);
  }
});

test('install: non-ASCII names, spaces and parentheses in the home folder are fine', { skip }, () => {
  const home = join(tmp('home'), 'José (work) home');
  const r = run({ home, localDir: release(makeTgz(goodPackage())) });
  assert.equal(r.status, 0, r.err);
  const v = spawnSync(join(r.bin, 'conductor'), ['version'], { env: { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(v.stdout.trim(), '1.2.3');
});

test('install: the root folder and a symlinked app folder are refused', { skip }, () => {
  const rootRun = run({ env: { CONDUCTOR_INSTALL_DIR: '/' }, localDir: release(makeTgz(goodPackage())) });
  assert.equal(rootRun.status, 1);
  assert.match(rootRun.err, /root folder/);
  const home = join(tmp('home'), 'h');
  const real = join(tmp('real'), 'real-app');
  mkdirSync(real, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('ln', ['-s', real, join(home, '.conductor-app')]);
  const r = run({ home, localDir: release(makeTgz(goodPackage())) });
  assert.equal(r.status, 1);
  assert.match(r.err, /symlink/);
  assert.deepEqual(readdirSync(real), []);
  const u = run({ home, args: ['--uninstall'] });
  assert.match(u.out, /symlink/);
  assert.ok(existsSync(real));
});

test('install: installing from a local folder says its checksum only catches corruption', { skip }, () => {
  const r = run({ localDir: release(makeTgz(goodPackage())) });
  assert.match(r.out, /only catches corruption/);
});

test('install: a stale lock stops a second install and is never deleted automatically', { skip }, () => {
  const home = join(tmp('home'), 'h');
  mkdirSync(join(home, '.conductor-install.lock-parent'), { recursive: true });
  const app = join(home, 'apps', 'conductor-app');
  mkdirSync(join(home, 'apps', '.conductor-install.lock'), { recursive: true });
  const r = run({ home, env: { CONDUCTOR_INSTALL_DIR: app }, localDir: release(makeTgz(goodPackage())) });
  assert.equal(r.status, 1);
  assert.match(r.err, /another install seems to be running/);
  assert.ok(existsSync(join(home, 'apps', '.conductor-install.lock')));
});

test('uninstall: removes the app and launcher only, leaves the data folder, is idempotent and refuses foreign folders', { skip }, () => {
  const r = run({ localDir: release(makeTgz(goodPackage())) });
  assert.equal(r.status, 0, r.err);
  mkdirSync(join(r.home, '.conductor-v2'), { recursive: true });
  writeFileSync(join(r.home, '.conductor-v2', 'board.json'), 'my boards');
  mkdirSync(join(r.home, '.conductor'), { recursive: true });
  writeFileSync(join(r.home, '.conductor', 'v1.json'), 'v1 data');
  const u = run({ home: r.home, args: ['--uninstall'] });
  assert.equal(u.status, 0, u.err);
  nothingInstalled(r);
  assert.equal(readFileSync(join(r.home, '.conductor-v2', 'board.json'), 'utf8'), 'my boards');
  assert.equal(readFileSync(join(r.home, '.conductor', 'v1.json'), 'utf8'), 'v1 data');
  assert.match(u.out, /data folder .* was not touched/);
  const again = run({ home: r.home, args: ['--uninstall'] });
  assert.equal(again.status, 0);
  assert.match(again.out, /Nothing to remove/);
  // a folder or launcher that is not ours is left alone
  const home = join(tmp('home'), 'h');
  mkdirSync(join(home, '.conductor-app'), { recursive: true });
  writeFileSync(join(home, '.conductor-app', 'x.txt'), 'x');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'conductor'), 'not ours');
  const foreign = run({ home, args: ['--uninstall'] });
  assert.equal(foreign.status, 0);
  assert.equal(readFileSync(join(home, '.conductor-app', 'x.txt'), 'utf8'), 'x');
  assert.equal(readFileSync(join(home, '.local', 'bin', 'conductor'), 'utf8'), 'not ours');
});

test('install: an unknown option is rejected, and the PATH hint appears when the launcher folder is not on PATH', { skip }, () => {
  assert.equal(run({ args: ['--bogus'] }).status, 1);
  const r = run({ localDir: release(makeTgz(goodPackage())) });
  assert.match(r.out, /is not on your PATH yet/);
  assert.match(r.out, /export PATH=/);
  assert.match(r.out, /conductor start/);
  const onPath = run({ localDir: release(makeTgz(goodPackage())), home: r.home, path: `${join(r.home, '.local', 'bin')}:${NODE_DIR}:/usr/bin:/bin` });
  assert.doesNotMatch(onPath.out, /is not on your PATH yet/);
});

test('install: helpers (tag from URL) accept only a real release tag URL', { skip }, () => {
  const t = (url: string): { status: number | null; out: string } => {
    const r = spawnSync('bash', ['-c', 'CONDUCTOR_INSTALLER_NO_MAIN=1 source "$1"; tag_from_url "$2"', '_', INSTALL_SH, url], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout };
  };
  assert.deepEqual(t('https://github.com/TechTeamConductor/Conductor/releases/tag/v1.2.3'), { status: 0, out: 'v1.2.3' });
  for (const bad of ['https://github.com/TechTeamConductor/Conductor/releases/tag/v1.2', 'https://github.com/evil/Conductor/releases/tag/v1.2.3', 'http://github.com/TechTeamConductor/Conductor/releases/tag/v1.2.3', 'https://github.com/TechTeamConductor/Conductor/releases', 'https://github.com/TechTeamConductor/Conductor/releases/tag/v1.2.3;ls', '']) assert.notEqual(t(bad).status, 0, bad);
});

test('install: install.sh passes shellcheck (when shellcheck is available)', { skip: skip || spawnSync('shellcheck', ['--version']).status !== 0 ? 'shellcheck not installed' : false }, () => {
  const r = spawnSync('shellcheck', ['-x', INSTALL_SH], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
