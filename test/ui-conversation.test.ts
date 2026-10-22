// Home composer: follow-up eligibility and the plain-text serializers behind the copy buttons (pure helpers in ui/modes.js, loaded the same way
// as test/ui-modes.test.ts), plus static checks on how ui/app.js wires them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Turn { mode: string; phase: string; askId: string | null; repo: string | null; scope?: string }
interface Modes {
  followTarget(turns: Turn[], repo: string | null, newTopic: boolean, scope?: string): string | null;
  webAnswerToText(res: unknown, sources: unknown): string;
  codeReportToText(rp: unknown): string;
  answerToText(res: unknown): string;
  reportToText(rp: unknown): string;
}
const root = join(import.meta.dirname, '..', 'ui');
const sandbox: { ConductorModes?: Modes; URL: typeof URL } = { URL };
vm.runInNewContext(readFileSync(join(root, 'modes.js'), 'utf8'), sandbox, { filename: 'ui/modes.js' });
const M = sandbox.ConductorModes!;
const ID = 'ask-0123456789abcdef';
const turn = (over: Partial<Turn> = {}): Turn => ({ mode: 'ask', phase: 'done', askId: ID, repo: 'keel-ops', ...over });

test('followTarget: only the last turn, only a finished Ask, only the same repository, never after "New topic"', () => {
  assert.equal(M.followTarget([turn()], 'keel-ops', false), ID);
  assert.equal(M.followTarget([turn({ askId: 'ask-fedcba9876543210' }), turn()], 'keel-ops', false), ID, 'the LAST turn');
  assert.equal(M.followTarget([], 'keel-ops', false), null);
  assert.equal(M.followTarget([turn()], 'keel-ops', true), null, 'New topic');
  assert.equal(M.followTarget([turn({ mode: 'work' })], 'keel-ops', false), null, 'a Build turn');
  assert.equal(M.followTarget([turn({ mode: 'research' })], 'keel-ops', false), null, 'a Research turn');
  for (const phase of ['running', 'sending', 'failed', 'canceled', 'error']) assert.equal(M.followTarget([turn({ phase })], 'keel-ops', false), null, phase);
  assert.equal(M.followTarget([turn()], 'other-repo', false), null, 'another repository');
  assert.equal(M.followTarget([turn({ repo: null })], null, false), ID, 'both without a repository');
  assert.equal(M.followTarget([turn({ repo: null })], 'keel-ops', false), null);
  for (const askId of [null, '', 'x', '../../etc', 'ask-ZZ', 'ASK-0123456789abcdef']) assert.equal(M.followTarget([turn({ askId })], 'keel-ops', false), null, String(askId));
  assert.equal(M.followTarget(null as unknown as Turn[], 'keel-ops', false), null);
  assert.equal(M.followTarget([turn({ mode: 'work' }), turn({ mode: 'ask', askId: ID })], 'keel-ops', false), ID, 'an earlier Build turn does not block a later finished Ask');
  assert.equal(M.followTarget([turn(), turn({ mode: 'work' })], 'keel-ops', false), null, 'a Build turn in between ends the conversation');
});

test('answerToText: the answer, a suggested change and the sources, as plain text', () => {
  assert.equal(M.answerToText({ kind: 'answer', answer: '  It lives in src/a.ts.  ', citations: [] }), 'It lives in src/a.ts.');
  const t = M.answerToText({ kind: 'answer', answer: 'See below.', citations: [{ file: 'src/a.ts', lines: '10-20' }, { file: 'README.md', lines: '' }, { file: '', lines: '1' }] });
  assert.equal(t, 'See below.\n\nSources: src/a.ts:10-20, README.md');
  const c = M.answerToText({ kind: 'change', answer: 'Needs a change.', change: { title: 'Add a flag', description: 'Add --x.', files: ['src/cli.ts', 'docs/GUIDE.md'], complexity: 'S' }, citations: [] });
  assert.match(c, /^Needs a change\.\n\nSuggested change: Add a flag \(size S\)\nAdd --x\.\nFiles: src\/cli\.ts, docs\/GUIDE\.md$/);
  for (const bad of [null, undefined, 5, 'x', [], {}]) assert.equal(M.answerToText(bad), '');
  assert.equal(M.answerToText({ kind: 'answer', answer: 'A', citations: 'nope' }), 'A');
});

const REPORT = {
  summary: 'Use queue X.',
  findings: [
    { claim: 'X retries natively', status: 'opened', sources: [{ title: 'X docs', url: 'https://x.example/docs', state: 'opened', quote: 'q' }, { title: '', url: 'https://y.example', state: 'listed' }] },
    { claim: 'X is fast', status: 'unverified', sources: [] },
  ],
  alternatives: [{ name: 'Y', pros: ['cheap'], cons: ['slow', 'new'] }, { name: 'Z', pros: [], cons: [] }],
  recommendation: 'Pick X.',
  steps: ['Prototype', 'Measure'],
  limitations: 'Only public sources.',
};
test('followTarget: a turn continues only in its own scope (no scope counts as code)', () => {
  assert.equal(M.followTarget([turn()], 'keel-ops', false, 'code'), ID);
  assert.equal(M.followTarget([turn({ scope: 'code' })], 'keel-ops', false), ID, 'scope omitted = code');
  assert.equal(M.followTarget([turn()], null, false, 'online'), null, 'a code turn does not continue online');
  assert.equal(M.followTarget([turn({ scope: 'online', repo: null })], null, false, 'online'), ID);
  assert.equal(M.followTarget([turn({ scope: 'online', repo: null })], 'keel-ops', false, 'code'), null, 'an online turn does not continue in code');
  assert.equal(M.followTarget([turn({ scope: 'online', repo: null })], null, false), null);
  assert.equal(M.followTarget([turn({ scope: 'online', repo: null, mode: 'research' })], null, false, 'online'), null, 'research never continues');
  assert.equal(M.followTarget([turn({ scope: 'online', repo: null })], null, true, 'online'), null, 'New topic');
});

test('webAnswerToText: the answer, then every source with how it was reached', () => {
  assert.equal(M.webAnswerToText({ answer: ' Use X. ' }, [
    { url: 'https://x.example/d', title: 'X docs', state: 'opened' },
    { url: 'https://y.example', title: '', state: 'listed' },
    { url: 'https://z.example', title: 'Z', state: 'weird' },
  ]), 'Use X.\n\nSources:\n- X docs (https://x.example/d) [opened]\n- https://y.example [listed, not opened]\n- Z (https://z.example) [unverified]');
  assert.equal(M.webAnswerToText({ answer: 'A' }, []), 'A');
  assert.equal(M.webAnswerToText(null, null), '');
  assert.doesNotThrow(() => M.webAnswerToText({ answer: 5 }, [null, 3, {}, { url: 7, title: [] }]));
});

test('codeReportToText: reading order with per-finding and per-evidence verdicts', () => {
  const rp = {
    summary: 'Retries are fixed.',
    findings: [
      { claim: 'Retries use a fixed delay', status: 'verified', evidence: [{ file: 'src/q.ts', lines: '10-12', quote: 'delay = 500', state: 'verified' }] },
      { claim: 'No jitter', status: 'partial', evidence: [{ file: 'src/j.ts', lines: '', quote: '', state: 'unverified' }] },
      { claim: 'Guess', status: 'unverified', evidence: [] },
    ],
    risks: ['Thundering herd'], recommendation: 'Add jitter.', steps: ['Patch', 'Measure'], limitations: 'Read-only.',
  };
  assert.equal(M.codeReportToText(rp), [
    'Summary\nRetries are fixed.',
    'Findings\n1. [verified] Retries use a fixed delay\n   - src/q.ts:10-12 [verified] "delay = 500"\n2. [partly verified] No jitter\n   - src/j.ts [unverified]\n3. [unverified] Guess',
    'Risks\n- Thundering herd',
    'Recommendation\nAdd jitter.',
    'Suggested next steps\n1. Patch\n2. Measure',
    'Limits of this report\nRead-only.',
  ].join('\n\n'));
  assert.match(M.codeReportToText({ summary: 's' }), /Limits of this report\nNone stated\.$/);
  for (const bad of [null, undefined, 5, 'x']) assert.equal(M.codeReportToText(bad), '');
  assert.doesNotThrow(() => M.codeReportToText({ findings: [null, { evidence: [null, {}] }], risks: [null, 3], steps: 'x' }));
});

test('reportToText: the report in reading order, with every source marked opened / listed / unverified', () => {
  assert.equal(M.reportToText(REPORT), [
    'Summary\nUse queue X.',
    'Findings\n1. [opened] X retries natively\n   - X docs (https://x.example/docs) [opened]\n   - https://y.example [listed, not opened]\n2. [unverified] X is fast',
    'Alternatives\n- Y\n  For: cheap\n  Against: slow; new\n- Z',
    'Recommendation\nPick X.',
    'Suggested next steps\n1. Prototype\n2. Measure',
    'Limits of this report\nOnly public sources.',
  ].join('\n\n'));
  assert.match(M.reportToText({ summary: 's', findings: [], alternatives: [], recommendation: '', steps: [] }), /Limits of this report\nNone stated\.$/);
  for (const bad of [null, undefined, 5, 'x']) assert.equal(M.reportToText(bad), '');
  assert.doesNotThrow(() => M.reportToText({ summary: 's', findings: [null, { claim: 5, sources: [null, {}] }], alternatives: [null], steps: [null, 3] }));
});

test('ui/app.js wiring: copy buttons on answers, reports and the report dialog; the follow id comes from followTarget BEFORE the new turn is pushed and is only sent for Ask', () => {
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  assert.equal((app.match(/copyAnswerBtn\(/g) ?? []).length, 6, 'one definition + answer + home report + report dialog + web answer + code report');
  assert.match(app, /M\.answerToText\(res\)/);
  assert.equal((app.match(/M\.reportToText\(r\.report\)/g) ?? []).length, 2);
  const submit = app.slice(app.indexOf('async function homeSubmit()'), app.indexOf('/** A server refusal as text'));
  const follow = submit.indexOf('M.followTarget(hm.turns');
  assert.ok(follow > 0 && follow < submit.indexOf('pushTurn(t)'), 'followTarget is evaluated before pushTurn');
  assert.match(submit, /if \(follow && mode === 'ask'\) body\.follow = follow;/);
  assert.doesNotMatch(submit, /history/i, 'the client never sends history text, only the id to follow');
  assert.match(app, /hm\.newTopic = false;/);
});

test('ui/app.js wiring: scope toggle, Build absent online, request body per route, follow never sent for research', () => {
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  assert.match(app, /label: 'Where to look'/);
  assert.match(app, /storeSet\('home:scope'/);
  assert.match(app, /storeGet\('home:scope'\)/);
  assert.match(app, /if \(!M\.modesFor\(next\)\.includes\(hm\.mode\)\) hm\.mode = 'auto';/, 'switching to online while on Build falls back to Auto');
  assert.match(app, /M\.detectMode\(hm\.text, scope\)/);
  const online = app.slice(app.indexOf('const MODE_PILLS = {'), app.indexOf('const SCOPE_PILLS'));
  const onlinePills = online.slice(online.indexOf('online: ['));
  assert.doesNotMatch(onlinePills, /id: 'work'|Build/, 'no Build pill online');
  assert.doesNotMatch(app.slice(app.indexOf('const SUGGEST_ONLINE'), app.indexOf('const PLACEHOLDER_CODE_RESEARCH')), /work/, 'no Build examples online');
  assert.match(app, /HM\.cards\.replaceChildren\(\.\.\.shown\.map/, 'idle cards come from modesFor(scope)');
  assert.match(app, /toggleHidden\(HM\.repoWrap, online && mode !== 'research'\)/, 'the repository chip is hidden online except for Research (its findings can become a plan)');
  const submit = app.slice(app.indexOf('async function homeSubmit()'), app.indexOf('/** A server refusal as text'));
  assert.match(submit, /body\.mode = 'web-ask'/);
  assert.match(submit, /body\.mode = 'code-research'/);
  const onlineBranch = submit.slice(submit.indexOf("if (scope === 'online') {"), submit.indexOf("} else if (mode === 'research') {"));
  const webAskPart = onlineBranch.slice(onlineBranch.indexOf('else body.mode'));
  assert.doesNotMatch(webAskPart, /body\.repo|allowChange/, 'web-ask sends no repo and no allowChange');
  assert.match(onlineBranch, /body\.mode = 'research'; if \(t\.repo\) body\.repo = t\.repo;/, 'online research keeps the repository');
  assert.doesNotMatch(onlineBranch, /allowChange/);
  const codeResBranch = submit.slice(submit.indexOf("} else if (mode === 'research') {"), submit.indexOf('} else {\n        if (t.repo)'));
  assert.doesNotMatch(codeResBranch, /follow|allowChange/);
  assert.match(submit, /if \(follow && mode === 'ask'\) body\.follow = follow;/, 'follow only for Ask (research is never mode ask)');
  assert.match(submit, /M\.followTarget\(hm\.turns, res\.name, hm\.newTopic, scope\)/);
  assert.match(submit, /mode, scope, text/, 'turns remember their scope');
  assert.match(app, /M\.webAnswerToText\(res, sources\)/);
  assert.match(app, /M\.codeReportToText\(rp\)/);
  const nodes = app.slice(app.indexOf('function webAnswerNodes'), app.indexOf('function convertNodes'));
  assert.doesNotMatch(nodes, /convertNodes|innerHTML/, 'no "Turn into a task" for web answers or code research');
});

test('Online Ask answers never render model-written links as clickable anchors; Quick Ask keeps its links', () => {
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  assert.match(app, /renderMarkdown\(String\(res\.answer\), \{ links: 'plain' \}\)/, 'the web answer uses the plain-link policy');
  assert.match(app, /renderMarkdown\(res\.answer\)\)\);/, 'Quick Ask keeps its normal links');
  assert.match(app, /if \(href && MD_LINKS === 'plain'\)/, 'plain mode shows the label with its destination host as text');
});

