// Code Research evidence: every model-cited {file, lines, quote} is checked against the read-only snapshot. These tests pin what may be
// verified and, above all, what must never be: anything outside the snapshot, links, oversized/binary files, malformed ranges, unfound quotes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVIDENCE_LIMITS, buildCodeReport, newBudget, parseLines, validateCodeReport, verifyEvidence } from '../src/asks/evidence.ts';
import type { SnapshotEntry } from '../src/asks/snapshot.ts';

function snapshot(files: Record<string, string | Buffer>, extra: Record<string, SnapshotEntry> = {}): { dir: string; index: Map<string, SnapshotEntry>; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'ev-'));
  const dir = join(root, 'snap');
  const outside = join(root, 'secret.txt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outside, 'TOP SECRET OUTSIDE THE SNAPSHOT\n');
  const index = new Map<string, SnapshotEntry>();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, name), content);
    index.set(name, 'file');
  }
  for (const [name, kind] of Object.entries(extra)) index.set(name, kind);
  return { dir, index, outside };
}
const CODE = 'export function add(a, b) {\n  return a + b;\n}\n\nexport const PI = 3.14159;\n';
const ev = (file: string, lines: string, quote: string) => ({ file, lines, quote });
const check = (snap: ReturnType<typeof snapshot>, item: unknown) => verifyEvidence(snap, item, newBudget());

test('parseLines: N, N-M, empty; everything else is malformed', () => {
  assert.deepEqual(parseLines('7'), { start: 7, end: 7 });
  assert.deepEqual(parseLines(' 3 - 9 '), { start: 3, end: 9 });
  assert.equal(parseLines(''), '');
  assert.equal(parseLines(undefined), '');
  for (const bad of ['abc', '0', '5-2', '1-', '-3', '1,2', '1-2-3', '1e3', '١٢', '99999999', '0-5', '1 2']) assert.equal(parseLines(bad), null, bad);
});

test('a quote found in the cited lines (whitespace-normalised) or in the file is verified', () => {
  const s = snapshot({ 'src/a.ts': CODE });
  assert.equal(check(s, ev('src/a.ts', '2', 'return a + b;')).state, 'verified');
  assert.equal(check(s, ev('src/a.ts', '1-3', 'function   add(a,\n b)')).state, 'verified', 'runs of whitespace and line breaks are squashed');
  assert.equal(check(s, ev('src/a.ts', '1-3', 'function add(a;b)')).state, 'unverified', 'but punctuation is never normalised');
  assert.equal(check(s, ev('src/a.ts', '1-3', 'function add(a, b) {  return a + b;')).state, 'verified', 'line breaks and indentation are normalised');
  assert.equal(check(s, ev('src/a.ts', '', 'PI = 3.14159;')).state, 'unverified', 'a citation must name its lines: with no range nothing is verified');
  assert.equal(check(s, ev('src/a.ts', '5', 'PI = 3.14159;')).state, 'verified');
  assert.equal(check(s, ev('src/a.ts', '1-5', 'does not appear anywhere')).state, 'unverified');
  assert.equal(check(s, ev('src/a.ts', '2', 'PI = 3.14159')).state, 'unverified', 'the quote exists but not inside the cited lines');
});

test('bad line ranges and short quotes are unverified', () => {
  const s = snapshot({ 'src/a.ts': CODE });
  for (const lines of ['0', '6-9', '5-2', 'x', '1-99', '3-3000']) assert.equal(check(s, ev('src/a.ts', lines, 'return a + b;')).state, 'unverified', lines);
  assert.equal(check(s, ev('src/a.ts', '2', 'return a + b')).state, 'verified', '12 characters is the minimum');
  assert.equal(check(s, ev('src/a.ts', '2', 'return a +b')).state, 'unverified', '11 characters proves nothing');
  assert.equal(check(s, ev('src/a.ts', '2', 'ret')).state, 'unverified');
  assert.equal(check(s, ev('src/a.ts', '2', '')).state, 'unverified');
  assert.equal(check(s, ev('src/a.ts', '2', '   ')).state, 'unverified');
  const wide = snapshot({ 'big.txt': Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') });
  const q = 'line 5\nline 6\nline 7';
  assert.equal(check(wide, ev('big.txt', '1-900', q)).state, 'unverified', 'a span over the cap is refused');
  assert.equal(check(wide, ev('big.txt', '1-300', q)).state, 'verified');
});

test('paths: traversal, absolute, .git, control characters, not-in-index and non-file index entries are never verified', () => {
  const s = snapshot({ 'src/a.ts': CODE, '.hidden/x.txt': 'secret-ish text here\n' }, { 'link.ts': 'symlink', 'vendor/lib': 'gitlink', 'cfg/omitted.json': 'omitted' });
  for (const file of ['../secret.txt', 'src/../../secret.txt', '/etc/passwd', s.outside, '.git/config', 'src/.GIT/HEAD', 'src//a.ts', './src/a.ts', 'src/\na.ts', 'src\\a.ts', '', 'nope.ts', 'link.ts', 'vendor/lib', 'cfg/omitted.json', 'a'.repeat(2000)]) {
    assert.equal(check(s, ev(file, '2', 'return a + b;')).state, 'unverified', JSON.stringify(file));
  }
  assert.equal(check(s, ev('.hidden/x.txt', '1', 'secret-ish text')).state, 'verified', 'a committed dotfile that is in the index is fine');
  assert.equal(check(s, ev('src/a.ts\n', '2', 'return a + b;')).file, 'src/a.ts', 'stray control characters in a cited name are cleaned before anything is looked up (and only the real indexed file can match)');
});

test('a symlink or hardlink planted inside the snapshot cannot be used to read outside it', () => {
  const s = snapshot({ 'src/a.ts': CODE });
  // the index (what the snapshot builder recorded) says "file", but the disk now holds a link out of the snapshot
  symlinkSync(s.outside, join(s.dir, 'sneaky.txt'));
  s.index.set('sneaky.txt', 'file');
  assert.equal(check(s, ev('sneaky.txt', '1', 'TOP SECRET OUTSIDE')).state, 'unverified');
  mkdirSync(join(s.dir, 'dirlink-target'));
  symlinkSync(join(s.dir, '..'), join(s.dir, 'up'));
  s.index.set('up/secret.txt', 'file');
  assert.equal(check(s, ev('up/secret.txt', '1', 'TOP SECRET OUTSIDE')).state, 'unverified', 'a symlinked directory that resolves outside');
  linkSync(s.outside, join(s.dir, 'hard.txt')); // a hardlink is a regular file inside the tree: allowed to be read, but it was never indexed
  assert.equal(check(s, ev('hard.txt', '1', 'TOP SECRET OUTSIDE')).state, 'unverified', 'not in the index');
});

test('oversized and binary files are unverified; the total byte budget is enforced', () => {
  const big = 'x'.repeat(EVIDENCE_LIMITS.fileBytes + 1);
  const s = snapshot({ 'big.txt': `needle here ${big}`, 'bin.dat': Buffer.concat([Buffer.from('needle in binary'), Buffer.from([0, 1, 2])]), 'ok.txt': 'a needle in text\n' });
  assert.equal(check(s, ev('big.txt', '1', 'needle here xxx')).state, 'unverified');
  assert.equal(check(s, ev('bin.dat', '1', 'needle in binary')).state, 'unverified');
  assert.equal(check(s, ev('ok.txt', '1', 'a needle in text')).state, 'verified');
  const b = newBudget();
  b.bytes = EVIDENCE_LIMITS.totalBytes - 3;
  assert.equal(verifyEvidence(s, ev('ok.txt', '1', 'a needle in text'), b).state, 'unverified', 'out of byte budget');
});

test('work is bounded: the evidence item count and the time budget turn the rest into unverified', () => {
  const s = snapshot({ 'src/a.ts': CODE });
  const b = newBudget();
  const results = Array.from({ length: EVIDENCE_LIMITS.totalEvidence + 5 }, () => verifyEvidence(s, ev('src/a.ts', '2', 'return a + b;'), b));
  assert.equal(results.filter((r) => r.state === 'verified').length, EVIDENCE_LIMITS.totalEvidence);
  let t = 0;
  const slow = newBudget(() => (t += 1500));
  assert.equal(verifyEvidence(s, ev('src/a.ts', '2', 'return a + b;'), slow).state, 'verified');
  assert.equal(verifyEvidence(s, ev('src/a.ts', '2', 'return a + b;'), slow).state, 'unverified', 'past the CPU budget');
});

test('quotes are plain text: regex syntax, huge strings and odd input never throw and never act as patterns', () => {
  const s = snapshot({ 'src/a.ts': CODE, 'rx.txt': 'a literal (a+)+$ here\n' });
  const t0 = Date.now();
  assert.equal(check(s, ev('rx.txt', '1', 'literal (a+)+$ here')).state, 'verified', 'matched literally');
  assert.equal(check(s, ev('src/a.ts', '1', '.*.*.*.*.*.*.*')).state, 'unverified');
  assert.equal(check(s, ev('src/a.ts', '1', 'a'.repeat(200_000) + '!')).state, 'unverified');
  for (const bad of [null, undefined, 5, 'x', [], { file: 5, lines: {}, quote: [] }, { file: 'src/a.ts', lines: 5, quote: 5 }]) assert.doesNotThrow(() => check(s, bad));
  assert.ok(Date.now() - t0 < 2000, 'no catastrophic matching');
});

test('buildCodeReport: finding status is verified / partial / unverified, caps hold, strings are cleaned', () => {
  const s = snapshot({ 'src/a.ts': CODE });
  const good = ev('src/a.ts', '2', 'return a + b;');
  const bad = ev('src/missing.ts', '1', 'nothing here');
  const raw = {
    summary: 'S'.repeat(5000), recommendation: 'r', limitations: 'l', steps: Array.from({ length: 40 }, (_, i) => `step ${i}`), risks: Array.from({ length: 40 }, (_, i) => `risk ${i}`),
    findings: [
      { claim: 'all good', evidence: [good, good] },
      { claim: 'mixed', evidence: [good, bad] },
      { claim: 'none verified', evidence: [bad] },
      { claim: 'no evidence', evidence: [] },
      ...Array.from({ length: 30 }, () => ({ claim: 'filler', evidence: Array.from({ length: 10 }, () => good) })),
    ],
  };
  const r = buildCodeReport(raw, s);
  assert.deepEqual(r.findings.slice(0, 4).map((f) => f.status), ['verified', 'partial', 'unverified', 'unverified']);
  assert.equal(r.findings.length, EVIDENCE_LIMITS.findings);
  assert.ok(r.findings.every((f) => f.evidence.length <= EVIDENCE_LIMITS.evidencePerFinding));
  assert.equal(r.summary.length, EVIDENCE_LIMITS.summary);
  assert.equal(r.steps.length, EVIDENCE_LIMITS.steps);
  assert.equal(r.risks.length, EVIDENCE_LIMITS.risks);
  assert.equal(r.findings.flatMap((f) => f.evidence).filter((e) => e.state === 'verified').length <= EVIDENCE_LIMITS.totalEvidence, true);
  const clean = buildCodeReport({ summary: 'a‮b\u0000c', findings: [{ claim: 'x​y', evidence: [{ file: 'src/a.ts\nx', lines: '1', quote: 'q‮' }] }], risks: [], recommendation: '', steps: [], limitations: '' }, s);
  assert.doesNotMatch(JSON.stringify(clean), /[‮​\u0000]/);
  assert.deepEqual(buildCodeReport(null, s), { summary: '', findings: [], risks: [], recommendation: '', steps: [], limitations: '' });
});

test('validateCodeReport re-checks a stored report: states and statuses are enums, caps hold, junk is rejected', () => {
  assert.equal(validateCodeReport(null), null);
  assert.equal(validateCodeReport('x'), null);
  const v = validateCodeReport({ summary: 's', findings: [{ claim: 'c', status: 'hacked', evidence: [{ file: 'a', lines: '1', quote: 'qqqq', state: 'pwned' }, { file: 'b', lines: '', quote: 'zzzz', state: 'verified' }] }], risks: ['r'], recommendation: 'x', steps: ['s'], limitations: 'l' })!;
  assert.equal(v.findings[0]!.status, 'unverified');
  assert.deepEqual(v.findings[0]!.evidence.map((e) => e.state), ['unverified', 'verified']);
  const huge = validateCodeReport({ summary: 'x'.repeat(99999), findings: Array.from({ length: 99 }, () => ({ claim: 'c', evidence: Array.from({ length: 99 }, () => ({ file: 'f', lines: '1', quote: 'qqqq', state: 'verified' })) })), risks: Array(99).fill('r'), steps: Array(99).fill('s') })!;
  assert.equal(huge.findings.length, EVIDENCE_LIMITS.findings);
  assert.equal(huge.findings[0]!.evidence.length, EVIDENCE_LIMITS.evidencePerFinding);
  assert.equal(huge.summary.length, EVIDENCE_LIMITS.summary);
});
