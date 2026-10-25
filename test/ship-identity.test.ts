// Identity (R4-6, A7): pushes carry the genuine developer's name, never an agent's.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alreadyPublished, checkPerson, isAgentIdentity, personIdentity, validDeveloperIdentity } from '../src/git/push-ticket.ts';
import { cleanMessage, messageHasAgentTrailer, unsafeRemoteUrl, badTargetName } from '../src/git/ship.ts';
import { isolateGitHome, makeRepo, sg } from './helpers/tmp-repo.ts';

isolateGitHome();

describe('isAgentIdentity', () => {
  const agents: Array<[string, string]> = [
    ['Claude', 'a@example.com'], ['CLAUDE CODE', 'a@example.com'], ['Ada', 'ada@anthropic.com'], ['Cursor Agent', 'x@example.com'],
    ['Codex', 'x@example.com'], ['GitHub Copilot', 'x@example.com'], ['Gemini', 'x@example.com'], ['Devin AI', 'x@example.com'],
    ['OpenAI', 'x@example.com'], ['grok', 'x@example.com'], ['dependabot[bot]', 'x@example.com'], ['github-actions', 'x@example.com'],
    ['Conductor', 'x@example.com'], ['TechTeamConductor', 'support@bargainn.io'], ['Ada', 'ada@users.noreply.github.com'], ['Ada', 'ada@localhost'],
    ['Ada', 'Claude@Example.com'], ['', 'ada@example.com'], ['Ada', ''], ['  ', ' '],
  ];
  for (const [n, e] of agents) it(`agent: ${JSON.stringify(n)} <${e}>`, () => assert.equal(isAgentIdentity(n, e), true));
  for (const [n, e] of [['Ada Lovelace', 'ada@example.com'], ['Grace Hopper', 'grace@navy.mil'], ['Mohit Kumar', 'mohit.kumar@techtorch.io']] as const) {
    it(`person: ${n}`, () => assert.equal(isAgentIdentity(n, e), false));
  }
});

describe('person-only developerIdentity override', () => {
  const dev = { name: 'Claude Reyes', email: 'claude.reyes@example.com' };
  it('clears exactly that pair, case-insensitively, and nothing else', () => {
    assert.equal(isAgentIdentity('Claude Reyes', 'claude.reyes@example.com', dev), false);
    assert.equal(isAgentIdentity('claude reyes', 'CLAUDE.REYES@example.com', dev), false);
    assert.equal(isAgentIdentity('Claude Reyes', 'other@example.com', dev), true);
    assert.equal(isAgentIdentity('Claude Code', 'claude.reyes@example.com', dev), true);
    assert.equal(isAgentIdentity('Cursor', 'cursor@example.com', dev), true);
  });
  it('is refused when it is itself a bot, noreply, localhost, empty or malformed (a person-set TechTeamConductor account is accepted)', () => {
    assert.equal(validDeveloperIdentity({ name: 'TechTeamConductor', email: 'support@bargainn.io' }), true);
    assert.equal(isAgentIdentity('TechTeamConductor', 'support@bargainn.io', { name: 'TechTeamConductor', email: 'support@bargainn.io' }), false);
    assert.equal(isAgentIdentity('TechTeamConductor', 'support@bargainn.io'), true, 'without the override the name is still treated as an agent');
    for (const bad of [{ name: 'x[bot]', email: 'a@b.co' }, { name: 'Ada', email: 'a@localhost' }, { name: 'Ada', email: 'x@users.noreply.github.com' }, { name: '', email: 'a@b.co' }, { name: 'Ada', email: 'nope' }, { name: 'A\nB', email: 'a@b.co' }, { name: 'github-actions', email: 'a@b.co' }]) {
      assert.equal(validDeveloperIdentity(bad), false, JSON.stringify(bad));
      assert.equal(isAgentIdentity(bad.name || 'x', bad.email || 'y', bad), isAgentIdentity(bad.name || 'x', bad.email || 'y'), 'an invalid override clears nothing');
    }
    assert.equal(validDeveloperIdentity(null), false);
    assert.equal(validDeveloperIdentity(dev), true);
  });
});

describe('checkPerson / personIdentity', () => {
  it('names the instruction when there is no identity or an agent one', () => {
    for (const [n, e] of [['', ''], ['Claude', 'c@example.com']] as const) {
      const r = checkPerson(n, e);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.detail, /set git user\.name\/user\.email to your own name/i);
    }
    assert.equal(checkPerson('Ada', 'ada@example.com').ok, true);
  });
  it('reads the repo config and never writes it', async () => {
    const r = makeRepo();
    assert.equal((await personIdentity(r.dir)).ok, false);
    sg(r.dir, ['config', 'user.name', 'Ada Lovelace']);
    sg(r.dir, ['config', 'user.email', 'ada@example.com']);
    const ok = await personIdentity(r.dir);
    assert.equal(ok.ok, true);
    sg(r.dir, ['config', 'user.name', 'Claude Reyes']);
    sg(r.dir, ['config', 'user.email', 'claude.reyes@example.com']);
    assert.equal((await personIdentity(r.dir)).ok, false);
    assert.equal((await personIdentity(r.dir, { name: 'Claude Reyes', email: 'claude.reyes@example.com' })).ok, true);
  });
});

describe('message cleanup', () => {
  it('strips Built by Conductor, agent Co-Authored-By and Generated-with lines and keeps the rest', () => {
    const msg = 'KEE-3: add thing\n\nWhy it matters.\n\nBuilt by Conductor (KEE-3)\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>\nco-authored-by: Cursor Agent <cursoragent@cursor.com>\nCo-Authored-By: Ada Lovelace <ada@example.com>\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nSigned-off-by: Codex <codex@openai.com>\n';
    const out = cleanMessage(msg);
    assert.equal(out, 'KEE-3: add thing\n\nWhy it matters.\n\nCo-Authored-By: Ada Lovelace <ada@example.com>\n');
    assert.equal(messageHasAgentTrailer(out), false);
    assert.equal(messageHasAgentTrailer(msg), true);
  });
  it('is idempotent and never returns an empty message', () => {
    const once = cleanMessage('x\n\nBuilt by Conductor (KEE-1)\n');
    assert.equal(cleanMessage(once), once);
    assert.equal(cleanMessage('Built by Conductor (KEE-1)\n'), 'Update\n');
  });
});

describe('url and target predicates', () => {
  it('flags credentials, code-running schemes and odd urls; allows paths, ssh and scp-style', () => {
    for (const u of ['https://user:pw@h/x.git', 'https://tok@h/x.git', 'ssh://git:pw@h/x', 'ext::sh -c id', 'fd::3', 'file:///x', 'FILE:///x', 'http://h/x.git?token=abc', '-oProxyCommand=x', '', 'a b', 'git::https://h/x']) {
      assert.equal(unsafeRemoteUrl(u), true, u);
    }
    for (const u of ['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'https://github.com/o/r.git', '/tmp/some/bare.git', '../rel/bare.git']) assert.equal(unsafeRemoteUrl(u), false, u);
  });
  it('accepts conductor/ branches only', () => {
    assert.equal(badTargetName('conductor/new-development'), null);
    assert.equal(badTargetName('conductor/team-a/feature_1.2'), null);
    for (const b of ['main', 'Conductor/x', 'conductor/main', 'conductor/a/Master', 'conductor/release-2', 'conductor/x.lock', 'conductor/a@{1}']) assert.notEqual(badTargetName(b), null, b);
  });
});

describe('alreadyPublished uses the remote it is given (no hardcoded origin)', () => {
  it('sees a branch on a differently named remote, and not on origin', async () => {
    const r = makeRepo({ withRemote: true });
    sg(r.dir, ['remote', 'rename', 'origin', 'upstream']);
    const head = r.head();
    assert.equal(await alreadyPublished(r.dir, 'upstream', 'main', head), true);
    assert.equal(await alreadyPublished(r.dir, 'origin', 'main', head), false);
  });
});
