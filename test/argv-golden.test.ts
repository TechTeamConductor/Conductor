// AC10 (M8-1 N8): golden FULL argv for the three stage builders with the default config (no model), pinned literally on 2026-10-21 before
// M8-2 adds model/effort flags. Any change to a stage command line must update this file on purpose. The existing tests check pieces only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs } from '../src/agents/claude.ts';
import { buildCursorArgs } from '../src/agents/cursor.ts';
import { buildCodexArgs } from '../src/agents/providers/codex.ts';
import { defaultConfig } from '../src/config.ts';

/** What the default config gives each builder for the model (M8-2: no `toolModels` entry ⇒ no model). */
const c0: { model?: string } = {};
const DENIED = ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/id_rsa*)', 'Read(**/id_ed25519*)', 'Read(**/.npmrc)', 'Read(**/.aws/**)', 'Read(**/.ssh/**)'];

test('the default config carries no model for any tool (byte-identical argv when unset)', () => {
  const c = defaultConfig();
  // M8-2 (S4e): `agents.<tool>.model` no longer exists; "Default model for each tool" (`toolModels`) is empty by default
  assert.equal(Object.hasOwn(c.agents.claude, 'model') || Object.hasOwn(c.agents.cursor, 'model') || Object.hasOwn(c.agents.codex, 'model'), false);
  assert.deepEqual(c.toolModels, {});
});

test('Claude read-only stage (safe-mode, default config, no schema)', () => {
  const cfg = defaultConfig();
  assert.deepEqual(buildClaudeArgs({ maxTurns: cfg.agents.claude.maxTurns.plan, isolation: cfg.agents.claude.isolation, name: 'conductor ENG-1 plan', model: c0.model }), [
    '-p', '--output-format', 'stream-json', '--verbose', '--safe-mode',
    '--tools', 'Read,Grep,Glob',
    '--disallowedTools', ...DENIED,
    '--disable-slash-commands', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--max-turns', '40', '-n', 'conductor ENG-1 plan',
  ]);
});

test('Claude with a schema appends exactly --json-schema <json> at the end', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } } as any;
  const a = buildClaudeArgs({ maxTurns: 25, isolation: 'safe-mode', name: 'n', schema });
  assert.deepEqual(a.slice(-2), ['--json-schema', JSON.stringify(schema)]);
  assert.deepEqual(a.slice(0, -2), buildClaudeArgs({ maxTurns: 25, isolation: 'safe-mode', name: 'n' }));
});

test('Claude research profile (setting-sources isolation)', () => {
  assert.deepEqual(buildClaudeArgs({ maxTurns: 25, isolation: 'setting-sources', name: 'n', profile: 'research' }), [
    '-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local',
    '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch', 'WebFetch',
    '--disallowedTools', ...DENIED,
    '--disable-slash-commands', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--max-turns', '25', '-n', 'n',
  ]);
});

test('Cursor build and read-only modes', () => {
  assert.deepEqual(buildCursorArgs({ mode: 'build', cwd: '/w', model: c0.model }), ['-p', '--force', '--trust', '--output-format', 'stream-json', '--workspace', '/w']);
  assert.deepEqual(buildCursorArgs({ mode: 'plan', cwd: '/w' }), ['-p', '--mode', 'plan', '--trust', '--output-format', 'stream-json', '--workspace', '/w']);
  assert.deepEqual(buildCursorArgs({ mode: 'ask', cwd: '/w' }), ['-p', '--mode', 'ask', '--trust', '--output-format', 'stream-json', '--workspace', '/w']);
});

test('Codex exec', () => {
  assert.deepEqual(buildCodexArgs({ outFile: '/o/last.txt', model: c0.model }), [
    'exec', '--json', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.exclude=["CODEX_*","*KEY*","*TOKEN*","*SECRET*","*PASSWORD*"]',
    '-o', '/o/last.txt', '-',
  ]);
});
