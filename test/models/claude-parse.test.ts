// AC1: the recorded Claude `initialize` replies (2.1.304) parse to exactly 13 kept / 0 dropped (signed in) and 5 / 0 (signed out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseClaudeInitialize } from '../../src/models/claude.ts';
import { REAL, readJson } from './helpers.ts';

const signedIn = readJson(join(REAL, 'claude-initialize-2.1.304.json'));
const signedOut = readJson(join(REAL, 'claude-initialize-2.1.304-signed-out.json'));
const conductorEnv = readJson(join(REAL, 'claude-initialize-2.1.304-conductor-env.json'));

test('AC1 signed in: 13 kept / 0 dropped, default → claude-opus-5-5, efforts per model, plan, version', () => {
  const p = parseClaudeInitialize(signedIn.response.response)!;
  assert.ok(p);
  assert.equal(p.models.length, 13);
  assert.equal(p.dropped, 0);
  assert.equal(p.signedIn, true);
  assert.equal(p.plan, 'Claude Team');
  assert.equal(p.cliVersion, '2.1.304');
  const def = p.models.find((m) => m.isDefault)!;
  assert.equal(def.id, 'default');
  assert.equal(def.resolved, 'claude-opus-5-5');
  assert.equal(p.models.filter((m) => m.isDefault).length, 1);
  const by = new Map(p.models.map((m) => [m.id, m]));
  assert.deepEqual(by.get('opus')!.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(by.get('claude-opus-4-6')!.efforts, ['low', 'medium', 'high', 'max'], 'Opus 4.6 has no xhigh');
  assert.deepEqual(by.get('claude-sonnet-4-6')!.efforts, ['low', 'medium', 'high', 'max']);
  assert.equal(by.get('claude-haiku-4-5-20251001')!.efforts, undefined, 'Haiku 4.5 reports no effort levels');
  assert.equal(by.get('opus')!.fast, true);
  assert.equal(by.get('sonnet')!.fast, undefined);
  assert.equal(by.get('claude-haiku-4-5-20251001')!.thinkingOff, true);
  assert.equal(by.get('opus')!.thinkingOff, undefined, 'false stays absent');
  assert.equal(by.get('opus')!.adaptiveThinking, true);
  assert.equal(by.get('fable')!.label, 'Fable 5.1');
  // every real id passes the id rule (B5c: a real id failing it would stop the slice)
  assert.deepEqual(p.models.map((m) => m.id), signedIn.response.response.models.map((m: any) => m.value));
});

test('AC1 Conductor env (what Conductor really sees, no CLAUDE_CODE_ENTRYPOINT): 5 kept / 0 dropped, the [1m] entry kept (W2/W5)', () => {
  const p = parseClaudeInitialize(conductorEnv.response.response)!;
  assert.equal(p.models.length, 5);
  assert.equal(p.dropped, 0);
  assert.deepEqual(p.models.map((m) => m.id), ['default', 'opus', 'claude-fable-5-1[1m]', 'sonnet', 'haiku']);
  const fable = p.models[2]!;
  assert.equal(fable.resolved, 'claude-fable-5-1[1m]');
  assert.deepEqual(fable.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(p.models.find((m) => m.isDefault)!.resolved, 'claude-opus-5-5');
  assert.equal(p.signedIn, true);
  assert.equal(p.plan, 'Claude Team');
  assert.equal(p.cliVersion, '2.1.304');
  assert.deepEqual(p.models.map((m) => m.id), conductorEnv.response.response.models.map((m: any) => m.value), 'every real id passes the Claude rule');
});

test('AC1 signed out: 5 aliases kept / 0 dropped, signedIn false, no plan', () => {
  const p = parseClaudeInitialize(signedOut.response.response)!;
  assert.equal(p.models.length, 5);
  assert.equal(p.dropped, 0);
  assert.equal(p.signedIn, false);
  assert.equal(p.plan, undefined);
  assert.deepEqual(p.models.map((m) => m.id), ['default', 'opus', 'fable', 'sonnet', 'haiku']);
});

test('signedIn: tokenSource none ⇒ false; an API-key user with no email ⇒ true; no account ⇒ unknown', () => {
  const base = { models: [{ value: 'opus', displayName: 'Opus' }] };
  assert.equal(parseClaudeInitialize({ ...base, account: { tokenSource: 'none' } })!.signedIn, false);
  assert.equal(parseClaudeInitialize({ ...base, account: { tokenSource: 'apiKey', apiProvider: 'firstParty' } })!.signedIn, true);
  assert.equal(parseClaudeInitialize({ ...base })!.signedIn, null);
});

test('only email/organization are collected as identity (for redaction), and never appear in the parsed result', () => {
  const p = parseClaudeInitialize(signedIn.response.response)!;
  assert.deepEqual(p.identity, ['PLACEHOLDER_EMAIL', 'PLACEHOLDER_ORGANIZATION']);
  const { identity, ...rest } = p;
  void identity;
  assert.ok(!JSON.stringify(rest).includes('PLACEHOLDER'));
});
