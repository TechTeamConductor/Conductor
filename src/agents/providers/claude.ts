// The Claude adapter: read-only only. A thin shell over the existing runner — argv and the fail-closed init predicate are untouched.
import { resolveBin } from '../../config.ts';
import { claudeEnv } from '../env.ts';
import { runClaude } from '../claude.ts';
import { PROVIDER_LABEL, type AuthResult, type Provider, type ProviderDeps, type ReadOnlyRunReq, type ResearchRunReq, type SelfTestLevel, type SelfTestResult } from './types.ts';
import { cheapSelfTest, cliOut, detectFromVersion } from './probe.ts';
import type { Config } from '../../types.ts';
import { toolDefaultResolved } from '../../models/select.ts';
import { childEnv } from '../../accounts/env.ts';

const minutes = (n: number) => n * 60_000;
/** M5 ceiling for any research session's `--max-turns` (Security S14: asserted below). */
export const RESEARCH_MAX_TURNS_CEILING = 60;
/**
 * Deep Research depth (M8-6, user decision Q-C): code constants, never config. Standard = today's exact argv (30 turns / 20 min). Deep
 * differs ONLY in `--max-turns` and the wall clock. Worst case with the one schema re-run is 2 × (turns, minutes) — stated in the docs.
 */
export const RESEARCH_DEPTH = Object.freeze({
  standard: Object.freeze({ maxTurns: 30, hardMin: 20 }),
  deep: Object.freeze({ maxTurns: 50, hardMin: 35 }),
});
for (const d of Object.values(RESEARCH_DEPTH)) if (d.maxTurns > RESEARCH_MAX_TURNS_CEILING) throw new Error('research --max-turns above the ceiling');

export function claudeProvider(d: ProviderDeps): Provider {
  return {
    id: 'claude',
    label: PROVIDER_LABEL.claude,
    async detect(cfg: Config) {
      const bin = resolveBin(cfg.agents.claude.bin);
      if (!bin) return { state: 'missing' as const, detail: 'Claude Code CLI not found. Install it from https://claude.com/claude-code, then run `claude` once to sign in.' };
      return detectFromVersion(await cliOut(bin, ['--version'], claudeEnv(d.extraEnv)));
    },
    async auth(cfg: Config): Promise<AuthResult> {
      const bin = resolveBin(cfg.agents.claude.bin);
      if (!bin) return { state: 'unknown' };
      const a = await cliOut(bin, ['auth', 'status'], claudeEnv(d.extraEnv));
      if (a.spawnError) return { state: 'unknown', detail: a.spawnError };
      try {
        const j = JSON.parse(a.out.slice(a.out.indexOf('{')));
        if (j.loggedIn === true) return { state: 'ok', detail: `Signed in as ${[j.email, j.orgName, j.subscriptionType ? `${j.subscriptionType} plan` : ''].filter(Boolean).join(' · ') || 'unknown account'}` };
        if (j.loggedIn === false) return { state: 'not-logged-in', detail: 'Not signed in — run `claude auth login`.' };
      } catch {
        /* not JSON: fall through to the text reading */
      }
      if (/not logged/i.test(a.out)) return { state: 'not-logged-in', detail: 'Not signed in — run `claude auth login`.' };
      if (/logged in/i.test(a.out)) return { state: 'ok', detail: 'Signed in' };
      return { state: 'unknown', detail: 'Could not read the sign-in state.' };
    },
    async selfTest(cfg: Config, level: SelfTestLevel): Promise<SelfTestResult> {
      const d = await this.detect(cfg);
      const a = d.state === 'ok' ? await this.auth(cfg) : null;
      const cheap = cheapSelfTest(d, a);
      if (level === 'cheap' || !cheap.ok) return { ...cheap, level };
      // canary = one tiny read-only call through the real adapter (spends a little quota; callers must have asked)
      const r = await this.runReadOnly!({ stage: 'plan', cwd: process.cwd(), prompt: 'Return the JSON object {"ok": true} in a fenced json block. Do not use tools.', schema: { type: 'object' }, name: 'conductor probe', onEvent: () => undefined });
      return r.ok ? { level, state: 'ok', ok: true, detail: `Claude answered (${r.model ?? 'model'})` } : { level, state: r.errorKind === 'limit' ? 'ok' : 'unknown', ok: false, detail: r.errorKind === 'limit' ? `Signed in but at its usage limit — ${r.limit?.message ?? r.error}` : (r.error ?? 'Claude did not answer') };
    },
    async runResearch(req: ResearchRunReq) {
      const cfg = d.getConfig();
      const bin = resolveBin(cfg.agents.claude.bin);
      if (!bin) return { ok: false, text: '', exitCode: null, errorKind: 'spawn' as const, error: `Claude CLI "${cfg.agents.claude.bin}" not found. Install Claude Code or set agents.claude.bin.` };
      // web tools need the isolated profile: the fallback that loads project/local settings (hooks) is refused for research
      if (cfg.agents.claude.isolation !== 'safe-mode') return { ok: false, text: '', exitCode: null, errorKind: 'isolation' as const, error: "Deep Research needs Claude's safe-mode isolation." };
      const sel = req.sel && req.sel.tool === 'claude' ? req.sel : toolDefaultResolved(cfg, 'claude'); // a selection for another tool is never applied here (CR-N2)
      const depth = req.depth === 'deep' ? RESEARCH_DEPTH.deep : RESEARCH_DEPTH.standard;
      if (depth.maxTurns > RESEARCH_MAX_TURNS_CEILING) throw new Error('research --max-turns above the ceiling');
      // M8-3: the account's env (default ⇒ claudeEnv(d.extraEnv), byte-identical); pre-flight + assertion fail closed with zero spawn
      const ce = childEnv('claude', req.account, d.extraEnv);
      if (!ce.ok) return { ok: false, text: '', exitCode: null, errorKind: 'isolation' as const, error: ce.error };
      try {
        return await runClaude({
          bin, cwd: req.cwd, prompt: req.prompt, stage: 'plan', name: req.name, schema: req.schema, profile: 'research',
          maxTurns: depth.maxTurns, isolation: 'safe-mode', model: sel.modelArg, effort: sel.effortArg,
          env: ce.env, idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(depth.hardMin),
          signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: d.clock,
        });
      } finally {
        ce.release();
      }
    },
    async runReadOnly(req: ReadOnlyRunReq) {
      const cfg = d.getConfig();
      const bin = resolveBin(cfg.agents.claude.bin);
      if (!bin) return { ok: false, text: '', exitCode: null, errorKind: 'spawn' as const, error: `Claude CLI "${cfg.agents.claude.bin}" not found. Install Claude Code or set agents.claude.bin.` };
      const key = req.stage === 'plan' ? 'plan' : req.stage === 'plan_review' ? 'review' : 'verify';
      const baseTurns = cfg.agents.claude.maxTurns[key];
      const maxTurns = Math.round(baseTurns * (req.maxTurnsFactor ?? 1));
      const sel = req.sel && req.sel.tool === 'claude' ? req.sel : toolDefaultResolved(cfg, 'claude'); // a selection for another tool is never applied here (CR-N2)
      const ce = childEnv('claude', req.account, d.extraEnv);
      if (!ce.ok) return { ok: false, text: '', exitCode: null, errorKind: 'isolation' as const, error: ce.error };
      try {
        return await runClaude({
          bin, cwd: req.cwd, prompt: req.prompt, stage: req.stage, name: req.name, schema: req.schema,
          maxTurns, isolation: cfg.agents.claude.isolation, model: sel.modelArg, effort: sel.effortArg,
          env: ce.env, idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(cfg.pipeline.timeoutsMin[key]),
          signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: d.clock,
        });
      } finally {
        ce.release();
      }
    },
  };
}
