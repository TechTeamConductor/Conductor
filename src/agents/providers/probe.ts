// Shared zero-quota helpers for the provider adapters: one CLI invocation with a hard 20 s bound, and the one place that turns
// "detect + auth" into a self-test result in the common vocabulary.
import { runProcess } from '../spawn.ts';
import type { AuthResult, DetectResult, SelfTestResult } from './types.ts';

export async function cliOut(bin: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; spawnError?: string }> {
  const r = await runProcess({ bin, args, cwd: process.cwd(), env, idleMs: 20_000, hardMs: 20_000 });
  return { code: r.code, out: (r.stdoutTail + r.stderrTail).trim(), spawnError: r.spawnError };
}

/** The launcher exists but the program does not run (a missing native binary, a missing module …). */
export const BROKEN_RE = /cannot find module|native binary|enoent|vendor|no such file|not found|missing optional dependency/i;

/** Network failures as a CLI itself reports them on stderr (structural failures only — never model prose, never a completed turn). */
export const NETWORK_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network error|unable to connect|socket hang up/i;

/** `--version` outcome → DetectResult (common to every adapter). */
export function detectFromVersion(r: { code: number | null; out: string; spawnError?: string }): DetectResult {
  if (r.spawnError || r.code !== 0) return { state: 'broken-install', detail: r.spawnError ?? (r.out || `exited with code ${r.code}`) };
  const first = r.out.split('\n')[0]?.slice(0, 60) ?? '';
  const m = /(\d+(?:\.\d+)+)/.exec(first);
  if (!m) return { state: 'broken-install', detail: r.out || 'the program printed no version' };
  return { state: 'ok', version: first };
}

/** Zero-quota self test: detection then sign-in. Never a model call. */
export function cheapSelfTest(d: DetectResult, a: AuthResult | null): SelfTestResult {
  if (d.state === 'missing') return { level: 'cheap', state: 'missing', ok: false, detail: d.detail ?? 'not found' };
  if (d.state === 'broken-install') return { level: 'cheap', state: 'broken-install', ok: false, detail: d.detail ?? 'does not start' };
  if (!a || a.state === 'unknown') return { level: 'cheap', state: 'unknown', ok: false, detail: a?.detail ?? 'sign-in state unknown' };
  if (a.state === 'not-logged-in') return { level: 'cheap', state: 'not-logged-in', ok: false, detail: a.detail ?? 'not signed in' };
  return { level: 'cheap', state: 'ok', ok: true, detail: a.detail ?? 'ok' };
}
