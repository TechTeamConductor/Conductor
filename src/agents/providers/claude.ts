// The Claude adapter: read-only only. A thin shell over the existing runner — argv and the fail-closed init predicate are untouched.
import { resolveBin } from '../../config.ts';
import { claudeEnv } from '../env.ts';
import { runClaude } from '../claude.ts';
import { PROVIDER_LABEL, type Provider, type ProviderDeps, type ReadOnlyRunReq } from './types.ts';

const minutes = (n: number) => n * 60_000;

export function claudeProvider(d: ProviderDeps): Provider {
  return {
    id: 'claude',
    label: PROVIDER_LABEL.claude,
    async runReadOnly(req: ReadOnlyRunReq) {
      const cfg = d.getConfig();
      const bin = resolveBin(cfg.agents.claude.bin);
      if (!bin) return { ok: false, text: '', exitCode: null, errorKind: 'spawn' as const, error: `Claude CLI "${cfg.agents.claude.bin}" not found. Install Claude Code or set agents.claude.bin.` };
      const key = req.stage === 'plan' ? 'plan' : req.stage === 'plan_review' ? 'review' : 'verify';
      const baseTurns = cfg.agents.claude.maxTurns[key];
      const maxTurns = Math.round(baseTurns * (req.maxTurnsFactor ?? 1));
      return runClaude({
        bin, cwd: req.cwd, prompt: req.prompt, stage: req.stage, name: req.name, schema: req.schema,
        maxTurns, isolation: cfg.agents.claude.isolation, model: cfg.agents.claude.model,
        env: claudeEnv(d.extraEnv), idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(cfg.pipeline.timeoutsMin[key]),
        signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: d.clock,
      });
    },
  };
}
