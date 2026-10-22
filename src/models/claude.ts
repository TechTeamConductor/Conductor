// Claude model discovery (M8-1 §2.2, Security S1–S3, S6): `claude -p` in stream-json mode, ONE `initialize` control request on stdin,
// then EOF. No prompt is ever written, so no model turn runs and no quota is spent. Only `response.response.models` and
// `response.response.account` are read from the reply; the rest of the object (commands, agents, pid, …) is dropped right here and never
// reaches a log, a reason, the cache or the API (S2). `stdoutTail` is never used for text.
import type { SpawnOpts, SpawnResult } from '../agents/spawn.ts';
import type { DiscoveryOutcome, ModelEntry } from './types.ts';
import { MAX_MODELS, LABEL_MAX, cleanEfforts, cleanId, cleanPlan, cleanText, cleanVersion, isObj, own, scrubIdentity } from './sanitize.ts';
import { assertClaudeConfigDirSafe, ClaudeSettingsError } from '../agents/claude-settings.ts';

/** The constant discovery argv (B5a pins it exactly). `--no-session-persistence` is mandatory (S6); `--safe-mode` always (N4). */
export const CLAUDE_DISCOVERY_ARGS: readonly string[] = Object.freeze([
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--safe-mode',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
]);
export const CLAUDE_REQUEST_ID = 'r1';
/** The only bytes ever written to the child's stdin. */
export const CLAUDE_INIT_LINE = JSON.stringify({ type: 'control_request', request_id: CLAUDE_REQUEST_ID, request: { subtype: 'initialize' } }) + '\n';

export const DISCOVERY_MAX_BYTES = 2 * 1024 * 1024;
export const DISCOVERY_MAX_LINE = 512 * 1024;

/** S1: any of these means a session/turn started — kill, unavailable, nothing cached, no retry. */
const TURN_TYPES = new Set(['assistant', 'user', 'result', 'stream_event', 'rate_limit_event']);
export function isTurnEvent(o: unknown): boolean {
  const t = own(o, 'type');
  if (typeof t !== 'string') return false;
  if (TURN_TYPES.has(t)) return true;
  return t === 'system' && own(o, 'subtype') === 'init';
}

export const CLAUDE_REASONS = {
  turn: 'Claude started a session during model discovery; discovery stopped',
  tooLarge: 'the reply was too large',
  shape: 'this Claude Code version answered in an unexpected shape',
  timeout: 'Claude Code did not answer within 15 seconds',
  spawn: 'Claude Code could not be started',
  refusedRequest: 'Claude Code refused the model list request',
  noReply: 'Claude Code ended without listing its models',
} as const;

export interface ParsedClaudeReply {
  models: ModelEntry[];
  dropped: number;
  signedIn: boolean | null;
  plan?: string;
  cliVersion: string | null;
  identity: string[];
}

/**
 * Parse the inner `response.response` object field by field (S8). Returns null when the shape is wrong (no `models` array, or an
 * entry without a string `value`): the caller reports `unavailable`, never an invented list.
 */
export function parseClaudeInitialize(inner: unknown): ParsedClaudeReply | null {
  if (!isObj(inner)) return null;
  const rawModels = own(inner, 'models');
  if (!Array.isArray(rawModels)) return null;
  const identity: string[] = [];
  const account = own(inner, 'account');
  let signedIn: boolean | null = null;
  let plan: string | undefined;
  if (isObj(account)) {
    const email = own(account, 'email');
    const org = own(account, 'organization');
    if (typeof email === 'string' && email) identity.push(email);
    if (typeof org === 'string' && org) identity.push(org);
    const tokenSource = own(account, 'tokenSource');
    if (typeof email === 'string' && email.length > 0) signedIn = true;
    else if (typeof tokenSource === 'string') signedIn = tokenSource !== 'none';
    else signedIn = false;
    plan = cleanPlan(own(account, 'subscriptionType'));
  }
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const m of rawModels) {
    const value = own(m, 'value');
    if (typeof value !== 'string') return null; // version guard: an entry without a string `value` is an unexpected shape
    if (models.length >= MAX_MODELS) {
      dropped++;
      continue;
    }
    const id = cleanId(value, 'claude');
    if (!id || seen.has(id)) {
      dropped++;
      continue;
    }
    seen.add(id);
    const e: ModelEntry = { id, label: cleanText(own(m, 'displayName'), LABEL_MAX) || id };
    const resolved = cleanId(own(m, 'resolvedModel'), 'claude');
    if (resolved) e.resolved = resolved;
    const efforts = cleanEfforts(own(m, 'supportedEffortLevels'));
    if (efforts.length) e.efforts = efforts;
    if (value === 'default') e.isDefault = true;
    if (own(m, 'supportsFastMode') === true) e.fast = true;
    if (own(m, 'supportsAdaptiveThinking') === true) e.adaptiveThinking = true;
    if (own(m, 'supportsThinkingOff') === true) e.thinkingOff = true;
    models.push(e);
  }
  return { models, dropped, signedIn, ...(plan ? { plan } : {}), cliVersion: cleanVersion(own(inner, 'claude_code_version')), identity };
}

export interface DiscoveryRunCtx {
  bin: string;
  cwd: string;
  env: Record<string, string>;
  spawn: (o: SpawnOpts) => Promise<SpawnResult>;
  timeoutMs: number;
  /** Aborted by ModelService.stop(). */
  signal: AbortSignal;
  graceMs?: number;
}

/** One discovery run. The child is killed as soon as the matching reply is parsed (S1) or a turn event shows up. */
export async function discoverClaude(ctx: DiscoveryRunCtx): Promise<DiscoveryOutcome> {
  const ac = new AbortController();
  const onStop = () => ac.abort();
  if (ctx.signal.aborted) ac.abort();
  else ctx.signal.addEventListener('abort', onStop, { once: true });
  let parsed: ParsedClaudeReply | null | undefined; // undefined = no matching reply yet; null = matching reply, wrong shape
  let refused = false;
  let turn = false;
  let lineOverflow = false;
  const stderr: string[] = [];
  let stderrBytes = 0;
  let result: SpawnResult;
  try {
    // F1-C: discovery uses an empty cwd (A N/A) but still reads the config dir
    try {
      assertClaudeConfigDirSafe(ctx.env);
    } catch (e) {
      if (e instanceof ClaudeSettingsError) return { ok: false, kind: 'refused', reason: e.message, identity: [] };
      throw e;
    }
    result = await ctx.spawn({
      bin: ctx.bin,
      args: [...CLAUDE_DISCOVERY_ARGS],
      cwd: ctx.cwd,
      env: ctx.env,
      stdin: CLAUDE_INIT_LINE,
      idleMs: ctx.timeoutMs,
      hardMs: ctx.timeoutMs,
      graceMs: ctx.graceMs,
      maxOutputBytes: DISCOVERY_MAX_BYTES,
      signal: ac.signal,
      onLine: (line, stream) => {
        if (turn || lineOverflow || parsed !== undefined || refused) return;
        if (line.length > DISCOVERY_MAX_LINE) {
          lineOverflow = true;
          ac.abort();
          return;
        }
        if (stream === 'stderr') {
          if (stderrBytes < 8 * 1024) {
            stderr.push(line.slice(0, 2048));
            stderrBytes += Math.min(line.length, 2048);
          }
          return;
        }
        let o: unknown;
        try {
          o = JSON.parse(line);
        } catch {
          return; // non-JSON stdout lines are ignored
        }
        if (isTurnEvent(o)) {
          turn = true;
          ac.abort();
          return;
        }
        if (own(o, 'type') !== 'control_response') return;
        const resp = own(o, 'response');
        if (own(resp, 'request_id') !== CLAUDE_REQUEST_ID) return; // not our request
        if (own(resp, 'subtype') !== 'success') {
          refused = true;
          ac.abort();
          return;
        }
        parsed = parseClaudeInitialize(own(resp, 'response')); // the rest of the object is dropped here (S2)
        ac.abort(); // S1: do not wait for a natural exit
      },
    });
  } finally {
    ctx.signal.removeEventListener('abort', onStop);
  }
  const identity = parsed ? parsed.identity : [];
  // R2-5: overflow is final, even if a valid reply arrived first
  if (result.overflow || lineOverflow) return { ok: false, kind: 'too-large', reason: CLAUDE_REASONS.tooLarge, identity };
  if (turn) return { ok: false, kind: 'turn', reason: CLAUDE_REASONS.turn, identity };
  if (parsed) {
    return { ok: true, source: 'claude-initialize', cliVersion: parsed.cliVersion, signedIn: parsed.signedIn, ...(parsed.plan ? { plan: parsed.plan } : {}), models: parsed.models, dropped: parsed.dropped, identity };
  }
  if (parsed === null) return { ok: false, kind: 'shape', reason: CLAUDE_REASONS.shape, identity };
  if (refused) return { ok: false, kind: 'failed', reason: CLAUDE_REASONS.refusedRequest, identity };
  if (result.spawnError) return { ok: false, kind: 'spawn', reason: CLAUDE_REASONS.spawn, identity };
  if (result.timedOut) return { ok: false, kind: 'timeout', reason: CLAUDE_REASONS.timeout, identity };
  if (ctx.signal.aborted) return { ok: false, kind: 'failed', reason: 'discovery was stopped', identity };
  // S2: only stderr may add detail, scrubbed (S3) and bounded
  const detail = scrubIdentity(stderr.join(' '), identity, 120);
  return { ok: false, kind: 'failed', reason: detail ? `${CLAUDE_REASONS.noReply}: ${detail}` : CLAUDE_REASONS.noReply, identity };
}
