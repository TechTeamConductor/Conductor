// AC2: the recorded Cursor `--list-models` output (agent 2026.10.19) parses to 265 kept / 0 dropped; `auto` is the default; NO-ZDR flags;
// the zero-width characters at the end of 4 labels are cleaned; "Authentication required" ⇒ stale (with a cache) / unavailable (without).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCursorList, CURSOR_REASONS } from '../../src/models/cursor.ts';
import { REAL, buildService, modelHome } from './helpers.ts';

const text = readFileSync(join(REAL, 'cursor-list-models-2026.10.19.txt'), 'utf8');
const h = modelHome();
after(() => h.cleanup());

test('AC2 fixture: 265 kept / 0 dropped; header, blank and Tip lines ignored', () => {
  assert.ok(/[\u200b-\u200d\u2060\ufeff]/.test(text), 'the fixture keeps the zero-width characters verbatim');
  const p = parseCursorList(text.split('\n'));
  assert.equal(p.models.length, 265);
  assert.equal(p.dropped, 0);
  assert.ok(p.ignored >= 3);
  const ids = text.split('\n').map((l) => /^(\S+) - /.exec(l)?.[1]).filter(Boolean);
  assert.deepEqual(p.models.map((m) => m.id), ids, 'every real id passes the id rule, in order');
});

test('AC2: auto is the one default; NO ZDR flags; flags stripped from labels; zero-width cleaned', () => {
  const p = parseCursorList(text.split('\n'));
  const defs = p.models.filter((m) => m.isDefault);
  assert.deepEqual(defs.map((m) => m.id), ['auto']);
  assert.equal(defs[0]!.label, 'Auto');
  const noZdr = p.models.filter((m) => m.noZdr);
  assert.equal(noZdr.length, text.split('\n').filter((l) => /\(NO ZDR\)\s*$/.test(l.replace(/[\u200b-\u200d\u2060\ufeff]/g, ''))).length);
  assert.ok(noZdr.length > 0);
  for (const m of p.models) {
    assert.ok(!/\((NO ZDR|current, default)\)/.test(m.label), m.label);
    assert.ok(!/[\u200b-\u200d\u2060\ufeff]/.test(m.label), m.id);
    assert.ok(m.label.length <= 80);
  }
  for (const id of ['grok-4.7-low-fast', 'grok-4.7-medium-fast', 'grok-4.7-high-fast', 'grok-4.7-xhigh-fast']) assert.ok(p.models.some((m) => m.id === id));
});

test('AC2 through the service: signed out ⇒ unavailable with the sign-in reason when there is no cache', async () => {
  const { svc } = buildService(h);
  h.scenario({ listModels: 'auth' });
  const v = await svc.refresh('cursor');
  assert.equal(v.state, 'unavailable');
  assert.equal(v.reason, CURSOR_REASONS.signIn);
  assert.equal(v.models, undefined);
});

test('AC2 through the service: a list, then signed out ⇒ stale, list kept, reason names the time and the sign-in', async () => {
  const { svc } = buildService(h);
  h.scenario({ listModels: 'ok' });
  const ok = await svc.refresh('cursor');
  assert.equal(ok.state, 'fresh');
  assert.equal(ok.models!.length, 265);
  assert.ok(ok.families!.length > 0);
  // a NEW service (the first one is inside its 10 s manual window) reads the cache, then fails
  const { svc: svc2 } = buildService(h);
  h.scenario({ listModels: 'auth' });
  const v = await svc2.refresh('cursor');
  assert.equal(v.state, 'stale');
  assert.equal(v.models!.length, 265);
  assert.match(v.reason!, /^showing the list from \d\d:\d\d — Sign in to Cursor to see its models$/);
});

test('zero model lines ⇒ never an empty fresh list; another failure ⇒ static reason with the exit code only', async () => {
  assert.equal(parseCursorList(['Available models', '', 'Tip: nothing']).models.length, 0);
  h.scenario({ listModels: 'empty' });
  const v1 = await buildService(h).svc.refresh('cursor');
  assert.equal(v1.state, 'stale', 'the earlier list is kept');
  assert.match(v1.reason!, /listed no models$/);
  h.scenario({ listModels: 'fail' });
  const v2 = await buildService(h).svc.refresh('cursor');
  assert.equal(v2.state, 'stale');
  assert.match(v2.reason!, /could not list its models \(exit code 2\)$/);
  assert.ok(!v2.reason!.includes('/Users'), 'the CLI message is never echoed (S16)');
});

test('L3: "Authentication required" inside a model label (stdout, exit 0) never marks the list signed out', async () => {
  h.scenario({ listModels: 'text', listExit: 0, listText: 'Available models\n\nm-1 - Authentication required edition\nm-2 - Plain\n' });
  const v = await buildService(h).svc.refresh('cursor');
  assert.equal(v.state, 'fresh');
  assert.deepEqual(v.models!.map((m) => m.id), ['m-1', 'm-2']);
  assert.equal(v.models![0]!.label, 'Authentication required edition');
});

test('L3: the phrase on a non-model stdout line with a non-zero exit ⇒ signed out; inside a model line with a non-zero exit ⇒ a plain failure', async () => {
  h.scenario({ listModels: 'text', listExit: 1, listText: "Error: Authentication required. Run 'agent login'.\n" });
  const a = await buildService(h).svc.refresh('cursor');
  assert.match(a.reason!, /Sign in to Cursor to see its models$/);
  h.scenario({ listModels: 'text', listExit: 1, listText: 'm-1 - Authentication required edition\n' });
  const b = await buildService(h).svc.refresh('cursor');
  assert.match(b.reason!, /could not list its models \(exit code 1\)$/);
});
