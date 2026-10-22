// AC9 (S7, R2-4) + N7: the recorded fixtures and the live-evidence files hold no identity, the Claude fixtures use only allow-listed
// keys, and no model-id literal from the fixtures appears in src/ or ui/ (nothing is hard-coded: F7a "ask each tool, never assume").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, REAL } from './helpers.ts';

const ROOT = join(FIXTURES, '..');
const EVIDENCE = join(ROOT, '.techteam', 'runs', 'evidence');
const MODEL_FIXTURES = [
  join(REAL, 'claude-initialize-2.1.304.json'),
  join(REAL, 'claude-initialize-2.1.304-signed-out.json'),
  join(REAL, 'claude-initialize-2.1.304-conductor-env.json'),
  join(REAL, 'cursor-list-models-2026.10.19.txt'),
  join(REAL, 'cursor-list-models-signed-out.txt'),
  join(FIXTURES, 'codex-model-list.json'),
];
const evidenceFiles = () => (existsSync(EVIDENCE) ? readdirSync(EVIDENCE).filter((n) => n.startsWith('m8-1-')).map((n) => join(EVIDENCE, n)) : []);
const EMAIL = /[^\s@"'`]{1,64}@[^\s@"'`]{1,255}\.[A-Za-z]{2,}/;
const FORBIDDEN_KEYS = ['userID', 'machineID', 'oauthAccount', 'commands', 'agents'];

test('S7: no fixture or evidence file holds an email shape or an identity/inventory key', () => {
  const files = [...MODEL_FIXTURES, ...evidenceFiles()];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    assert.ok(!EMAIL.test(t), `${f} contains an email shape`);
    for (const k of FORBIDDEN_KEYS) assert.ok(!new RegExp(`["']?\\b${k}\\b["']?\\s*[:=]`).test(t) && !t.includes(`"${k}"`), `${f} contains the key ${k}`);
  }
});

test('S7: the Claude fixtures use only allow-listed keys, and the account holds placeholders only', () => {
  const MODEL_KEYS = new Set(['value', 'resolvedModel', 'displayName', 'description', 'supportsEffort', 'supportedEffortLevels', 'supportsAdaptiveThinking', 'supportsFastMode', 'supportsAutoMode', 'supportsThinkingOff']);
  for (const f of MODEL_FIXTURES.slice(0, 3)) {
    const o = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(Object.keys(o).sort(), ['_note', 'response', 'type']);
    assert.deepEqual(Object.keys(o.response).sort(), ['request_id', 'response', 'subtype']);
    assert.deepEqual(Object.keys(o.response.response).sort(), ['account', 'claude_code_version', 'models']);
    for (const m of o.response.response.models) for (const k of Object.keys(m)) assert.ok(MODEL_KEYS.has(k), `${f}: model key ${k}`);
    const a = o.response.response.account;
    for (const k of Object.keys(a)) assert.ok(['email', 'organization', 'subscriptionType', 'apiProvider', 'tokenSource'].includes(k), `${f}: account key ${k}`);
    if ('email' in a) assert.equal(a.email, 'PLACEHOLDER_EMAIL');
    if ('organization' in a) assert.equal(a.organization, 'PLACEHOLDER_ORGANIZATION');
  }
});

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js|html|css|json)$/.test(n)) out.push(p);
  }
  return out;
}

test('N7: no model-id literal from the fixtures (nor a model-family-shaped literal) appears in src/ or ui/', () => {
  const ids = new Set<string>();
  for (const f of MODEL_FIXTURES.slice(0, 3)) {
    for (const m of JSON.parse(readFileSync(f, 'utf8')).response.response.models) {
      ids.add(m.value);
      ids.add(m.resolvedModel);
    }
  }
  for (const l of readFileSync(MODEL_FIXTURES[3]!, 'utf8').split('\n')) {
    const m = /^(\S+) - /.exec(l);
    if (m) ids.add(m[1]!);
  }
  // generic words (auto, default, opus, sonnet, …) are not catalogue entries; only specific, versioned ids count
  const specific = [...ids].filter((id) => /\d/.test(id) && id.length >= 6);
  assert.ok(specific.length > 250);
  const FAMILY = /(["'`])(claude-(opus|sonnet|haiku|fable)-\d[^"'`]*|gpt-\d[^"'`]*|composer-\d[^"'`]*|gemini-[^"'`]+)\1/;
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'ui'))];
  assert.ok(files.length > 20);
  const hits: string[] = [];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    const fam = FAMILY.exec(t);
    if (fam) hits.push(`${f}: ${fam[0]}`);
    for (const id of specific) if (t.includes(`'${id}'`) || t.includes(`"${id}"`) || t.includes(`\`${id}\``)) hits.push(`${f}: ${id}`);
  }
  assert.deepEqual(hits, []);
});
