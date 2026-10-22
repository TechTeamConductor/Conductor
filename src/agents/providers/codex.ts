// The Codex adapter (M2: READ-ONLY roles only — it has no `build` by construction, and `registry.codex.build` is undefined by test).
// Everything here is shaped by the Security design conditions:
//  - argv is CONSTANTS plus one validated model name; every pin is a command-line flag (exec never reads a config file for isolation);
//  - the child runs with a private CODEX_HOME and a throw-away empty HOME, a minimal env allow-list and `shell_environment_policy` pins;
//  - the prompt goes on stdin, structured output through --output-schema/-o files in a 0700 temp dir OUTSIDE the worktree;
//  - limit/auth are classified ONLY after a structural failure, from CLI-reported error events/stderr, never from model prose;
//  - an unverified/blocked tier is a label, not a bypass: the router decides who may run what.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import type { VerificationBinding } from './verification.ts';
import { join } from 'node:path';
import type { AgentResult, StageName } from '../../types.ts';
import { resolveBin } from '../../config.ts';
import { codexModelArgs } from '../model-args.ts';
import { toolDefaultResolved } from '../../models/select.ts';
export { codexModelArgs };
import { redact } from '../../redact.ts';
import { sha256, truncate } from '../../util.ts';
import { codexEnv } from '../env.ts';
import { extractJson, type Schema } from '../json.ts';
import { runProcess, type SpawnResult } from '../spawn.ts';
import type { EmitEvent } from '../claude.ts';
import { CODEX_CONFIG_TOML, makeScratchHome, prepareCodexHome, scratchTmp, withCodexHomeLock, codexHomePath } from './codex-home.ts';
import { PROVIDER_LABEL, type AuthResult, type DetectResult, type Provider, type ProviderDeps, type ReadOnlyRunReq, type SelfTestLevel, type SelfTestResult } from './types.ts';
import { BROKEN_RE, cheapSelfTest } from './probe.ts';
import type { Config } from '../../types.ts';

/** The oldest Codex CLI this adapter was written against (the version the author's machine has). Older ⇒ the adapter reports `unverified` and the canary refuses. */
export const CODEX_MIN_VERSION = '0.128.0';

export function versionAtLeast(found: string, min: string): boolean {
  const num = (s: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(s) ?? []).slice(1, 4).map(Number);
  const a = num(found);
  const b = num(min);
  if (a.length < 3) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

// ───────────── argv (constants only) ─────────────
export interface CodexArgvOpts {
  /** Validated by the narrow rule (modelIdOk('codex'), = CODEX_MODEL_RE); anything else is ignored. */
  model?: string;
  /** M8-2: a token from EFFORT_TOKENS, sent as the one literal `-c model_reasoning_effort="<tok>"`; anything else is ignored. */
  effort?: string;
  outFile: string;
}
/**
 * The ONLY way a Codex command line is built. No user-, repo- or config-derived string except the validated model name and the effort
 * token (M8-2, Security S6 + the N9 ruling): the variable tail is exactly `--model=<id>` and/or the pair `-c`, `model_reasoning_effort="<tok>"`
 * (a literal from CODEX_EFFORT_ARG), inserted immediately before `-o`. No other selection-derived `-c` key or flag exists; adding one voids
 * the N9 ruling and goes back to Security. CODEX_ARGV_DIGEST stays computed over the constant argv without model or effort.
 * Absent on purpose (a test asserts it): the bypass/yolo/full-auto flags, --add-dir, --search, --profile, any other sandbox mode,
 * `--skip-git-repo-check`, and `--output-schema`: Codex sends that schema as a strict structured-output format and Conductor's stage schemas
 * (optional properties, no additionalProperties:false) are probably rejected by it — unverifiable without a real binary, so the JSON instruction in the
 * prompt plus Conductor's own validate() carry the structure, and the first real run decides whether a strict schema is worth adding.
 */
export function buildCodexArgs(o: CodexArgvOpts): string[] {
  const args = [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false',
    // the child's shell commands get a minimal environment: no Conductor/CODEX variables, nothing that looks like a key (proved by the decoy canary, never assumed)
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.exclude=["CODEX_*","*KEY*","*TOKEN*","*SECRET*","*PASSWORD*"]',
  ];
  args.push(...codexModelArgs({ model: o.model, effort: o.effort }));
  args.push('-o', o.outFile, '-'); // `-` = the prompt comes from stdin
  return args;
}

// ───────────── JSONL → LogEvent ─────────────
const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && Object.hasOwn(o as object, k) ? (o as Record<string, unknown>)[k] : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const MAX_ERR = 500;
const MAX_ERRORS = 5;

export interface CodexFold {
  sessionId?: string;
  /** Text of the last completed agent_message. */
  finalText: string;
  /** A terminal `turn.completed` was seen. */
  completed: boolean;
  /** Messages the CLI itself reported through `turn.failed` / `error` events (structured; capped). */
  errors: string[];
  /** Shell commands the agent ran (capped): what it TRIED and what came of it — the canary's evidence. */
  commands: { command: string; exitCode: number | null; status: string; output: string }[];
  fileChanges: { status: string }[];
  usage?: { input?: number; cached?: number; output?: number };
}
export const newCodexFold = (): CodexFold => ({ finalText: '', completed: false, errors: [], commands: [], fileChanges: [] });

export function normalizeCodexEvent(obj: unknown, ctx: { stage: StageName; secrets?: string[] }, fold: CodexFold): EmitEvent[] {
  const out: EmitEvent[] = [];
  const base = { agent: 'codex' as const, stage: ctx.stage };
  const R = (s: string, n = 600) => truncate(redact(s, ctx.secrets ?? []), n);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const type = str(own(obj, 'type'));
  switch (type) {
    case 'thread.started': {
      const id = str(own(obj, 'thread_id'));
      if (id) {
        fold.sessionId = id;
        out.push({ ...base, kind: 'system', text: 'Codex session started', sessionId: id });
      }
      break;
    }
    case 'item.started':
    case 'item.completed': {
      const item = own(obj, 'item');
      const itype = str(own(item, 'type'));
      const done = type === 'item.completed';
      if (itype === 'agent_message' && done) {
        const t = str(own(item, 'text')) ?? '';
        fold.finalText = t;
        out.push({ ...base, kind: 'text', text: R(t, 4000), sessionId: fold.sessionId });
      } else if (itype === 'reasoning' && done) {
        const t = str(own(item, 'text')) ?? '';
        if (t.trim()) out.push({ ...base, kind: 'thinking', text: R(t.trim(), 400), sessionId: fold.sessionId });
      } else if (itype === 'command_execution') {
        if (!done) out.push({ ...base, kind: 'tool', tool: 'shell', text: R(str(own(item, 'command')) ?? '', 300), sessionId: fold.sessionId });
        else {
          const code = own(item, 'exit_code');
          if (fold.commands.length < 50) fold.commands.push({ command: truncate(str(own(item, 'command')) ?? '', 500), exitCode: typeof code === 'number' ? code : null, status: str(own(item, 'status')) ?? '', output: truncate(str(own(item, 'aggregated_output')) ?? '', 20_000) });
          out.push({ ...base, kind: 'tool_result', tool: 'shell', ok: code === 0, text: R(`exit ${typeof code === 'number' ? code : '?'}`, 240), sessionId: fold.sessionId });
        }
      } else if (itype === 'file_change' && done) {
        if (fold.fileChanges.length < 50) fold.fileChanges.push({ status: str(own(item, 'status')) ?? '' });
        out.push({ ...base, kind: 'tool_result', tool: 'file_change', ok: str(own(item, 'status')) !== 'failed', text: 'The agent tried to change files (blocked: read-only)', sessionId: fold.sessionId });
      } else if (itype === 'mcp_tool_call') {
        out.push({ ...base, kind: done ? 'tool_result' : 'tool', tool: 'mcp', text: R(`${str(own(item, 'server')) ?? '?'}/${str(own(item, 'tool')) ?? '?'}`, 200), sessionId: fold.sessionId });
      } else if (itype === 'web_search' && !done) {
        out.push({ ...base, kind: 'tool', tool: 'web_search', text: R(str(own(item, 'query')) ?? '', 200), sessionId: fold.sessionId });
      } else if (itype === 'error' && done) {
        const m = str(own(item, 'message')) ?? '';
        if (m) out.push({ ...base, kind: 'error', text: R(m, 300), sessionId: fold.sessionId });
      }
      break;
    }
    case 'turn.completed': {
      fold.completed = true;
      const u = own(obj, 'usage');
      const n = (k: string) => (typeof own(u, k) === 'number' ? (own(u, k) as number) : undefined);
      fold.usage = { input: n('input_tokens'), cached: n('cached_input_tokens'), output: n('output_tokens') };
      out.push({ ...base, kind: 'result', ok: true, text: R(fold.finalText, 2000), sessionId: fold.sessionId });
      break;
    }
    case 'turn.failed': {
      const m = str(own(own(obj, 'error'), 'message')) ?? str(own(obj, 'message')) ?? 'the turn failed';
      if (fold.errors.length < MAX_ERRORS) fold.errors.push(truncate(m, MAX_ERR));
      out.push({ ...base, kind: 'error', text: R(m, 300), sessionId: fold.sessionId });
      break;
    }
    case 'error': {
      const m = str(own(obj, 'message')) ?? 'error';
      if (fold.errors.length < MAX_ERRORS) fold.errors.push(truncate(m, MAX_ERR));
      out.push({ ...base, kind: 'error', text: R(m, 300), sessionId: fold.sessionId });
      break;
    }
    default:
      break; // unknown event types are ignored
  }
  return out;
}

// ───────────── failure classification ─────────────
const LIMIT_RE = /(usage|rate|spend)\s*limit|hit your (usage )?limit|quota (exceeded|reached)|exceeded (your|the) (plan|limit|usage|quota)|too many requests|out of (usage|credits)/i;
const AUTH_RE = /not logged in|log ?in required|please (log ?in|sign in)|unauthori[sz]ed|authentication (failed|required)|invalid (api key|credentials)|401\b/i;

export type CodexFailure = { kind: 'limit' | 'auth' | 'agent' | 'spawn'; message: string };
/**
 * Only AFTER a structural failure is established (non-zero exit, or a terminal turn.failed/error with no turn.completed) is any text consulted —
 * and then only the CLI-reported structured error messages (each capped at 500 chars), then stderr. A run that exited 0 with turn.completed is
 * never reclassified, whatever the model said.
 */
export function classifyCodexFailure(fold: CodexFold, exitCode: number | null, stderrTail: string): CodexFailure | null {
  const nonZero = exitCode !== 0; // includes "killed by a signal" (null)
  if (!nonZero && fold.completed) return null; // success is never reclassified by prose
  if (!nonZero && fold.errors.length === 0) return null; // a quiet exit 0: not a failure (the parse step decides what the reply is worth)
  // a launcher that cannot start its native program prints a shim error and no CLI events at all: that is a START failure (the chain advances),
  // not an agent failure (which would retry once and then go to a human)
  const noEvents = !fold.sessionId && fold.errors.length === 0 && fold.commands.length === 0 && fold.finalText === '';
  if (nonZero && noEvents && BROKEN_RE.test(stderrTail)) return { kind: 'spawn', message: `Codex is installed but does not start: ${stderrTail.trim()}` };
  const probe = `${fold.errors.join('\n')}\n${truncate(stderrTail, 2000)}`;
  if (LIMIT_RE.test(probe)) return { kind: 'limit', message: probe.trim() };
  if (AUTH_RE.test(probe)) return { kind: 'auth', message: probe.trim() };
  return { kind: 'agent', message: (fold.errors[0] ?? stderrTail ?? '').trim() || `codex exited with code ${exitCode}` };
}

// ───────────── the read-only run ─────────────
export interface CodexCall {
  bin: string;
  cwd: string;
  prompt: string;
  stage: ReadOnlyRunReq['stage'];
  schema?: Schema;
  model?: string;
  /** M8-2: re-checked by codexModelArgs (EFFORT_TOKENS only). */
  effort?: string;
  extraEnv: Record<string, string>;
  idleMs: number;
  hardMs: number;
  signal?: AbortSignal;
  onEvent: (ev: EmitEvent) => void;
  secrets?: string[];
  clock?: ProviderDeps['clock'];
}

export interface CodexSpawn {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  stage: StageName;
  idleMs: number;
  hardMs: number;
  signal?: AbortSignal;
  clock?: ProviderDeps['clock'];
  onEvent?: (ev: EmitEvent) => void;
  secrets?: string[];
}
/** One `codex` process with its JSONL folded into evidence. Shared by the read-only run and the isolation canary (which brings its own args/env). */
export async function spawnCodex(c: CodexSpawn): Promise<{ proc: SpawnResult; fold: CodexFold }> {
  const fold = newCodexFold();
  const proc = await runProcess({
    bin: c.bin, args: c.args, cwd: c.cwd, env: c.env, stdin: c.prompt, idleMs: c.idleMs, hardMs: c.hardMs, signal: c.signal, clock: c.clock,
    onLine: (line, stream) => {
      if (stream !== 'stdout') return;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      for (const ev of normalizeCodexEvent(obj, { stage: c.stage, secrets: c.secrets }, fold)) c.onEvent?.(ev);
    },
  });
  return { proc, fold };
}

export async function runCodexReadOnly(call: CodexCall): Promise<AgentResult> {
  const secrets = call.secrets ?? [];
  return withCodexHomeLock(async () => {
    const home = codexHomePath();
    const check = prepareCodexHome(home, { purge: true });
    if (!check.ok) return { ok: false, text: '', exitCode: null, errorKind: 'isolation', error: `Codex was not started: ${check.problem}.` } as AgentResult;
    const scratchHome = makeScratchHome();
    const tmp = scratchTmp();
    try {
      const outFile = join(tmp.dir, 'last-message.txt');
      const { proc, fold } = await spawnCodex({
        bin: call.bin,
        args: buildCodexArgs({ model: call.model, effort: call.effort, outFile }),
        cwd: call.cwd,
        env: codexEnv({ codexHome: home, home: scratchHome.dir }, call.extraEnv),
        prompt: call.prompt,
        stage: call.stage,
        idleMs: call.idleMs,
        hardMs: call.hardMs,
        signal: call.signal,
        clock: call.clock,
        onEvent: call.onEvent,
        secrets,
      });
      let lastMessage = '';
      try {
        if (existsSync(outFile) && statSync(outFile).size <= 1_000_000) lastMessage = readFileSync(outFile, 'utf8');
      } catch {
        lastMessage = '';
      }
      const finalText = lastMessage.trim() || fold.finalText;
      const base: AgentResult = { ok: false, text: truncate(redact(finalText, secrets), 20000), sessionId: fold.sessionId, exitCode: proc.code };
      if (proc.spawnError) return { ...base, errorKind: 'spawn', error: `could not start codex: ${truncate(redact(proc.spawnError, secrets), 300)}` };
      if (proc.aborted) return { ...base, errorKind: 'aborted', error: 'aborted' };
      if (proc.timedOut) return { ...base, errorKind: proc.timedOut === 'idle' ? 'timeout_idle' : 'timeout_hard', error: `codex timed out (${proc.timedOut})` };
      const failure = classifyCodexFailure(fold, proc.code, proc.stderrTail);
      if (failure) {
        const msg = truncate(redact(failure.message, secrets), failure.kind === 'agent' ? 500 : 300);
        if (failure.kind === 'limit') return { ...base, errorKind: 'limit', error: msg, limit: { provider: 'codex', resetsAt: null, kind: 'unknown', message: msg } };
        if (failure.kind === 'auth') return { ...base, errorKind: 'auth', error: `${msg} — Codex is not signed in to Conductor's private home. Run: CODEX_HOME=<your Conductor data folder>/providers/codex-home codex login` };
        return { ...base, errorKind: failure.kind, error: msg };
      }
      if (call.schema) {
        const json = extractJson(finalText);
        if (json === null || json === undefined) return { ...base, errorKind: 'parse', error: 'no JSON object found in the Codex reply' };
        return { ...base, ok: true, json };
      }
      return { ...base, ok: true };
    } finally {
      scratchHome.dispose();
      tmp.dispose();
    }
  });
}

// ───────────── detect / auth (zero quota) ─────────────
export type CodexDetect =
  | { state: 'missing'; detail: string }
  | { state: 'broken-install'; detail: string }
  | { state: 'ok'; version: string; belowMinimum: boolean };


export async function detectCodex(bin: string, extraEnv: Record<string, string> = {}): Promise<CodexDetect> {
  const path = resolveBin(bin);
  if (!path) return { state: 'missing', detail: `"${bin}" was not found on your PATH.` };
  const home = makeScratchHome();
  try {
    const r = await runProcess({ bin: path, args: ['--version'], cwd: home.dir, env: codexEnv({ codexHome: codexHomePath(), home: home.dir }, extraEnv), idleMs: 20_000, hardMs: 20_000 });
    const text = `${r.stdoutTail}\n${r.stderrTail}`;
    if (r.spawnError || r.code !== 0) {
      if (r.spawnError || BROKEN_RE.test(text) || r.code !== 0) return { state: 'broken-install', detail: truncate(redact(`${r.spawnError ?? ''} ${text}`.trim(), []), 300) };
    }
    const m = /(\d+\.\d+\.\d+)/.exec(r.stdoutTail);
    if (!m) return { state: 'broken-install', detail: truncate(redact(text.trim() || 'the program printed no version', []), 300) };
    return { state: 'ok', version: m[1]!, belowMinimum: !versionAtLeast(m[1]!, CODEX_MIN_VERSION) };
  } finally {
    home.dispose();
  }
}

/** `codex login status` against the PRIVATE home — exit code first. */
export async function codexAuth(bin: string, extraEnv: Record<string, string> = {}): Promise<'ok' | 'not-logged-in' | 'unknown'> {
  const path = resolveBin(bin);
  if (!path) return 'unknown';
  // `login status` only READS the credential: it must NOT wait for the per-home lock (a plan stage can hold it for 20 minutes, which hung
  // the dashboard's health refresh — security review F-2). It also never purges (a run may be using the home).
  const check = prepareCodexHome(undefined, { purge: false });
  if (!check.ok) return 'unknown';
  const home = makeScratchHome();
  try {
    const r = await runProcess({ bin: path, args: ['login', 'status'], cwd: home.dir, env: codexEnv({ codexHome: codexHomePath(), home: home.dir }, extraEnv), idleMs: 20_000, hardMs: 20_000 });
    if (r.spawnError || r.timedOut) return 'unknown';
    return r.code === 0 ? 'ok' : r.code === 1 ? 'not-logged-in' : 'unknown';
  } finally {
    home.dispose();
  }
}

const minutes = (n: number) => n * 60_000;

export function codexProvider(d0: ProviderDeps): Provider {
  const d = d0;
  return {
    id: 'codex',
    label: PROVIDER_LABEL.codex,
    async detect(cfg: Config): Promise<DetectResult> {
      const d = await detectCodex(cfg.agents.codex.bin, d0.extraEnv);
      if (d.state === 'ok') return { state: 'ok', version: d.version, belowMinimum: d.belowMinimum };
      return { state: d.state, detail: d.detail };
    },
    async auth(cfg: Config): Promise<AuthResult> {
      const state = await codexAuth(cfg.agents.codex.bin, d0.extraEnv);
      return { state, detail: state === 'ok' ? "Signed in (Conductor's private Codex home)" : state === 'not-logged-in' ? "Not signed in to Conductor's private Codex home." : 'Sign-in state unknown.' };
    },
    async selfTest(cfg: Config, level: SelfTestLevel): Promise<SelfTestResult> {
      const d = await this.detect(cfg);
      const a = d.state === 'ok' ? await this.auth(cfg) : null;
      const cheap = cheapSelfTest(d, a);
      if (level === 'cheap' || !cheap.ok) return { ...cheap, level };
      const { runCodexCanary } = await import('./canary.ts'); // the isolation check (spends quota); loaded lazily — canary.ts imports this module
      const rep = await runCodexCanary({ bin: cfg.agents.codex.bin, extraEnv: d0.extraEnv });
      return { level, state: 'ok', ok: rep.verdict === 'pass', detail: `Isolation check: ${rep.verdict}` };
    },
    async runReadOnly(req: ReadOnlyRunReq) {
      const cfg = d.getConfig();
      const bin = resolveBin(cfg.agents.codex.bin);
      if (!bin) return { ok: false, text: '', exitCode: null, errorKind: 'spawn' as const, error: `Codex CLI "${cfg.agents.codex.bin}" not found. Install it (npm i -g @openai/codex), then sign in to Conductor's private home (see docs/TROUBLESHOOTING.md).` };
      const key = req.stage === 'plan' ? 'plan' : req.stage === 'plan_review' ? 'review' : 'verify';
      const sel = req.sel && req.sel.tool === 'codex' ? req.sel : toolDefaultResolved(cfg, 'codex'); // a selection for another tool is never applied here (CR-N2)
      return runCodexReadOnly({
        bin, cwd: req.cwd, prompt: req.prompt, stage: req.stage, schema: req.schema, model: sel.modelArg, effort: sel.effortArg, extraEnv: d.extraEnv,
        idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(cfg.pipeline.timeoutsMin[key]),
        signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: d.clock,
      });
    },
    // no `build`: Codex cannot write code in M2 — by construction, not by flag
  };
}

// ───────────── what the install looks like NOW (for validating stored canary results) ─────────────
const shaCache = new Map<string, { sig: string; sha: string | null }>();
export const CODEX_ARGV_DIGEST = (): string => sha256(JSON.stringify(buildCodexArgs({ outFile: '<out>' })));
export function binarySha(bin: string): string | null {
  const path = resolveBin(bin);
  if (!path) return null;
  try {
    const st = statSync(path);
    const sig = `${st.size}:${st.mtimeMs}`;
    const hit = shaCache.get(path);
    if (hit && hit.sig === sig) return hit.sha;
    const sha = st.size < 200 * 1024 * 1024 ? sha256(readFileSync(path)) : null;
    shaCache.set(path, { sig, sha });
    return sha;
  } catch {
    return null;
  }
}
/** null when the installed version is not known (no recent health): a stored pass then does not count. */
export function currentCodexBinding(bin: string, cliVersion: string | undefined, canaryVersion: number): VerificationBinding | null {
  if (!cliVersion) return null;
  const v = /(\d+\.\d+\.\d+)/.exec(cliVersion)?.[1];
  if (!v) return null;
  return { cliVersion: v, binSha256: binarySha(bin), argvDigest: CODEX_ARGV_DIGEST(), privateConfigSha: sha256(CODEX_CONFIG_TOML), canaryVersion };
}
