// M3 commit 0 — CHARACTERIZATION of the single-task pipeline, written BEFORE the task graph exists (plan §2b-3).
// A plan without a graph (and, later, a one-item graph) must keep producing exactly this: run fields, session sequence, event sequence,
// commit message and board comments. If a graph change alters any of it for a graph-less plan, this test says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, makeHarness, type Harness } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';

const sha = (s: string) => s.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>');

async function snapshot(h: Harness, key: string) {
  const run = h.run(key);
  return {
    run: {
      status: run.status, next: run.next, stage: run.stage, loop: run.loop, rev: run.rev, agentRuns: run.agentRuns, planApproved: run.planApproved,
      approvedBy: run.approvedBy, verdict: run.verdict, complexity: run.complexity, unverified: run.unverified, hasCommit: !!run.commitSha,
      sessions: run.sessions.map((s) => [s.agent, s.stage, s.loop, s.status]),
      history: run.history.map((x) => sha(x.text)),
    },
    events: h.store.readEvents(key, 0, 500).events.map((e) => [e.agent, e.stage, e.kind, e.tool ?? '', e.ok ?? '']),
    commit: sha(git(run.worktree, 'log', '--format=%s%n%b---', `${run.baseSha}..HEAD`)),
    commitCount: Number(git(run.worktree, 'rev-list', '--count', `${run.baseSha}..HEAD`)),
    comments: (await comments(h, key)).map(sha),
  };
}

export const GOLDEN_RUN = {"status": "ready", "next": "none", "stage": "verify", "loop": 1, "rev": 1, "agentRuns": 3, "planApproved": true, "approvedBy": "auto", "verdict": "pass", "complexity": "S", "unverified": false, "hasCommit": true, "sessions": [["claude", "plan", 1, "ok"], ["cursor", "build", 1, "ok"], ["claude", "verify", 1, "ok"]], "history": ["Claimed by Conductor", "Plan rev 1 ready (S, 1 AC)", "Build 1: 2 file(s) committed (<sha>)", "Verified \u2014 ready for your review"]};
export const GOLDEN_EVENTS = [["conductor", "plan", "note", "", ""], ["conductor", "plan", "note", "", ""], ["conductor", "plan", "note", "", ""], ["conductor", "verify", "note", "", true], ["claude", "plan", "system", "", ""], ["claude", "plan", "text", "", ""], ["claude", "plan", "tool", "Glob", ""], ["claude", "plan", "tool_result", "", true], ["claude", "plan", "tool", "Read", ""], ["claude", "plan", "tool_result", "", true], ["claude", "plan", "text", "", ""], ["claude", "plan", "result", "", true], ["cursor", "build", "system", "", ""], ["cursor", "build", "thinking", "", ""], ["cursor", "build", "text", "", ""], ["cursor", "build", "tool", "edit", ""], ["cursor", "build", "tool_result", "edit", true], ["cursor", "build", "tool", "edit", ""], ["cursor", "build", "tool_result", "edit", true], ["cursor", "build", "tool", "shell", ""], ["cursor", "build", "tool_result", "shell", true], ["cursor", "build", "text", "", ""], ["cursor", "build", "result", "", true], ["conductor", "verify", "note", "", true], ["claude", "verify", "system", "", ""], ["claude", "verify", "text", "", ""], ["claude", "verify", "tool", "Glob", ""], ["claude", "verify", "tool_result", "", true], ["claude", "verify", "tool", "Read", ""], ["claude", "verify", "tool_result", "", true], ["claude", "verify", "text", "", ""], ["claude", "verify", "result", "", true]];

test('M3-0: a plan without a task graph runs plan → build → verify exactly as before (fields, sessions, events, commit message, comments)', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Add the greeting');
    await h.settle();
    const s = await snapshot(h, key);
    assert.deepEqual(s.run, GOLDEN_RUN);
    assert.deepEqual(s.events, GOLDEN_EVENTS);
    assert.equal(s.commit, 'ENG-1: Add the greeting\nBuilt by Conductor (Cursor). Plan rev 1.\n---');
    assert.equal(s.commitCount, 1, 'one build commit');
    assert.equal(s.comments.length, 3);
    assert.match(s.comments[0]!, /^🤖 \*\*Conductor picked this up\.\*\* Plan \(Claude\) → build \(Cursor\) → independent verification \(Claude\)\.$/);
    assert.match(s.comments[1]!, /^🤖 \*\*Conductor plan\*\* \(revision 1, complexity S\)\n\n### Summary\nImplement "Add the greeting" with a small, tested change\./);
    assert.ok(!s.comments[1]!.includes('### Tasks'), 'a graph-less plan renders no task section');
    assert.match(s.comments[2]!, /^🤖 \*\*Ready for review ✅\*\*\n\nAll acceptance criteria are met and the gates pass\./);
  } finally {
    await h.cleanup();
  }
});

test('M3-0: the verification-failure → fix loop path of a graph-less plan is unchanged (loop 2, a fix commit, a bug card opened and closed, fix template)', async () => {
  const h = await makeHarness();
  try {
    const bug = { title: 'Feature returns wrong value for 0', severity: 'major', file: 'feature.mjs', line: 1, evidence: 'feature() ignores input', repro: 'feature(0)', suggestedFix: 'handle 0' };
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'One real problem.', bugs: [bug] } }, { json: { verdict: 'pass' } }] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.loop, 2);
    assert.deepEqual(run.sessions.map((x) => [x.agent, x.stage, x.loop]), [['claude', 'plan', 1], ['cursor', 'build', 1], ['claude', 'verify', 1], ['cursor', 'build', 2], ['claude', 'verify', 2]]);
    assert.equal(Number(git(run.worktree, 'rev-list', '--count', `${run.baseSha}..HEAD`)), 2);
    assert.match(git(run.worktree, 'log', '-1', '--format=%s%n%b'), /ENG-1: Add the greeting \(fix, loop 2\)\nBuilt by Conductor \(Cursor\)\. Plan rev 1\./);
    const kids = h.board.children(h.board.item(key)!.id);
    assert.equal(kids.length, 1);
    assert.deepEqual([kids[0]!.kind, kids[0]!.lane, kids[0]!.createdBy], ['bug', 'done', 'conductor']);
    assert.ok(run.bugs.every((b) => b.status === 'closed'));
  } finally {
    await h.cleanup();
  }
});
