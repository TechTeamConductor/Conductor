import type { AgentResult } from '../types.ts';
import { redact } from '../redact.ts';
import { truncate } from '../util.ts';
import type { AgentCallBase, EmitEvent } from './claude.ts';
import { extractJson, type Schema } from './json.ts';
import { runProcess } from './spawn.ts';
import { BROKEN_RE, NETWORK_RE } from './providers/probe.ts';

export interface CursorCall extends AgentCallBase {
  /** build = writes files (`--force`); ask/plan = read-only modes. */
  mode: 'build' | 'ask' | 'plan';
  schema?: Schema;
}

export function buildCursorArgs(c: Pick<CursorCall, 'mode' | 'cwd' | 'model'>): string[] {
  const args = ['-p'];
  if (c.mode === 'build') args.push('--force');
  else args.push('--mode', c.mode);
  args.push('--trust', '--output-format', 'stream-json', '--workspace', c.cwd);
  if (c.model) args.push('--model', c.model);
  return args;
}

const LIMIT_RE = /(usage|rate|spend)\s*limit|quota (exceeded|reached)|exceeded (your|the) (plan|limit|usage|quota)|too many requests|out of (usage|credits)/i;

export interface CursorNormState {
  thinking: string;
}

function toolKind(tc: any): { name: string; args: any; result: any } | null {
  if (!tc || typeof tc !== 'object') return null;
  const key = Object.keys(tc).find((k) => k.endsWith('ToolCall'));
  if (!key) return null;
  const v = tc[key] ?? {};
  return { name: key.replace(/ToolCall$/, ''), args: v.args ?? {}, result: v.result };
}

function summarizeTool(name: string, args: any): string {
  const v = args?.command ?? args?.path ?? args?.globPattern ?? args?.pattern ?? args?.query ?? args?.url ?? '';
  return `${name} ${String(v)}`.trim();
}

function toolOutcome(name: string, result: any): { ok: boolean; text: string } {
  if (!result) return { ok: true, text: '' };
  if (result.success) {
    const s = result.success;
    if (name === 'edit' || name === 'write') return { ok: true, text: `${s.path ?? ''} +${s.linesAdded ?? s.linesCreated ?? 0} −${s.linesRemoved ?? 0}`.trim() };
    if (name === 'shell') {
      const code = typeof s.exitCode === 'number' ? s.exitCode : 0;
      const out = String(s.stdout ?? s.interleavedOutput ?? '').trim();
      return { ok: code === 0, text: `exit ${code}${out ? ` · ${truncate(out.replace(/\s+/g, ' '), 160)}` : ''}` };
    }
    if (name === 'read') return { ok: true, text: `${s.totalLines ?? '?'} lines` };
    if (name === 'glob') return { ok: true, text: `${s.totalFiles ?? 0} files` };
    return { ok: true, text: '' };
  }
  const err = result.error ?? result.failure ?? result.rejected ?? result.permissionDenied ?? Object.values(result).find((v) => v && typeof v === 'object');
  const reason = typeof err === 'string' ? err : err && typeof err === 'object' && typeof (err as any).error === 'string' ? (err as any).error : JSON.stringify(err ?? result);
  return { ok: false, text: truncate(reason, 200) };
}

export function normalizeCursorEvent(obj: any, ctx: { stage: CursorCall['stage']; secrets?: string[] }, st: CursorNormState): EmitEvent[] {
  const out: EmitEvent[] = [];
  const base = { agent: 'cursor' as const, stage: ctx.stage };
  const R = (s: string, n = 600) => truncate(redact(s, ctx.secrets ?? []), n);
  if (!obj || typeof obj !== 'object') return out;
  const sid: string | undefined = typeof obj.session_id === 'string' ? obj.session_id : undefined;
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') out.push({ ...base, kind: 'system', text: `Cursor session started${obj.model ? ` (${obj.model})` : ''}`, sessionId: sid });
      break;
    case 'thinking':
      if (obj.subtype === 'delta' && typeof obj.text === 'string') st.thinking += obj.text;
      else if (obj.subtype === 'completed') {
        if (st.thinking.trim()) out.push({ ...base, kind: 'thinking', text: R(st.thinking.trim(), 400), sessionId: sid });
        st.thinking = '';
      }
      break;
    case 'assistant': {
      const blocks: any[] = Array.isArray(obj.message?.content) ? obj.message.content : [];
      for (const b of blocks) if (b?.type === 'text' && b.text) out.push({ ...base, kind: 'text', text: R(String(b.text), 4000), sessionId: sid });
      break;
    }
    case 'tool_call': {
      const t = toolKind(obj.tool_call);
      if (!t) break;
      if (obj.subtype === 'started') out.push({ ...base, kind: 'tool', tool: t.name, text: R(summarizeTool(t.name, t.args), 300), sessionId: sid });
      else if (obj.subtype === 'completed') {
        const o = toolOutcome(t.name, t.result);
        out.push({ ...base, kind: 'tool_result', tool: t.name, ok: o.ok, text: R(o.text, 240), sessionId: sid });
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

export async function runCursor(call: CursorCall): Promise<AgentResult> {
  const st: CursorNormState = { thinking: '' };
  let result: any = null;
  let sessionId: string | undefined;
  let model: string | undefined;
  const sawText: string[] = [];

  const proc = await runProcess({
    bin: call.bin,
    args: buildCursorArgs(call),
    cwd: call.cwd,
    env: call.env,
    stdin: call.prompt,
    idleMs: call.idleMs,
    hardMs: call.hardMs,
    signal: call.signal,
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
      if (typeof obj?.session_id === 'string') sessionId = obj.session_id;
      if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.model === 'string') model = obj.model;
      if (obj.type === 'result') result = obj;
      if (obj.type === 'assistant') {
        for (const b of obj.message?.content ?? []) if (b?.type === 'text' && b.text) sawText.push(String(b.text));
      }
      for (const ev of normalizeCursorEvent(obj, { stage: call.stage, secrets: call.secrets }, st)) call.onEvent(ev);
    },
  });

  const secrets = call.secrets ?? [];
  const finalText = String(result?.result ?? sawText.join('\n'));
  const base: AgentResult = {
    ok: false,
    text: truncate(redact(finalText, secrets), 20000),
    sessionId: (result?.session_id as string | undefined) ?? sessionId,
    model,
    exitCode: proc.code,
  };
  if (proc.spawnError) return { ...base, errorKind: 'spawn', error: `could not start agent: ${proc.spawnError}` };
  if (proc.aborted) return { ...base, errorKind: 'aborted', error: 'aborted' };
  if (proc.timedOut) return { ...base, errorKind: proc.timedOut === 'idle' ? 'timeout_idle' : 'timeout_hard', error: `cursor agent timed out (${proc.timedOut})` };

  const failed = !result || result.is_error === true || (proc.code !== 0 && proc.code !== null);
  if (failed) {
    if (!result && proc.code !== 0 && BROKEN_RE.test(proc.stderrTail)) return { ...base, errorKind: 'spawn', error: `cursor agent is installed but does not start: ${truncate(redact(proc.stderrTail, secrets).trim(), 400)}` };
    // M12: classify from what the CLI itself reported (stderr, or a SHORT error result) — never from long model-written prose,
    // which a hostile repo/prompt could use to fake a "limit" and stall every run.
    const probe = `${result?.is_error === true && finalText.length <= 500 ? finalText : ''}\n${proc.stderrTail}`;
    if (LIMIT_RE.test(probe)) {
      return {
        ...base,
        errorKind: 'limit',
        error: truncate(redact(probe.trim(), secrets), 300),
        limit: { provider: 'cursor', resetsAt: null, kind: 'unknown', message: truncate(redact(probe.trim(), secrets), 300) },
      };
    }
    if (!result && NETWORK_RE.test(proc.stderrTail)) return { ...base, errorKind: 'network', error: `cursor could not reach the network: ${truncate(redact(proc.stderrTail, secrets).trim(), 300)}` };
    return {
      ...base,
      errorKind: 'agent',
      error: truncate(redact((proc.stderrTail || finalText || `agent exited with code ${proc.code}`).trim(), secrets), 500),
    };
  }
  if (call.schema) {
    const json = extractJson(finalText);
    if (json === null || json === undefined) return { ...base, errorKind: 'parse', error: 'no JSON object found in the Cursor reply' };
    return { ...base, ok: true, json };
  }
  return { ...base, ok: true };
}
