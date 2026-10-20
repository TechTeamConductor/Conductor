/**
 * Gate failure parsers. Turn runner output into a SET of stable failure keys so that "baseline already failing"
 * does not mask new failures (plan §2 RC7 / B2).
 *
 * Carry-forward C2: keys carry NO line/column numbers (the same diagnostic shifting down a file must yield the same
 * key) and no absolute worktree paths (baseline and current may run in different directories).
 *
 * Supported: node:test (TAP and spec reporter), jest, vitest, pytest, go test / go vet, cargo, tsc, eslint
 * (stylish, compact, unix). Unknown formats ⇒ `failures: null`.
 */
import type { GateDef } from '../types.ts';

export interface ParsedFailures {
  /** Stable keys, or null when nothing could be extracted. */
  failures: string[] | null;
  /** keys.length when keys were parsed, else a count taken from the runner's own summary line, else null. */
  count: number | null;
}

export interface ParseOptions {
  /** Directory the gate ran in; occurrences of it are stripped from keys. */
  cwd?: string;
  /** Extra path prefixes to strip (e.g. realpath of cwd). */
  stripPrefixes?: string[];
}

interface Parsed {
  keys: string[];
  summary: number | null;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

const SEP = ' > ';

/** Keep duplicates distinguishable without using line numbers: 2nd occurrence ⇒ "key (#2)". */
function withMultiplicity(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k} (#${n})`;
  });
}
const uniq = (keys: string[]): string[] => [...new Set(keys)];
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

type Rel = (s: string) => string;
function makeRel(o: ParseOptions): Rel {
  const prefixes = [...new Set([o.cwd, ...(o.stripPrefixes ?? [])].filter((p): p is string => !!p).map((p) => p.replace(/\/+$/, '')))]
    .filter((p) => p.length > 1)
    .sort((a, b) => b.length - a.length);
  return (s: string): string => {
    let out = s;
    for (const p of prefixes) {
      out = out.split(`${p}/`).join('');
      if (out === p) out = '.';
    }
    return out.replace(/^\.\//, '');
  };
}

// ───────────────────────────── node:test — TAP ─────────────────────────────

function parseTap(lines: string[], rel: Rel): Parsed | null {
  const isTap = lines.some((l) => /^TAP version \d+/.test(l) || /^\s*(not ok|ok) \d+\b/.test(l));
  if (!isTap) return null;
  const names: string[] = [];
  const failedAt = new Map<number, boolean>();
  const keys: string[] = [];
  let summary: number | null = null;
  let yamlIndent = -1;
  for (const raw of lines) {
    if (yamlIndent >= 0) {
      const m = /^(\s*)\.\.\.\s*$/.exec(raw);
      if (m && m[1]!.length === yamlIndent) yamlIndent = -1;
      continue;
    }
    const y = /^(\s*)---\s*$/.exec(raw);
    if (y) {
      yamlIndent = y[1]!.length;
      continue;
    }
    const sum = /^#\s+fail\s+(\d+)\s*$/.exec(raw);
    if (sum) {
      summary = Number(sum[1]);
      continue;
    }
    const sub = /^(\s*)#\s+Subtest:\s*(.*)$/.exec(raw);
    if (sub) {
      const level = Math.floor(sub[1]!.length / 4);
      names.length = level;
      names[level] = clean(sub[2]!);
      continue;
    }
    const res = /^(\s*)(not ok|ok)\s+(\d+)(?:\s+(?:-\s+)?(.*?))?\s*$/.exec(raw);
    if (!res) continue;
    const level = Math.floor(res[1]!.length / 4);
    let name = res[4] ?? '';
    const time = /\s+#\s*time=\S+\s*$/.exec(name);
    if (time) name = name.slice(0, time.index);
    const dir = /\s+#\s*(SKIP|TODO)\b.*$/i.exec(name);
    let excused = false;
    if (dir) {
      excused = true;
      name = name.slice(0, dir.index);
    }
    name = clean(name) || `test ${res[3]}`;
    const childFailed = failedAt.get(level + 1) === true;
    for (const k of [...failedAt.keys()]) if (k > level) failedAt.delete(k);
    if (res[2] === 'not ok' && !excused) {
      failedAt.set(level, true);
      if (!childFailed) keys.push(rel([...names.slice(0, level), name].join(SEP)));
    }
  }
  return { keys: uniq(keys), summary };
}

// ───────────────────────────── node:test — spec reporter ─────────────────────────────

function parseNodeSpec(lines: string[], rel: Rel): Parsed | null {
  const hasMarks = lines.some((l) => /^\s*[✖✔▶﹣]\s/.test(l));
  const hasSummary = lines.some((l) => /^ℹ (tests|suites|pass|fail)\s/.test(l));
  if (!hasMarks || !hasSummary) return null;
  const cut = lines.findIndex((l) => /^✖ failing tests:/.test(l));
  const body = cut >= 0 ? lines.slice(0, cut) : lines;
  const stack: { level: number; name: string; childFailed: boolean }[] = [];
  const keys: string[] = [];
  let summary: number | null = null;
  for (const l of lines) {
    const m = /^ℹ fail\s+(\d+)\s*$/.exec(l);
    if (m) summary = Number(m[1]);
  }
  for (const raw of body) {
    const open = /^(\s*)▶\s+(.*?)\s*$/.exec(raw);
    if (open) {
      stack.push({ level: Math.floor(open[1]!.length / 2), name: clean(open[2]!), childFailed: false });
      continue;
    }
    const m = /^(\s*)([✔✖﹣])\s+(.*)$/.exec(raw);
    if (!m) continue;
    const level = Math.floor(m[1]!.length / 2);
    const name = clean(m[3]!.replace(/\s+\(\d+(?:\.\d+)?ms\)(?:\s+#.*)?$/, '').replace(/\s+#\s*(SKIP|TODO).*$/i, ''));
    while (stack.length > 0 && stack[stack.length - 1]!.level > level) stack.pop();
    let isSuite = false;
    let suiteHadFailingChild = false;
    const top = stack[stack.length - 1];
    if (top && top.level === level && top.name === name) {
      isSuite = true;
      suiteHadFailingChild = top.childFailed;
      stack.pop();
    }
    if (m[2] !== '✖') continue;
    const parents = stack.map((s) => s.name);
    if (!(isSuite && suiteHadFailingChild)) keys.push(rel([...parents, name].join(SEP)));
    const parent = stack[stack.length - 1];
    if (parent) parent.childFailed = true;
  }
  return { keys: uniq(keys), summary };
}

// ───────────────────────────── jest / vitest ─────────────────────────────

const JS_FILE_LINE_RE = /^\s*(?:PASS|FAIL)\s+\S*\.(?:[cm]?[jt]sx?|vue|svelte|mdx)\b/;

function parseJestVitest(lines: string[], rel: Rel): Parsed | null {
  const looksJest = lines.some(
    (l) =>
      JS_FILE_LINE_RE.test(l) || /^\s*●\s/.test(l) || /^Tests:\s+\d/.test(l) || /^\s*Tests\s+\d+ (failed|passed)/.test(l) || /^\s*FAIL\s+\S.* > /.test(l),
  );
  if (!looksJest) return null;
  const keys: string[] = [];
  let file = '';
  let summary: number | null = null;
  let sawBullet = false;
  const ticks: string[] = [];
  for (const raw of lines) {
    const fail = /^\s*FAIL\s+(\S.*?)\s*$/.exec(raw);
    if (fail) {
      let rest = fail[1]!.replace(/\s+\d+(?:\.\d+)?\s*m?s$/, '').replace(/\s+\[[^\]]*\]$/, '');
      if (rest.includes(SEP)) keys.push(rel(clean(rest))); // vitest: "FAIL  file > suite > test"
      else if (/\.(?:[cm]?[jt]sx?|vue|svelte|mdx)\b/.test(rest)) {
        rest = rest.replace(/\s+\(\d+(?:\.\d+)?\s*m?s\)$/, '');
        file = rel(clean(rest));
      }
      continue;
    }
    const bullet = /^\s*●\s+(.+?)\s*$/.exec(raw);
    if (bullet) {
      const b = bullet[1]!;
      if (/^(Console|Validation Warning|Deprecation)/.test(b)) continue;
      sawBullet = true;
      if (/^Test suite failed to run/.test(b)) keys.push(`${file || 'unknown file'} suite failed to run`);
      else keys.push(rel(clean((file ? `${file} › ` : '') + b).replace(/ › /g, SEP)));
      continue;
    }
    const tick = /^\s*[✕✗×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/.exec(raw);
    if (tick) ticks.push(rel(clean(tick[1]!)));
    const jt = /^Tests:\s+(?:.*?(\d+) failed)/.exec(raw);
    if (jt) summary = Number(jt[1]);
    const vt = /^\s*Tests\s+(?:.*?(\d+) failed)/.exec(raw);
    if (vt) summary = Number(vt[1]);
  }
  let out = uniq(keys);
  if (out.length === 0 && !sawBullet && ticks.length > 0) out = uniq(ticks);
  if (out.length === 0 && summary === null && !sawBullet) {
    // file-level failures only (e.g. "FAIL path" without detail)
    if (file) out = [file];
  }
  return { keys: out, summary };
}

// ───────────────────────────── pytest ─────────────────────────────

function cutAtDash(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && s.startsWith(' - ', i)) return s.slice(0, i);
  }
  return s;
}

function parsePytest(lines: string[], rel: Rel): Parsed | null {
  const marker = lines.findIndex((l) => /^=+ short test summary info =+\s*$/.test(l));
  const hasSession = lines.some((l) => /^=+ test session starts =+/.test(l));
  const finalLine = lines.find((l) =>
    /^(?:=+\s+)?\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|warnings?|deselected)\b.* in [\d.]+s\b/.test(l),
  );
  const verbose = lines.some((l) => /^\S+::\S+.* (PASSED|FAILED|ERROR)\b/.test(l));
  if (marker < 0 && !hasSession && !finalLine && !verbose) return null;
  const keys: string[] = [];
  if (marker >= 0) {
    for (const raw of lines.slice(marker + 1)) {
      if (/^=+/.test(raw)) break;
      const m = /^(FAILED|ERROR)\s+(\S.*)$/.exec(raw);
      if (!m) continue;
      const id = clean(cutAtDash(m[2]!));
      keys.push(rel(m[1] === 'ERROR' ? `ERROR ${id}` : id));
    }
  }
  for (const raw of lines) {
    const m = /^(\S+::\S+?)\s+(FAILED|ERROR)\b/.exec(raw);
    if (m) keys.push(rel(m[2] === 'ERROR' ? `ERROR ${m[1]}` : m[1]!));
  }
  let summary: number | null = null;
  if (finalLine) {
    const f = /(\d+) failed/.exec(finalLine);
    const e = /(\d+) errors?/.exec(finalLine);
    if (f || e) summary = (f ? Number(f[1]) : 0) + (e ? Number(e[1]) : 0);
  }
  return { keys: uniq(keys), summary };
}

// ───────────────────────────── go test / go vet ─────────────────────────────

function parseGo(lines: string[], rel: Rel): Parsed | null {
  const isGo =
    lines.some((l) => /^\s*--- (FAIL|PASS):\s/.test(l)) ||
    lines.some((l) => /^(ok|FAIL|\?)\s+\S+\s+(\d|\[|\()/.test(l) || /^FAIL\t\S+/.test(l)) ||
    lines.some((l) => /^(vet: )?\S+\.go:\d+:\d+: /.test(l) && lines.some((x) => /^# \S+/.test(x)));
  if (!isGo) return null;
  const keys: string[] = [];
  let pending: string[] = [];
  const flushPkg = (pkg: string, buildFail: boolean): void => {
    const subs = new Set(pending);
    const leaves = pending.filter((t) => ![...subs].some((o) => o !== t && o.startsWith(`${t}/`)));
    for (const t of leaves) keys.push(`${pkg} ${t}`);
    if (buildFail) keys.push(`${pkg} [build failed]`);
    else if (leaves.length === 0) keys.push(`${pkg} (package failed)`);
    pending = [];
  };
  for (const raw of lines) {
    const t = /^\s*--- FAIL:\s+(\S+)/.exec(raw);
    if (t) {
      pending.push(t[1]!);
      continue;
    }
    const pf = /^FAIL\s+(\S+)\s+\[(build failed|setup failed)\]\s*$/.exec(raw);
    if (pf) {
      flushPkg(pf[1]!, true);
      continue;
    }
    const pk = /^FAIL\s+(\S+)\s+[\d.]+s\s*$/.exec(raw) ?? /^FAIL\t(\S+)\t/.exec(raw);
    if (pk) {
      flushPkg(pk[1]!, false);
      continue;
    }
    const diag = /^(?:vet: )?(\S+?\.go):\d+(?::\d+)?: (.*)$/.exec(raw);
    if (diag) keys.push(rel(`${diag[1]!.replace(/^\.\//, '')} ${clean(diag[2]!)}`));
  }
  // tests that failed in a binary that never printed a package line (e.g. -run piped through other tools)
  for (const t of pending) keys.push(t);
  return { keys: withMultiplicity(keys), summary: null };
}

// ───────────────────────────── cargo ─────────────────────────────

const CARGO_ROLLUP_RE = /^(could not compile|test failed|aborting due to|build failed|failed to run|process didn't exit|some tests failed|\d+ warnings? emitted)/;

function parseCargo(lines: string[], rel: Rel): Parsed | null {
  const isCargo =
    lines.some((l) => /^test \S+ \.\.\. (ok|FAILED|ignored)/.test(l)) ||
    lines.some((l) => /^test result: (ok|FAILED)\./.test(l)) ||
    lines.some((l) => /^error(\[E\d+\])?: /.test(l) && lines.some((x) => /^\s*--> \S+:\d+:\d+/.test(x)));
  if (!isCargo) return null;
  const keys: string[] = [];
  let summary: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const t = /^test (\S+) \.\.\. FAILED\s*$/.exec(raw);
    if (t) {
      keys.push(t[1]!);
      continue;
    }
    const r = /^test result: FAILED\.\s+\d+ passed; (\d+) failed;/.exec(raw);
    if (r) summary = (summary ?? 0) + Number(r[1]);
    const e = /^error(?:\[(E\d+)\])?: (.*)$/.exec(raw);
    if (e && !CARGO_ROLLUP_RE.test(e[2]!)) {
      let loc = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const l = /^\s*--> (\S+?):\d+:\d+/.exec(lines[j]!);
        if (l) {
          loc = l[1]!;
          break;
        }
      }
      keys.push(rel(clean(`${loc} ${e[1] ?? ''} ${e[2]!}`)));
    }
  }
  return { keys: withMultiplicity(keys), summary };
}

// ───────────────────────────── tsc ─────────────────────────────

function parseTsc(lines: string[], rel: Rel): Parsed | null {
  const keys: string[] = [];
  let summary: number | null = null;
  let any = false;
  for (const raw of lines) {
    let m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw);
    if (!m) m = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/.exec(raw);
    if (m) {
      any = true;
      keys.push(rel(`${m[1]!.replace(/^\.\//, '')} ${m[4]} ${clean(m[5]!)}`));
      continue;
    }
    const g = /^error (TS\d+): (.*)$/.exec(raw);
    if (g) {
      any = true;
      keys.push(rel(`${g[1]} ${clean(g[2]!)}`));
      continue;
    }
    const f = /^Found (\d+) errors?\b/.exec(raw);
    if (f) {
      any = true;
      summary = Number(f[1]);
    }
  }
  if (!any) return null;
  return { keys: withMultiplicity(keys), summary };
}

// ───────────────────────────── eslint ─────────────────────────────

function parseEslint(lines: string[], rel: Rel): Parsed | null {
  const keys: string[] = [];
  let summary: number | null = null;
  let any = false;
  let file = '';
  for (const raw of lines) {
    const p = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/.exec(raw);
    if (p) {
      any = true;
      if (p[3] === 'error') keys.push(rel(clean(`${file} ${p[5] ?? ''} ${p[4]!}`)));
      continue;
    }
    const compact = /^(.+?): line \d+, col \d+, (Error|Warning) - (.*?)(?: \(([^)]+)\))?$/.exec(raw);
    if (compact) {
      any = true;
      if (compact[2] === 'Error') keys.push(rel(clean(`${compact[1]} ${compact[4] ?? ''} ${compact[3]!}`)));
      continue;
    }
    const unix = /^(.+?):\d+:\d+: (.*?) \[(Error|Warning)(?:\/([^\]]+))?\]$/.exec(raw);
    if (unix) {
      any = true;
      if (unix[3] === 'Error') keys.push(rel(clean(`${unix[1]} ${unix[4] ?? ''} ${unix[2]!}`)));
      continue;
    }
    const s = /^✖ (\d+) problems? \((\d+) errors?/.exec(raw);
    if (s) {
      any = true;
      summary = Number(s[2]);
      continue;
    }
    if (raw.length > 0 && !/^\s/.test(raw) && !raw.startsWith('✖')) file = raw.trim();
  }
  if (!any) return null;
  return { keys: withMultiplicity(keys), summary };
}

// ───────────────────────────── dispatcher ─────────────────────────────

type ParserFn = (lines: string[], rel: Rel) => Parsed | null;

const TEST_ORDER: ParserFn[] = [parseTap, parseNodeSpec, parsePytest, parseJestVitest, parseGo, parseCargo, parseTsc, parseEslint];
const TYPECHECK_ORDER: ParserFn[] = [parseTsc, parseCargo, parseGo, parseEslint, parseTap, parseNodeSpec, parsePytest, parseJestVitest];
const LINT_ORDER: ParserFn[] = [parseEslint, parseGo, parseCargo, parseTsc, parseTap, parseNodeSpec, parsePytest, parseJestVitest];

export function parseFailures(kind: GateDef['kind'], cmd: string, output: string, opts: ParseOptions = {}): ParsedFailures {
  const text = stripAnsi(output).replace(/\r\n?/g, '\n');
  // bound per-line work (minified bundles / giant single lines must not make the regexes expensive)
  const lines = text.split('\n').map((l) => (l.length > 4000 ? l.slice(0, 4000) : l));
  const rel = makeRel(opts);
  let order = TEST_ORDER;
  if (kind === 'typecheck' || /\btsc\b|type-?check/i.test(cmd)) order = TYPECHECK_ORDER;
  else if (kind === 'lint' || /eslint|go vet|clippy|biome|ruff/i.test(cmd)) order = LINT_ORDER;

  let summaryOnly: number | null = null;
  for (const parser of order) {
    let r: Parsed | null;
    try {
      r = parser(lines, rel);
    } catch {
      r = null;
    }
    if (!r) continue;
    if (r.keys.length > 0) return { failures: r.keys, count: r.keys.length };
    if (summaryOnly === null && r.summary !== null && r.summary > 0) summaryOnly = r.summary;
  }
  return { failures: null, count: summaryOnly };
}
