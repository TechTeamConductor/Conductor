// The dashboard has NO login: loopback + Host/Origin checks + a CSRF header are the whole defence. These tests pin that the removed pieces are
// really gone (no `conductor open`, no OTP / cookie / session code anywhere) and that the CLI answers an unknown command for `open`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'conductor.mjs');

test('`conductor open` is an unknown command (exit 2, help does not list it)', () => {
  const home = mkdtempSync(join(tmpdir(), 'cnl-'));
  try {
    const r = spawnSync(process.execPath, [BIN, 'open'], { env: { ...process.env, CONDUCTOR_HOME: join(home, 'h'), HOME: home, CONDUCTOR_NO_OPEN: '1' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2);
    assert.match(String(r.stderr), /Unknown command "open"/);
    assert.doesNotMatch(String(r.stderr), /conductor open|signed-in/);
    const help = spawnSync(process.execPath, [BIN, 'help'], { env: { ...process.env, CONDUCTOR_HOME: join(home, 'h'), HOME: home }, encoding: 'utf8', timeout: 30000 });
    assert.doesNotMatch(String(help.stdout), /^\s+open\s/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'payload' || n === 'dist') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|js|cjs|mjs|html|css|md|json)$/.test(n)) out.push(p);
  }
  return out;
}

test('static: no source, UI, desktop or doc mentions the removed login pieces', () => {
  const banned: [string, RegExp][] = [
    ['conductor open', /conductor open\b/i],
    ['one-time code', /\botp\b|one-time (sign-in )?(link|code)/i],
    ['session cookie', /COOKIE_NAME|conductor_v2_session|set-cookie|sessionCookie|clearCookie|parseCookies|session cookie/i],
    ['login helpers', /loginUrl|loginFile|loginTarget|LOGIN_PAGE|openRunning|openCmd|mintOtp|consumeOtp|validSession/],
    ['logout / expired UI', /api\/auth\/logout|i-logout|id="expired"|showExpired|S\.expired|Sign out/],
    ['sign-in routes', /['"`]\/(login|auth)\b/],
  ];
  const targets = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'ui')), ...files(join(ROOT, 'desktop')), ...files(join(ROOT, 'docs')), join(ROOT, 'README.md'), join(ROOT, 'AGENTS.md')];
  const hits: string[] = [];
  for (const f of targets) {
    if (f.endsWith('src/git/envvalues.ts')) continue; // an unrelated secret-looking-query-key list that contains the word "otp"
    const text = readFileSync(f, 'utf8');
    const isDoc = f.endsWith('.md'); // the docs may say that `/login` and `/auth` do not exist
    for (const [label, re] of banned) if (!(isDoc && label === 'sign-in routes') && re.test(text)) hits.push(`${f.slice(ROOT.length + 1)}: ${label}`);
  }
  assert.deepEqual(hits, []);
  assert.equal(existsSync(join(ROOT, 'src', 'server', 'auth.ts')), false);
});
