// Deep Research: argv/init predicate per profile, citation integrity from tool events, URL normalisation, limits, offline refusal, convert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, checkClaudeInit } from '../src/agents/claude.ts';
import { buildReport, normalizeUrl, validateReport } from '../src/asks/research.ts';
import { AskService } from '../src/asks/service.ts';
import { makeHarness, type Harness } from './helpers/harness.ts';

const base = { schema: undefined, maxTurns: 5, isolation: 'safe-mode' as const, name: 'n' };
test('argv: research is web tools ONLY with an explicit allow; plan/review/verify argv is unchanged', () => {
  const r = buildClaudeArgs({ ...base, profile: 'research' });
  assert.deepEqual(r.slice(r.indexOf('--tools'), r.indexOf('--tools') + 2), ['--tools', 'WebSearch,WebFetch']);
  assert.ok(r.join(' ').includes('--allowedTools WebSearch WebFetch'));
  for (const must of ['--safe-mode', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--disable-slash-commands', '--disallowedTools']) assert.ok(r.includes(must), must);
  const p = buildClaudeArgs(base);
  assert.deepEqual(p.slice(p.indexOf('--tools'), p.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob']);
  assert.ok(!p.includes('--allowedTools') && !p.join(' ').includes('Web'));
});

test('init predicate: exact tool set per profile, both ways', () => {
  const init = (tools: string[]) => ({ tools, mcp_servers: [], skills: [], slash_commands: [], permissionMode: 'dontAsk' });
  assert.equal(checkClaudeInit(init(['WebSearch', 'WebFetch', 'StructuredOutput']), { profile: 'research', expectStructuredOutput: true }).ok, true);
  for (const bad of [['WebSearch', 'WebFetch', 'Read'], ['WebSearch', 'WebFetch', 'Bash'], ['WebSearch'], ['WebSearch', 'WebFetch', 'Task'], ['WebSearch', 'WebFetch', 'mcp__x__y']]) assert.equal(checkClaudeInit(init(bad), { profile: 'research' }).ok, false, bad.join());
  assert.equal(checkClaudeInit(init(['Glob', 'Grep', 'Read', 'StructuredOutput'])).ok, true);
  assert.equal(checkClaudeInit(init(['Glob', 'Grep', 'Read', 'WebFetch'])).ok, false, 'web tools in a plan/review/verify session are a violation');
});

test('citation integrity: only a page really opened counts; listed-only is weaker; everything else is unverified; bad URLs dropped; the model cannot set the status', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM:443/a?b=2&utm_source=x&a=1#frag'), 'https://example.com/a?a=1&b=2');
  for (const bad of ['javascript:alert(1)', 'https://u:p@example.com/', 'ftp://x/', 'not a url', 5, 'https://x/' + 'a'.repeat(2100)]) assert.equal(normalizeUrl(bad as any), null);
  const raw = { summary: 's', recommendation: 'r', limitations: 'l', alternatives: [], steps: [], findings: [
    { claim: 'a', status: 'opened', verified: true, sources: [{ url: 'https://example.com/a?utm_x=1', title: 't', quote: 'q' }] },
    { claim: 'b', sources: [{ url: 'https://example.com/listed', title: 't' }] },
    { claim: 'c', sources: [{ url: 'https://example.com/forged', title: 't' }] },
    { claim: 'd', sources: [{ url: 'javascript:alert(1)', title: 't' }] } ] };
  const r = buildReport(raw, { read: ['https://example.com/a'], listed: ['https://example.com/listed'], queries: ['q'] });
  assert.deepEqual(r.findings.map((f) => f.status), ['opened', 'listed', 'unverified', 'unverified']);
  assert.equal(r.findings[3]!.sources.length, 0);
  assert.deepEqual(r.fetched, ['https://example.com/a']);
  assert.equal(validateReport({ findings: [{ claim: 'x', status: 'opened', sources: [{ url: 'https://u:p@e.com', state: 'opened' }] }] })!.findings[0]!.sources.length, 0);
  assert.equal(validateReport(null), null);
});

const svc = (h: Harness, over: any = {}) => new AskService({ getConfig: () => h.cfg, agents: h.agents, routeStates: () => h.engine.routeStates(), freshHealth: () => h.engine.freshHealth(), cards: { create: (i) => { const p = h.engine.ensureProjectForRepo(i.repo); const it = h.board.createItem({ projectId: p.id, title: i.title, description: i.description, kind: 'work', lane: 'todo', idemKey: i.idemKey }, i.actor); return { key: it.key }; } }, ...over });

test('Deep Research end to end: report with computed citation status, tool events recorded, convert makes a tainted card (approval forced)', async () => {
  const h = await makeHarness({ config: (c) => { c.pipeline.researchPerDay = 2; } });
  try {
    const a = svc(h);
    const rec = await a.startResearch({ question: 'Compare SQLite and Postgres for a local app', repo: 'demo' });
    await a.idle();
    const d = a.get(rec.id)!;
    assert.equal(d.status, 'done');
    assert.deepEqual(d.report!.findings.map((f) => f.status), ['opened', 'listed', 'unverified', 'unverified']);
    assert.deepEqual(d.report!.fetched, ['https://example.com/a']);
    assert.deepEqual(d.report!.searched, ['fake query']);
    assert.equal(d.basis, 'web research (no repository access)');
    const call = h.calls().find((c) => c.who === 'claude' && c.stage === 'research')!;
    assert.ok(call.argv.join(' ').includes('WebSearch,WebFetch'));
    const { key } = a.convert(rec.id);
    assert.equal(h.board.item(key)!.createdBy, 'research');
    assert.match(h.board.item(key)!.description, /Research findings \(written by a model from web sources — untrusted/);
    await h.settle();
    assert.equal(h.run(key).untrusted, true);
    assert.equal(h.run(key).status, 'awaiting_approval');
    // daily limit
    await a.startResearch({ question: 'again' }); await a.idle();
    await assert.rejects(a.startResearch({ question: 'third' }), (e: any) => e.status === 429);
  } finally { await h.cleanup(); }
});

test('Deep Research refuses clearly when offline, and a forged tool in the session stops it', async () => {
  const h = await makeHarness();
  try {
    await assert.rejects(svc(h, { networkState: async () => 'offline' }).startResearch({ question: 'q' }), (e: any) => e.code === 'offline' && /no network/.test(e.message));
    h.scenario({ claude: { '*': { research: [{ extraTool: 'Bash' }] } } });
    const a = svc(h);
    const rec = await a.startResearch({ question: 'q' });
    await a.idle();
    assert.equal(a.get(rec.id)!.status, 'failed');
    assert.match(a.get(rec.id)!.error!, /unexpected tools present: Bash|Isolation/);
  } finally { await h.cleanup(); }
});
