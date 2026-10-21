// AC4 (S8, S9, S3): the sanitiser — every character class, truncation by code point, ids, efforts, versions, the identity scrub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_MODEL_RE, EFFORT_TOKENS, MODEL_ID_BASE_RE, MODEL_ID_RE, cleanEfforts, cleanId, cleanPlan, cleanText, cleanVersion, modelIdOk, own, scrubIdentity } from '../../src/models/sanitize.ts';
import { CODEX_MODEL_RE } from '../../src/config.ts';

test('id rules per provider (W1): Codex keeps the narrow base rule via config.ts; Claude alone has the bracket suffix', () => {
  assert.equal(CODEX_MODEL_RE, MODEL_ID_BASE_RE);
  assert.equal(MODEL_ID_RE, MODEL_ID_BASE_RE);
  assert.equal(MODEL_ID_BASE_RE.source, '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$');
  assert.equal(CLAUDE_MODEL_RE.source, '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(?:\\[[a-z0-9]{1,8}\\])?$');
});

// W5: one accept/reject table per provider
const P = ['claude', 'cursor', 'codex'] as const;
const CLAUDE_ONLY = ['claude-fable-5-1[1m]', 'opus[1m]', 'x[12345678]', 'a'.repeat(64) + '[abcdefgh]' /* 74 chars */];
const REJECT_ALL = [
  'x[1m][2m]', 'x[1M]', 'x[effort=high]', 'x[1m,fast]', 'x[ 1m]', 'x[]', 'x[123456789]', 'x[1m]y', '[1m]', '-x[1m]', 'x[1m]\n', 'x[1m] ',
  'a'.repeat(65) + '[abcdefgh]' /* 75 chars */, 'a'.repeat(75), 'x[', 'x]', 'x[1m', '--model', '/etc/passwd', 'a b', '', '../x', 'a;b', 'a$(b)',
  'ok\u200b-id', 'x\u202e', 'x\u0000',
];
const ALL_OK = ['claude-opus-5-5', 'gpt-5.3-codex-high-fast', 'auto', 'a'.repeat(64), 'org/model:tag_1.2'];

test('W5 table — accepted for Claude only: the [1m]-style suffix (and a 74-character value)', () => {
  assert.equal(CLAUDE_ONLY[3]!.length, 74);
  for (const id of CLAUDE_ONLY) {
    assert.equal(modelIdOk('claude', id), true, `claude ${id}`);
    assert.equal(cleanId(id, 'claude'), id);
    for (const p of ['cursor', 'codex'] as const) {
      assert.equal(modelIdOk(p, id), false, `${p} ${id}`);
      assert.equal(cleanId(id, p), null);
    }
    assert.equal(CODEX_MODEL_RE.test(id), false);
  }
});

test('W5 table — rejected for all three providers (raw check: no trimming, no repair)', () => {
  assert.equal(REJECT_ALL[12]!.length, 75);
  for (const id of REJECT_ALL) for (const p of P) {
    assert.equal(modelIdOk(p, id), false, `${p} ${JSON.stringify(id)}`);
    assert.equal(cleanId(id, p), null, `${p} ${JSON.stringify(id)}`);
  }
  for (const bad of [42, null, {}, ['x']]) for (const p of P) assert.equal(cleanId(bad, p), null);
});

test('W5 table — plain ids pass for all three', () => {
  for (const id of ALL_OK) for (const p of P) assert.equal(modelIdOk(p, id), true, `${p} ${id}`);
});

test('cleanText strips Cc, Cf (zero-width, bidi, soft hyphen, tag block), Zl, Zp, Co and lone surrogates', () => {
  const cases: [string, string][] = [
    ['a\u0000b\u0007c\u001bd\u007fe\u0085f', 'abcdef'], // C0 + DEL + C1
    ['zw\u200b\u200c\u200d\u2060\ufeffx', 'zwx'], // zero-width
    ['bi\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069di', 'bidi'], // bidi controls
    ['soft\u00adhy\u2061\u2064\ufff9\ufffbx', 'softhyx'], // other Cf
    ['tag\u{E0041}\u{E0042}\u{E007F}s', 'tags'], // tag block (ASCII smuggling)
    ['line\u2028para\u2029end', 'lineparaend'], // Zl / Zp
    ['pua\ue000\u{F0000}x', 'puax'], // private use
    ['lone\ud800x\udc00y', 'lonexy'], // lone surrogates
    ['  many   \t spaces\n\nhere ', 'many spaces here'],
    ['é', 'é'], // NFC
  ];
  for (const [inp, want] of cases) assert.equal(cleanText(inp, 200), want, JSON.stringify(inp));
  assert.equal(cleanText(42, 10), '');
  assert.equal(cleanText(null, 10), '');
});

test('cleanText truncates by code point and never leaves a lone surrogate', () => {
  const s = '😀'.repeat(10);
  const t = cleanText(s, 3);
  assert.equal(t, '😀😀😀');
  assert.equal(Array.from(t).length, 3);
  assert.ok(!/[\ud800-\udfff](?![\udc00-\udfff])/.test(t.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')));
});

test('efforts: only the allow-list, de-duplicated, canonical order, at most 7; Codex option objects accepted', () => {
  assert.deepEqual([...EFFORT_TOKENS], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(cleanEfforts(['max', 'low', 'low', 'ultra', 'HIGH', 7, null, 'medium']), ['low', 'medium', 'max']);
  assert.deepEqual(cleanEfforts([{ reasoningEffort: 'high' }, { reasoningEffort: 'evil' }, 'none']), ['none', 'high']);
  assert.ok(cleanEfforts(Array(500).fill(EFFORT_TOKENS).flat()).length <= 7);
  assert.deepEqual(cleanEfforts('low'), []);
});

test('versions and plans are shape-checked', () => {
  assert.equal(cleanVersion('2.1.304 (Claude Code)'), '2.1.304');
  assert.equal(cleanVersion('2026.10.19-6bbf2c4'), '2026.10.19-6bbf2c4');
  assert.equal(cleanVersion('not a version'), null);
  assert.equal(cleanPlan('Claude Team'), 'Claude Team');
  assert.equal(cleanPlan('max'), 'max');
  assert.equal(cleanPlan('<script>'), undefined);
  assert.equal(cleanPlan('x'.repeat(41)), 'x'.repeat(40)); // truncated to 40 first, then plain
});

test('own(): never walks the prototype chain', () => {
  const o = JSON.parse('{"__proto__":{"isDefault":true},"a":1}');
  assert.equal(own(o, 'a'), 1);
  assert.equal(own(o, 'isDefault'), undefined);
  assert.equal(own({}, 'constructor'), undefined);
  assert.equal(own([1], '0'), undefined);
});

test('scrubIdentity: exact identity strings, any email shape, absolute paths; ≤ 200; cleaned', () => {
  const t = scrubIdentity('Logged in as someone.else@corp.example as Acme at /Users/me/.claude/x.json and ~/y/z\u202e', ['Acme']);
  assert.ok(!t.includes('@'));
  assert.ok(!t.includes('Acme'));
  assert.ok(!t.includes('/Users'));
  assert.ok(!t.includes('~/y'));
  assert.ok(!t.includes('\u202e'));
  assert.ok(scrubIdentity('x'.repeat(5000)).length <= 200);
  assert.equal(scrubIdentity(undefined), '');
});
