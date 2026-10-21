// AC7 (S2, S3, B5b): decoy commands/agents/email in the Claude reply and an email on stderr ⇒ absent from the cache file, the API
// response, the log (captured and on disk), every reason, and `conductor models --json`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from '../../src/server/api.ts';
import { cacheFile } from '../../src/models/cache.ts';
import { configureLog } from '../../src/log.ts';
import { paths } from '../../src/paths.ts';
import { buildService, modelHome } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const h = modelHome();
after(() => h.cleanup());
configureLog({ file: true, level: 'info' });

const FORBIDDEN = [/DECOY_/, /decoy\.person/, /@example\.com/, /[^\s@"]{1,64}@[^\s@"]{1,255}/, /\/Users\/decoy/, /PLACEHOLDER_/];
const clean = (what: string, text: string) => {
  for (const re of FORBIDDEN) assert.ok(!re.test(text), `${what} contains ${re}: ${text.slice(0, 300)}`);
};
const logText = () => (existsSync(paths.logs()) ? readdirSync(paths.logs()).map((f) => readFileSync(join(paths.logs(), f), 'utf8')).join('\n') : '');

test('decoy reply (commands, agents, email, organisation, tokenSource, userID) + email on stderr: nothing leaks anywhere', async () => {
  h.scenario({ models: 'decoy', lingerMs: 30_000 });
  const { svc, logs } = buildService(h, { log: undefined }); // the real logger → <home>/logs
  const v = await svc.refresh('claude');
  assert.equal(v.state, 'fresh');
  assert.equal(v.signedIn, true);
  assert.equal(v.plan, 'Claude Team');
  const file = readFileSync(cacheFile('claude', 'default'), 'utf8');
  clean('cache file', file);
  assert.ok(!/tokenSource|apiProvider|organization|email|userID|commands|agents/.test(file));
  const api = new Api({ models: svc } as any);
  const res = await api.handle('GET', '/api/models', new URLSearchParams(), {});
  clean('GET /api/models', JSON.stringify(res.json));
  assert.match(logText(), /models refresh provider=claude/, 'the real logger wrote the line');
  clean('log file', logText());
  clean('captured log', logs.join('\n'));
  // the CLI prints the same allow-listed view from the cache
  const out = execFileSync(process.execPath, [join(ROOT, 'bin', 'conductor.mjs'), 'models', '--json'], { env: { ...process.env, CONDUCTOR_HOME: h.home, CONDUCTOR_QUIET: '1' }, encoding: 'utf8' });
  clean('conductor models --json', out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.providers[0].provider, 'claude');
  assert.equal(parsed.providers[0].models.length, 13);
});

test('email + home path on Claude stderr (no reply): the reason and the log carry neither', async () => {
  h.scenario({ models: 'stderr-email' });
  const { svc, logs } = buildService(h);
  const v = await svc.refresh('claude');
  assert.equal(v.state, 'stale');
  assert.match(v.reason!, /ended without listing its models: .*\[email\]/);
  clean('reason', v.reason!);
  clean('captured log', logs.join('\n'));
});

test('email on Cursor stderr: the static sign-in reason, nothing echoed', async () => {
  h.scenario({ listModels: 'stderr-email' });
  const { svc, logs } = buildService(h);
  const v = await svc.refresh('cursor');
  assert.equal(v.reason, 'Sign in to Cursor to see its models');
  clean('captured log', logs.join('\n'));
});

test('S14: the refresh log line has counts only — no model ids or labels', async () => {
  h.scenario({ models: 'in', lingerMs: 30_000 });
  const { svc, logs } = buildService(h);
  await svc.refresh('claude', 'manual');
  const line = logs.find((l) => l.includes('models refresh provider=claude'))!;
  assert.match(line, /models=13 dropped=0 cliVersion=2\.1\.304 durationMs=\d+/);
  for (const w of ['opus', 'sonnet', 'Haiku', 'Default (recommended)']) assert.ok(!line.includes(w), w);
});
