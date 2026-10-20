// The Cursor adapter: a thin shell over the existing runner (src/agents/cursor.ts) and the Cursor-specific guard (git/worktree.ts).
// This file and pipeline/envelope.ts are the only places allowed to start a Cursor build (static test).
import { resolveBin } from '../../config.ts';
import * as W from '../../git/worktree.ts';
import { cursorEnv } from '../env.ts';
import { runCursor } from '../cursor.ts';
import { PROVIDER_LABEL, type BuildPrep, type BuildRunReq, type Provider, type ProviderDeps, type ReadOnlyRunReq } from './types.ts';

const minutes = (n: number) => n * 60_000;

export const CURSOR_ENV_ONLY_NOTE = 'This repo has its own .cursor/cli.json — no-push protection is environment-only for this run.';

export function cursorProvider(d: ProviderDeps): Provider {
  return {
    id: 'cursor',
    label: PROVIDER_LABEL.cursor,
    async runReadOnly(req: ReadOnlyRunReq) {
      const cfg = d.getConfig();
      const bin = resolveBin(cfg.agents.cursor.bin);
      if (!bin) return { ok: false, text: '', exitCode: null, errorKind: 'spawn' as const, error: `Cursor CLI "${cfg.agents.cursor.bin}" not found. Install it (curl https://cursor.com/install -fsS | bash) or set agents.cursor.bin.` };
      const key = req.stage === 'plan' ? 'plan' : req.stage === 'plan_review' ? 'review' : 'verify';
      return runCursor({
        bin, cwd: req.cwd, prompt: req.prompt, stage: req.stage, name: req.name, schema: req.schema, mode: 'ask',
        model: cfg.agents.cursor.model, env: cursorEnv(d.extraEnv), idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(cfg.pipeline.timeoutsMin[key]),
        signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: d.clock,
      });
    },
    build: {
      guard: true,
      envAllow: ['CURSOR_*'],
      async prepare({ worktree }): Promise<BuildPrep> {
        const g = await W.writeCursorGuard(worktree);
        return { guardSha: g.sha256, envOnly: g.envOnly, note: g.envOnly ? CURSOR_ENV_ONLY_NOTE : undefined };
      },
      async run(req: BuildRunReq) {
        const cfg = d.getConfig();
        const bin = resolveBin(cfg.agents.cursor.bin);
        if (!bin) {
          return { ok: false, text: '', exitCode: null, errorKind: 'spawn' as const, error: `Cursor CLI "${cfg.agents.cursor.bin}" not found. Install it (curl https://cursor.com/install -fsS | bash) or set agents.cursor.bin.` };
        }
        return runCursor({
          bin, cwd: req.cwd, prompt: req.prompt, stage: 'build', name: req.name, mode: 'build',
          model: cfg.agents.cursor.model, env: cursorEnv({ ...d.extraEnv, ...req.env }),
          idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(cfg.pipeline.timeoutsMin.build),
          signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: d.clock,
        });
      },
      verifyGuard(prep, { worktree }) {
        return W.checkCursorGuard(worktree, prep.guardSha);
      },
    },
  };
}
