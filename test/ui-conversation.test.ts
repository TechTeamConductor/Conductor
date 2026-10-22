// Home composer: follow-up eligibility and the plain-text serializers behind the copy buttons (pure helpers in ui/modes.js, loaded the same way
// as test/ui-modes.test.ts), plus static checks on how ui/app.js wires them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Turn { mode: string; phase: string; askId: string | null; repo: string | null }
interface Modes {
  followTarget(turns: Turn[], repo: string | null, newTopic: boolean): string | null;
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
  assert.equal((app.match(/copyAnswerBtn\(/g) ?? []).length, 4, 'one definition + answer + home report + report dialog');
  assert.match(app, /M\.answerToText\(res\)/);
  assert.equal((app.match(/M\.reportToText\(r\.report\)/g) ?? []).length, 2);
  const submit = app.slice(app.indexOf('async function homeSubmit()'), app.indexOf('/** A server refusal as text'));
  const follow = submit.indexOf('M.followTarget(hm.turns');
  assert.ok(follow > 0 && follow < submit.indexOf('pushTurn(t)'), 'followTarget is evaluated before pushTurn');
  assert.match(submit, /if \(follow && mode === 'ask'\) body\.follow = follow;/);
  assert.doesNotMatch(submit, /history/i, 'the client never sends history text, only the id to follow');
  assert.match(app, /hm\.newTopic = false;/);
});
