// Cursor model discovery (M8-1 §2.2, S16): `agent --list-models`, no stdin. Lines of the form `id - Label` are models; the header,
// blank and "Tip:" lines are ignored. Label flags "(current, default)" and "(NO ZDR)" become fields. Reasons are static text (S16): the
// CLI's own words are never echoed.
import type { SpawnResult } from '../agents/spawn.ts';
import type { DiscoveryOutcome, ModelEntry } from './types.ts';
import { DISCOVERY_MAX_BYTES, DISCOVERY_MAX_LINE, type DiscoveryRunCtx } from './claude.ts';
import { LABEL_MAX, MAX_MODELS, cleanId, cleanText } from './sanitize.ts';

export const CURSOR_DISCOVERY_ARGS: readonly string[] = Object.freeze(['--list-models']);
const LINE_RE = /^([^\s]+) - ([\s\S]+)$/; // O(n) match; the label part may hold any character (it is cleaned)
const AUTH_RE = /Authentication required/i;

export const CURSOR_REASONS = {
  signIn: 'Sign in to Cursor to see its models',
  tooLarge: 'the reply was too large',
  timeout: 'the Cursor agent did not answer within 15 seconds',
  spawn: 'the Cursor agent could not be started',
  empty: 'the Cursor agent listed no models',
  failed: 'the Cursor agent could not list its models',
} as const;

export interface ParsedCursorList {
  models: ModelEntry[];
  dropped: number;
  ignored: number;
}

/** Pure parser over the stdout lines. */
export function parseCursorList(lines: readonly string[]): ParsedCursorList {
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let ignored = 0;
  for (const raw of lines) {
    // matched on the RAW line (bounded): the id must be exactly what Cursor listed (W4: narrow rule, no repair); only the label is cleaned
    const m = LINE_RE.exec(raw.length > 4096 ? raw.slice(0, 4096) : raw);
    if (!m) {
      ignored++;
      continue;
    }
    if (models.length >= MAX_MODELS) {
      dropped++;
      continue;
    }
    const id = cleanId(m[1], 'cursor');
    if (!id || seen.has(id)) {
      dropped++;
      continue;
    }
    seen.add(id);
    let label = cleanText(m[2], 4096);
    let isDefault = false;
    let noZdr = false;
    // flags at the end, in any order
    for (let i = 0; i < 3; i++) {
      const f = /\s*\((current, default|default|current|NO ZDR)\)\s*$/i.exec(label);
      if (!f) break;
      const flag = f[1]!.toLowerCase();
      if (flag === 'no zdr') noZdr = true;
      else if (flag !== 'current') isDefault = true;
      label = label.slice(0, f.index);
    }
    const e: ModelEntry = { id, label: cleanText(label, LABEL_MAX) || id };
    if (isDefault) e.isDefault = true;
    if (noZdr) e.noZdr = true;
    models.push(e);
  }
  return { models, dropped, ignored };
}

export async function discoverCursor(ctx: DiscoveryRunCtx & { cliVersion: string | null }): Promise<DiscoveryOutcome> {
  const ac = new AbortController();
  const onStop = () => ac.abort();
  if (ctx.signal.aborted) ac.abort();
  else ctx.signal.addEventListener('abort', onStop, { once: true });
  const lines: string[] = [];
  let lineOverflow = false;
  // Security code review L3: sign-in is detected from stderr, or from a NON-model stdout line when the exit is non-zero — never from a
  // stdout line shaped like a model entry (a hostile label saying "Authentication required" must not hide the list)
  let authStderr = false;
  let authStdout = false;
  let result: SpawnResult;
  try {
    result = await ctx.spawn({
      bin: ctx.bin,
      args: [...CURSOR_DISCOVERY_ARGS],
      cwd: ctx.cwd,
      env: ctx.env,
      idleMs: ctx.timeoutMs,
      hardMs: ctx.timeoutMs,
      graceMs: ctx.graceMs,
      maxOutputBytes: DISCOVERY_MAX_BYTES,
      signal: ac.signal,
      onLine: (line, stream) => {
        if (lineOverflow) return;
        if (line.length > DISCOVERY_MAX_LINE) {
          lineOverflow = true;
          ac.abort();
          return;
        }
        if (stream === 'stderr') {
          if (AUTH_RE.test(line.slice(0, 2048))) authStderr = true;
          return;
        }
        lines.push(line);
        if (!LINE_RE.test(line.length > 4096 ? line.slice(0, 4096) : line) && AUTH_RE.test(line.slice(0, 2048))) authStdout = true;
      },
    });
  } finally {
    ctx.signal.removeEventListener('abort', onStop);
  }
  const fail = (kind: Extract<DiscoveryOutcome, { ok: false }>['kind'], reason: string): DiscoveryOutcome => ({ ok: false, kind, reason, identity: [] });
  if (result.overflow || lineOverflow) return fail('too-large', CURSOR_REASONS.tooLarge); // R2-5
  if (authStderr || (authStdout && result.code !== 0)) return fail('signed-out', CURSOR_REASONS.signIn);
  if (result.spawnError) return fail('spawn', CURSOR_REASONS.spawn);
  if (result.timedOut) return fail('timeout', CURSOR_REASONS.timeout);
  if (ctx.signal.aborted) return fail('failed', 'discovery was stopped');
  if (result.code !== 0) return fail('failed', `${CURSOR_REASONS.failed} (exit code ${result.code ?? 'none'})`);
  const p = parseCursorList(lines);
  if (!p.models.length) return fail('empty', CURSOR_REASONS.empty); // never an empty "fresh" list
  return { ok: true, source: 'cursor-list-models', cliVersion: ctx.cliVersion, signedIn: true, models: p.models, dropped: p.dropped, identity: [] };
}
