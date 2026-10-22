// AC4 (S8, S9): hostile discovery output — capped, dropped or unavailable as specified; nothing crashes; nothing unvalidated is stored.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeInitialize, CLAUDE_REASONS } from '../../src/models/claude.ts';
import { parseCursorList } from '../../src/models/cursor.ts';
import { cacheFile } from '../../src/models/cache.ts';
import { modelIdOk } from '../../src/models/sanitize.ts';
import { buildService, modelHome } from './helpers.ts';

const h = modelHome();
after(() => h.cleanup());

test('Claude parser: controls/bidi/zero-width/lone surrogates in labels cleaned; bad ids dropped and counted (never repaired); duplicates first-wins', () => {
  const p = parseClaudeInitialize({
    models: [
      { value: 'opus', displayName: 'Op\u202eus\u200b\u0007\ud800 X' },
      { value: 'opus', displayName: 'duplicate' },
      { value: '--dangerous', displayName: 'option-shaped' },
      { value: 'a b', displayName: 'space' },
      { value: 'x'.repeat(65), displayName: 'too long' },
      { value: 'ok\u200b-id', displayName: 'a hidden character inside an id: refused, never repaired' },
      { value: 'opus[1m]', displayName: 'the Claude bracket suffix is accepted (W2)' },
      { value: 'opus[1M]', displayName: 'upper-case suffix refused' },
      { value: 'opus[effort=high]', displayName: 'parameter syntax refused' },
    ],
  })!;
  assert.deepEqual(p.models.map((m) => m.id), ['opus', 'opus[1m]']);
  assert.equal(p.models[0]!.label, 'Opus X');
  assert.equal(p.dropped, 7);
});

test('Claude parser: > 1,000 models capped (rest counted), labels ≤ 80', () => {
  const p = parseClaudeInitialize({ models: Array.from({ length: 1205 }, (_, i) => ({ value: `m-${i}`, displayName: 'L'.repeat(500) })) })!;
  assert.equal(p.models.length, 1000);
  assert.equal(p.dropped, 205);
  assert.ok(p.models.every((m) => m.label.length === 80));
});

test('Claude parser: no models array, or an entry without a string value ⇒ unexpected shape (null)', () => {
  assert.equal(parseClaudeInitialize({ account: {} }), null);
  assert.equal(parseClaudeInitialize({ models: 'opus' }), null);
  assert.equal(parseClaudeInitialize({ models: [{ value: 'opus' }, { displayName: 'no value' }] }), null);
  assert.equal(parseClaudeInitialize({ models: [{ value: 7 }] }), null);
  assert.equal(parseClaudeInitialize(null), null);
  assert.equal(parseClaudeInitialize([]), null);
});

test('S8: __proto__ / constructor keys pollute nothing and add no field; flags only === true; efforts allow-listed', () => {
  const inner = JSON.parse('{"models":[{"__proto__":{"isDefault":true,"fast":true},"constructor":{"prototype":{"x":1}},"value":"opus","supportsFastMode":"true","supportsThinkingOff":1,"supportedEffortLevels":["max","ultra","low","low","__proto__"],"displayName":"Opus"}],"account":{"__proto__":{"email":"x@y.z"}}}');
  const p = parseClaudeInitialize(inner)!;
  const m = p.models[0]!;
  assert.deepEqual(Object.keys(m).sort(), ['efforts', 'id', 'label']);
  assert.deepEqual(m.efforts, ['low', 'max']);
  assert.equal((m as any).isDefault, undefined);
  assert.equal(({} as any).isDefault, undefined, 'Object.prototype untouched');
  assert.equal(({} as any).x, undefined);
  assert.equal(p.signedIn, false, 'the polluted account has no own email');
  assert.deepEqual(p.identity, []);
});

test('Cursor parser: hostile lines (ids matched raw, narrow rule, no brackets — W4)', () => {
  const p = parseCursorList([
    'good-1 - Good \u202eone\u200b (current, default)',
    '--evil - Option shaped',
    'good-1 - duplicate',
    '/etc/passwd - path',
    'line\u2028break - a line separator inside the id: not a model line',
    'zw\u200bid - a zero-width character inside the id: refused, never repaired',
    'x'.repeat(70) + ' - too long',
    'no separator here',
    'good-2 -  (NO ZDR)',
    'good-3[1m] - brackets are Cursor parameter syntax',
    'good-4 - label with a \u2028 line separator inside',
  ]);
  assert.deepEqual(p.models.map((m) => m.id), ['good-1', 'good-2', 'good-4']);
  assert.equal(p.models[0]!.label, 'Good one');
  assert.equal(p.models[0]!.isDefault, true);
  assert.equal(p.models[1]!.noZdr, true);
  assert.equal(p.models[1]!.label, 'good-2', 'an empty label falls back to the id');
  assert.equal(p.models[2]!.label, 'label with a line separator inside');
  assert.equal(p.dropped, 6);
  assert.ok(p.models.every((m) => modelIdOk('cursor', m.id)));
});

for (const [mode, reason] of [
  ['garbage', CLAUDE_REASONS.noReply],
  ['wrong-id', CLAUDE_REASONS.noReply],
  ['nomodels', CLAUDE_REASONS.shape],
  ['error', CLAUDE_REASONS.refusedRequest],
] as const) {
  test(`fake Claude "${mode}" ⇒ unavailable "${reason}", nothing cached, nothing crashes`, async () => {
    h.scenario({ models: mode, lingerMs: 5000 });
    const { svc } = buildService(h);
    const v = await svc.refresh('claude');
    assert.equal(v.state, 'unavailable');
    assert.ok(v.reason!.startsWith(reason), v.reason);
    assert.throws(() => readFileSync(cacheFile('claude', 'default')));
  });
}

test('a hostile reply through the fake: only validated entries reach the cache file', async () => {
  h.scenario({
    models: 'inner',
    lingerMs: 5000,
    modelsInner: { models: [{ value: 'fine-1', displayName: 'Fine\u0000\u202e' }, { value: '-x', displayName: 'bad' }, { value: 'fine-1', displayName: 'dup' }], account: { tokenSource: 'none' }, commands: [{ name: 'DECOY_CMD' }] },
  });
  const { svc } = buildService(h);
  const v = await svc.refresh('claude');
  assert.equal(v.state, 'fresh');
  const stored = JSON.parse(readFileSync(cacheFile('claude', 'default'), 'utf8'));
  assert.deepEqual(stored.models, [{ id: 'fine-1', label: 'Fine' }]);
  assert.deepEqual(Object.keys(stored).sort(), ['account', 'cliVersion', 'fetchedAt', 'models', 'provider', 'signedIn', 'source', 'version']);
  assert.ok(!readFileSync(cacheFile('claude', 'default'), 'utf8').includes('DECOY'));
  assert.deepEqual(readdirSync(join(h.home, 'run', 'discovery')), []);
});

test('a raw __proto__ reply line through the fake pollutes nothing', async () => {
  h.scenario({ models: 'raw', lingerMs: 5000, modelsRaw: '{"type":"control_response","response":{"subtype":"success","request_id":"__REQ__","__proto__":{"polluted":true},"response":{"__proto__":{"models":[{"value":"evil"}]},"models":[{"value":"plain-1","__proto__":{"isDefault":true}}]}}}' });
  const { svc } = buildService(h);
  const v = await svc.refresh('claude', 'manual');
  assert.equal(({} as any).polluted, undefined);
  // the earlier test's service is a different instance: this one may be within no window
  assert.equal(v.state, 'fresh');
  assert.deepEqual(v.models, [{ id: 'plain-1', label: 'plain-1' }]);
});
