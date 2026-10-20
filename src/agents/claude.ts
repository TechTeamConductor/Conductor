import type { AgentResult, LogEvent, StageName } from '../types.ts';
import { redact } from '../redact.ts';
import { truncate, type Clock } from '../util.ts';
import { extractJson, type Schema } from './json.ts';
import { runProcess } from './spawn.ts';
import { BROKEN_RE, NETWORK_RE } from './providers/probe.ts';

export type EmitEvent = Omit<LogEvent, 'seq' | 'ts'>;

/** The ONLY tools a Conductor Claude stage may have (B1: StructuredOutput appears when --json-schema is used). */
export const CLAUDE_EXPECTED_TOOLS = ['Glob', 'Grep', 'Read', 'StructuredOutput'] as const;

/** Credential-shaped files a read-only Claude stage must not open (security review M5). */
export const CLAUDE_DENIED_READS = ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/id_rsa*)', 'Read(**/id_ed25519*)', 'Read(**/.npmrc)', 'Read(**/.aws/**)', 'Read(**/.ssh/**)'] as const;

export interface AgentCallBase {
  bin: string;
  cwd: string;
  prompt: string;
  stage: StageName;
  name: string;
  env: Record<string, string>;
  idleMs: number;
  hardMs: number;
  signal?: AbortSignal;
  onEvent: (ev: EmitEvent) => void;
  secrets?: string[];
  model?: string;
  clock?: Clock;
  graceMs?: number;
  tickMs?: number;
}
export interface ClaudeCall extends AgentCallBase {
  schema?: Schema;
  maxTurns: number;
  isolation: 'safe-mode' | 'setting-sources';
  /** `research`: web tools only (WebSearch, WebFetch), no file tools. Verified live against the real CLI. */
  profile?: 'research';
}

export function buildClaudeArgs(c: Pick<ClaudeCall, 'schema' | 'maxTurns' | 'isolation' | 'name' | 'model' | 'profile'>): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    ...(c.isolation === 'safe-mode' ? ['--safe-mode'] : ['--setting-sources', 'project,local']),
    '--tools', c.profile === 'research' ? 'WebSearch,WebFetch' : 'Read,Grep,Glob',
    ...(c.profile === 'research' ? ['--allowedTools', 'WebSearch', 'WebFetch'] : []),
    // M5: the read-only stages still have Read — keep credential files out of reach (the reply is posted on the card)
    '--disallowedTools', ...CLAUDE_DENIED_READS,
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--max-turns', String(c.maxTurns),
    '-n', c.name,
  ];
  if (c.model) args.push('--model', c.model);
  if (c.schema) args.push('--json-schema', JSON.stringify(c.schema));
  return args;
}

/**
 * B1 fail-closed predicate. `plugins`/`agents` are informational (safe-mode lists installed-but-disabled plugins).
 * Returns ok:false with a reason when the session is NOT the locked-down read-only one we asked for.
 */
export function checkClaudeInit(init: any, opts: { expectStructuredOutput?: boolean; profile?: 'research' } = {}): { ok: boolean; reason?: string } {
  if (!init || typeof init !== 'object') return { ok: false, reason: 'no init event' };
  const tools: string[] = Array.isArray(init.tools) ? init.tools.map(String) : [];
  const research = opts.profile === 'research';
  // exact tool sets per profile: plan/review/verify = file tools only; research = web tools only (never both, never anything else)
  const allowed = new Set<string>(research ? ['WebSearch', 'WebFetch', 'StructuredOutput'] : CLAUDE_EXPECTED_TOOLS);
  const extra = tools.filter((t) => !allowed.has(t));
  if (extra.length) return { ok: false, reason: `unexpected tools present: ${extra.slice(0, 6).join(', ')}` };
  for (const must of research ? ['WebSearch', 'WebFetch'] : ['Read', 'Grep', 'Glob']) if (!tools.includes(must)) return { ok: false, reason: `expected tool missing: ${must}` };
  if (opts.expectStructuredOutput && !tools.includes('StructuredOutput')) return { ok: false, reason: 'StructuredOutput tool missing' };
  const mcp = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  if (mcp.length) return { ok: false, reason: `MCP servers present: ${mcp.map((m: any) => m?.name).filter(Boolean).slice(0, 4).join(', ')}` };
  const skills = Array.isArray(init.skills) ? init.skills : [];
  if (skills.length) return { ok: false, reason: `skills present: ${skills.slice(0, 4).join(', ')}` };
  const slash = Array.isArray(init.slash_commands) ? init.slash_commands : [];
  if (slash.length) return { ok: false, reason: `slash commands present: ${slash.slice(0, 4).join(', ')}` };
  if (init.permissionMode !== 'dontAsk') return { ok: false, reason: `permissionMode is ${String(init.permissionMode)} (expected dontAsk)` };
  return { ok: true };
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as any).text) : '')).join('\n');
  return '';
}

function summarizeInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return name;
  const v = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query ?? '';
  return `${name} ${String(v)}`.trim();
}

export interface ClaudeNormCtx {
  stage: StageName;
  secrets?: string[];
}

/** Map one raw stream-json object to zero or more normalised log events. */
export function normalizeClaudeEvent(obj: any, ctx: ClaudeNormCtx): EmitEvent[] {
  const out: EmitEvent[] = [];
  const base = { agent: 'claude' as const, stage: ctx.stage };
  const R = (s: string, n = 600) => truncate(redact(s, ctx.secrets ?? []), n);
  if (!obj || typeof obj !== 'object') return out;
  const sid: string | undefined = typeof obj.session_id === 'string' ? obj.session_id : undefined;
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') out.push({ ...base, kind: 'system', text: `Claude session started${obj.model ? ` (${obj.model})` : ''}`, sessionId: sid });
      break;
    case 'assistant': {
      const blocks: any[] = Array.isArray(obj.message?.content) ? obj.message.content : [];
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) out.push({ ...base, kind: 'text', text: R(String(b.text), 4000), sessionId: sid });
        else if (b?.type === 'thinking' && b.thinking) out.push({ ...base, kind: 'thinking', text: R(String(b.thinking), 400), sessionId: sid });
        else if (b?.type === 'tool_use') out.push({ ...base, kind: 'tool', tool: String(b.name), text: R(summarizeInput(String(b.name), b.input), 300), sessionId: sid });
      }
      break;
    }
    case 'user': {
      const blocks: any[] = Array.isArray(obj.message?.content) ? obj.message.content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_result') {
          out.push({ ...base, kind: 'tool_result', ok: !b.is_error, text: R(contentText(b.content), 240), sessionId: sid });
        }
      }
      break;
    }
    case 'result':
      out.push({ ...base, kind: 'result', ok: !obj.is_error, text: R(String(obj.result ?? ''), 2000), sessionId: sid });
      break;
    default:
      break;
  }
  return out;
}

export interface ClaudeStreamState {
  init: any | null;
  result: any | null;
  limit: { resetsAt: number | null; kind?: string; message?: string } | null;
  quota: AgentResult['quota'] | null;
  sessionId?: string;
}

/** Fold the rate-limit event shape observed on a real account into state. */
export function foldRateLimit(state: ClaudeStreamState, obj: any): void {
  const info = obj?.rate_limit_info;
  if (!info || typeof info !== 'object') return;
  const w = info.unifiedWindows ?? {};
  state.quota = {
    utilization7d: typeof w.seven_day?.utilization === 'number' ? w.seven_day.utilization : undefined,
    utilization5h: typeof w.five_hour?.utilization === 'number' ? w.five_hour.utilization : undefined,
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : undefined,
    status: typeof info.status === 'string' ? info.status : undefined,
  };
  if (info.status === 'rejected') {
    state.limit = {
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
      kind: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
    };
  }
}

export async function runClaude(call: ClaudeCall): Promise<AgentResult> {
  const state: ClaudeStreamState = { init: null, result: null, limit: null, quota: null };
  const observed = { read: new Set<string>(), listed: new Set<string>(), queries: [] as string[] };
  const toolNames = new Map<string, string>();
  const ac = new AbortController();
  let isolationViolation: string | null = null;
  const onExternalAbort = () => ac.abort();
  call.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (call.signal?.aborted) ac.abort();

  const proc = await runProcess({
    bin: call.bin,
    args: buildClaudeArgs(call),
    cwd: call.cwd,
    env: call.env,
    stdin: call.prompt,
    idleMs: call.idleMs,
    hardMs: call.hardMs,
    signal: ac.signal,
    clock: call.clock,
    graceMs: call.graceMs,
    tickMs: call.tickMs,
    onLine: (line, stream) => {
      if (stream !== 'stdout') return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof obj?.session_id === 'string') state.sessionId = obj.session_id;
      if (obj.type === 'system' && obj.subtype === 'init') {
        state.init = obj;
        const chk = checkClaudeInit(obj, { expectStructuredOutput: !!call.schema, profile: call.profile });
        if (!chk.ok) {
          isolationViolation = chk.reason ?? 'isolation check failed';
          call.onEvent({ agent: 'claude', stage: call.stage, kind: 'error', text: `Isolation check failed — stopping: ${isolationViolation}` });
          ac.abort();
        }
      } else if (obj.type === 'rate_limit_event') foldRateLimit(state, obj);
      else if (obj.type === 'result') state.result = obj;
      if (call.profile === 'research') {
        // structured tool events only — never URLs found in fetched page text or in the model's own words
        const blocks = Array.isArray(obj?.message?.content) ? obj.message.content : [];
        for (const b of blocks) {
          if (obj.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string') {
            toolNames.set(b.id, String(b.name));
            if (b.name === 'WebFetch' && typeof b.input?.url === 'string') observed.read.add(b.input.url);
            if (b.name === 'WebSearch' && typeof b.input?.query === 'string' && observed.queries.length < 50) observed.queries.push(b.input.query.slice(0, 300));
          } else if (obj.type === 'user' && b?.type === 'tool_result' && toolNames.get(String(b.tool_use_id)) === 'WebSearch') {
            const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => String(x?.text ?? '')).join('\n') : '';
            for (const m of text.matchAll(/"url"\s*:\s*"(https?:\/\/[^"\s]+)"/g)) if (observed.listed.size < 200) observed.listed.add(m[1]!);
          }
        }
      }
      for (const ev of normalizeClaudeEvent(obj, { stage: call.stage, secrets: call.secrets })) call.onEvent(ev);
    },
  });
  call.signal?.removeEventListener('abort', onExternalAbort);

  const r = state.result;
  const base: AgentResult = {
    ok: false,
    text: truncate(redact(String(r?.result ?? ''), call.secrets ?? []), 20000),
    sessionId: (r?.session_id as string | undefined) ?? state.sessionId,
    costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
    model: typeof state.init?.model === 'string' ? state.init.model : undefined,
    cliVersion: typeof state.init?.claude_code_version === 'string' ? state.init.claude_code_version : undefined,
    turns: typeof r?.num_turns === 'number' ? r.num_turns : undefined,
    exitCode: proc.code,
    quota: state.quota ?? undefined,
    observed: call.profile === 'research' ? { read: [...observed.read].slice(0, 100), listed: [...observed.listed].slice(0, 200), queries: observed.queries } : undefined,
  };

  if (proc.spawnError) return { ...base, errorKind: 'spawn', error: `could not start claude: ${proc.spawnError}` };
  if (isolationViolation) return { ...base, errorKind: 'isolation', error: `Isolation check failed: ${isolationViolation}` };
  if (proc.aborted) return { ...base, errorKind: 'aborted', error: 'aborted' };
  if (proc.timedOut) return { ...base, errorKind: proc.timedOut === 'idle' ? 'timeout_idle' : 'timeout_hard', error: `claude timed out (${proc.timedOut})` };

  const apiErr = r?.api_error;
  if (state.limit || apiErr === 'usage_limit_reached' || (r?.is_error && /weekly limit|usage limit|limit reached/i.test(String(r?.result ?? '')))) {
    return {
      ...base,
      errorKind: 'limit',
      error: String(r?.result ?? 'usage limit reached'),
      limit: {
        provider: 'claude',
        resetsAt: state.limit?.resetsAt ?? state.quota?.resetsAt ?? null,
        kind: state.limit?.kind,
        message: truncate(String(r?.result ?? 'Claude usage limit reached'), 300),
      },
    };
  }
  if (r?.subtype === 'error_max_turns') return { ...base, errorKind: 'max_turns', error: 'claude hit the max-turns cap' };
  if (!r) {
    // a launcher that cannot start its program prints a shim error and no events: a START failure (the chain may advance), not an agent failure
    if (proc.code !== 0 && BROKEN_RE.test(proc.stderrTail)) return { ...base, errorKind: 'spawn', error: `claude is installed but does not start: ${truncate(redact(proc.stderrTail, call.secrets ?? []).trim(), 400)}` };
    if (proc.code !== 0 && NETWORK_RE.test(proc.stderrTail)) return { ...base, errorKind: 'network', error: `claude could not reach the network: ${truncate(redact(proc.stderrTail, call.secrets ?? []).trim(), 300)}` };
    return { ...base, errorKind: 'agent', error: `claude exited without a result (code ${proc.code}). ${truncate(redact(proc.stderrTail, call.secrets ?? []).trim(), 400)}` };
  }
  if (r.is_error) return { ...base, errorKind: 'agent', error: truncate(String(r.result ?? 'claude reported an error'), 500) };

  let json: unknown = r.structured_output;
  if (json === undefined && call.schema) json = extractJson(String(r.result ?? '')) ?? undefined;
  if (call.schema && (json === undefined || json === null)) {
    return { ...base, errorKind: 'parse', error: 'no structured output found in the Claude result' };
  }
  return { ...base, ok: true, json };
}
