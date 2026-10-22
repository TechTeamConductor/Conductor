/**
 * Verification gates: detection, execution and baseline comparison (plan §2 RC7 / B2 / C2).
 *
 * Gate commands are repo-owned strings (user-registered, trusted) executed with `sh -c`; they receive an allowlisted
 * environment only. Output is merged (stderr into stdout), parsed for failure KEYS, redacted and tail-capped.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { GateComparison, GateDef, GateResult, GateRun } from '../types.ts';
import { redact } from '../redact.ts';
import { tail } from '../util.ts';
import { git, run, safeEnv } from './exec.ts';
import { parseFailures, stripAnsi } from './parse.ts';

// ───────────────────────────── detection ─────────────────────────────

type Pm = 'pnpm' | 'yarn' | 'bun' | 'npm';

function detectPm(dir: string): Pm {
  const has = (f: string): boolean => existsSync(join(dir, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('bun.lock') || has('bun.lockb')) return 'bun';
  if (has('yarn.lock')) return 'yarn';
  return 'npm';
}

function runScript(pm: Pm, script: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return `npm run ${script} --silent`;
  }
}

const NPM_PLACEHOLDER_TEST_RE = /no test specified/i;

/** Shallow, bounded search for pytest-style files (depth ≤ 3, ≤ 500 entries). */
function dirHasPythonTests(dir: string, depth: number, budget: { n: number }): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (++budget.n > 500) return false;
    if (e.isFile() && (/^(test_.*|.*_test)\.py$/.test(e.name) || e.name === 'conftest.py')) return true;
    if (e.isDirectory() && depth > 1 && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__') {
      if (dirHasPythonTests(join(dir, e.name), depth - 1, budget)) return true;
    }
  }
  return false;
}

function hasPythonTests(dir: string): boolean {
  const cfg = ['pytest.ini', 'conftest.py'].some((f) => existsSync(join(dir, f)));
  if (cfg) return true;
  const textHas = (f: string, re: RegExp): boolean => {
    try {
      return re.test(readFileSync(join(dir, f), 'utf8'));
    } catch {
      return false;
    }
  };
  if (textHas('pyproject.toml', /^\[tool\.pytest/m) || textHas('setup.cfg', /^\[tool:pytest\]/m) || textHas('tox.ini', /^\[pytest\]/m)) return true;
  for (const d of ['tests', 'test']) if (dirHasPythonTests(join(dir, d), 3, { n: 0 })) return true;
  return false;
}

export async function detectGates(repoPath: string): Promise<GateDef[]> {
  const gates: GateDef[] = [];

  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> };
      scripts = pkg.scripts ?? {};
    } catch {
      /* malformed package.json: no JS gates */
    }
    const pm = detectPm(repoPath);
    const has = (s: string): boolean => typeof scripts[s] === 'string' && (scripts[s] as string).trim() !== '';
    const tc = ['typecheck', 'type-check', 'tsc'].find(has);
    if (tc) gates.push({ name: 'typecheck', cmd: runScript(pm, tc), kind: 'typecheck' });
    if (has('lint')) gates.push({ name: 'lint', cmd: runScript(pm, 'lint'), kind: 'lint' });
    if (has('test') && !NPM_PLACEHOLDER_TEST_RE.test(String(scripts.test))) {
      gates.push({ name: 'test', cmd: runScript(pm, 'test'), kind: 'test' });
    }
  }

  if (hasPythonTests(repoPath)) gates.push({ name: 'pytest', cmd: 'python3 -m pytest -q -rf', kind: 'test' });

  if (existsSync(join(repoPath, 'go.mod'))) {
    gates.push({ name: 'go-vet', cmd: 'go vet ./...', kind: 'lint' });
    gates.push({ name: 'go-test', cmd: 'go test ./...', kind: 'test' });
  }

  if (existsSync(join(repoPath, 'Cargo.toml'))) gates.push({ name: 'cargo-test', cmd: 'cargo test', kind: 'test' });

  return gates;
}

// ───────────────────────────── execution ─────────────────────────────

export interface GateRunOpts {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Additive: exact secret values (e.g. from copied env files) to redact from output. */
  secrets?: string[];
}

export const GATE_TAIL_CHARS = 8 * 1024;

/** Defaults that keep runners non-interactive and their output free of colour codes. */
const GATE_ENV_DEFAULTS: Record<string, string> = { CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' };

const passed = (r: Pick<GateResult, 'exitCode' | 'timedOut'>): boolean => r.exitCode === 0 && !r.timedOut;

export async function runGate(def: GateDef, o: GateRunOpts): Promise<GateResult> {
  const started = Date.now();
  // `exec 2>&1` merges stderr into stdout so interleaving is preserved for both parsing and the tail
  const res = await run('sh', ['-c', `exec 2>&1\n${def.cmd}`], {
    cwd: o.cwd,
    env: safeEnv({ ...GATE_ENV_DEFAULTS, ...(o.env ?? {}) }),
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    maxBytes: 8 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const exitCode = res.timedOut || res.aborted ? null : res.code;
  const raw = stripAnsi([res.stdout, res.stderr].filter(Boolean).join('\n'));
  const secrets = o.secrets ?? [];
  const note = res.timedOut ? `\n[gate timed out after ${Math.round(o.timeoutMs / 1000)}s]` : res.aborted ? '\n[gate aborted]' : '';
  const outputTail = tail(redact(raw, secrets), GATE_TAIL_CHARS) + note;

  let failures: string[] | null = null;
  let failureCount: number | null = null;
  if (exitCode === 0) {
    failures = [];
    failureCount = 0;
  } else if (exitCode !== null) {
    const stripPrefixes: string[] = [];
    try {
      stripPrefixes.push(realpathSync(o.cwd));
    } catch {
      /* ignore */
    }
    const p = parseFailures(def.kind, def.cmd, raw, { cwd: o.cwd, stripPrefixes });
    // keys are derived from the (unredacted) output; scrub them as well
    failures = p.failures ? p.failures.map((k) => redact(k, secrets)) : null;
    failureCount = p.count;
  }
  return { name: def.name, cmd: def.cmd, exitCode, timedOut: res.timedOut, durationMs, outputTail, failures, failureCount };
}

export async function runGates(
  defs: GateDef[],
  o: GateRunOpts & { /** Additive: re-run a failing gate once (flake guard) */ rerunFailed?: boolean },
): Promise<GateRun> {
  const sha = await headSha(o.cwd);
  const results: GateResult[] = [];
  for (const def of defs) {
    if (o.signal?.aborted) break;
    const first = await runGate(def, o);
    results.push(o.rerunFailed ? await rerunFlaky(def, o, first) : first);
  }
  return { at: Date.now(), sha, results };
}

async function headSha(cwd: string): Promise<string> {
  try {
    const r = await git(cwd, ['rev-parse', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Flake guard: a failed gate is run ONE more time. A pass on the rerun wins (flake); otherwise the second failure
 * is returned. Timeouts/aborts are not re-run (they are not flakes and would double the wait).
 */
export async function rerunFlaky(def: GateDef, o: GateRunOpts, firstResult: GateResult): Promise<GateResult> {
  if (passed(firstResult) || firstResult.timedOut || o.signal?.aborted) return firstResult;
  return runGate(def, o);
}

// ───────────────────────────── comparison ─────────────────────────────

/**
 * Compare the current run to the baseline run (gates executed on `baseSha` before the builder touched anything).
 *
 * - gate passes now                                   ⇒ passed
 * - gate failing now, no baseline / gate absent / baseline passed ⇒ regression (all failure keys; note when unparseable)
 * - baseline failing, both parseable                  ⇒ regression = keys(now) \ keys(baseline), else preExisting
 * - baseline failing, either side unparseable         ⇒ unverified (plus a regression when failureCount grew)
 */
export function compareGates(baseline: GateRun | null, current: GateRun): GateComparison {
  const out: GateComparison = { regressions: [], preExisting: [], unverified: [], passed: [] };
  for (const now of current.results) {
    if (passed(now)) {
      out.passed.push(now.name);
      continue;
    }
    const base = baseline?.results.find((r) => r.name === now.name) ?? null;
    if (!base || passed(base)) {
      if (now.failures && now.failures.length > 0) out.regressions.push({ gate: now.name, newFailures: [...now.failures] });
      else out.regressions.push({ gate: now.name, newFailures: [], note: 'unparseable' });
      continue;
    }
    // failing now AND failing at baseline
    if (base.failures && now.failures && base.failures.length > 0 && now.failures.length > 0) {
      const had = new Set(base.failures);
      const fresh = now.failures.filter((k) => !had.has(k));
      if (fresh.length > 0) out.regressions.push({ gate: now.name, newFailures: fresh });
      else out.preExisting.push(now.name);
      continue;
    }
    out.unverified.push(now.name);
    if (now.failureCount !== null && base.failureCount !== null && now.failureCount > base.failureCount) {
      out.regressions.push({
        gate: now.name,
        newFailures: [],
        note: `failure count increased from ${base.failureCount} to ${now.failureCount} (output not parseable, so individual failures are unknown)`,
      });
    }
  }
  return out;
}
