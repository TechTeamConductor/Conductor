// The Cursor adapter: a thin shell over the existing runner (src/agents/cursor.ts) and the Cursor-specific guard (git/worktree.ts).
// This file and pipeline/envelope.ts are the only places allowed to start a Cursor build (static test).
import { resolveBin } from '../../config.ts';
import * as W from '../../git/worktree.ts';
import { cursorEnv } from '../env.ts';
import { runCursor } from '../cursor.ts';
import { PROVIDER_LABEL, type AuthResult, type BuildPrep, type BuildRunReq, type Provider, type ProviderDeps, type ReadOnlyRunReq, type SelfTestLevel, type SelfTestResult } from './types.ts';
import { cheapSelfTest, cliOut, detectFromVersion } from './probe.ts';
import type { Config } from '../../types.ts';
import { toolDefaultResolved } from '../../models/select.ts';
import { assertAccountEnv, AccountIsolationError, accountEnv, childEnv, dropForNamedBuild, isNamed, isolationMessage } from '../../accounts/env.ts';
import { acquireAccount } from '../../accounts/profile.ts';

const minutes = (n: number) => n * 60_000;

export const CURSOR_ENV_ONLY_NOTE = 'This repo has its own .cursor/cli.json — no-push protection is environment-only for this run.';

export function cursorProvider(d: ProviderDeps): Provider {
  return {
    id: 'cursor',
    label: PROVIDER_LABEL.cursor,
    async detect(cfg: Config) {
      const bin = resolveBin(cfg.agents.cursor.bin);
      if (!bin) return { state: 'missing' as const, detail: 'Cursor CLI not found. Install: curl https://cursor.com/install -fsS | bash — then run `agent login`.' };
      return detectFromVersion(await cliOut(bin, ['--version'], cursorEnv(d.extraEnv)));
    },
    async auth(cfg: Config): Promise<AuthResult> {
      const bin = resolveBin(cfg.agents.cursor.bin);
      if (!bin) return { state: 'unknown' };
      const a = await cliOut(bin, ['status'], cursorEnv(d.extraEnv));
      if (a.spawnError) return { state: 'unknown', detail: a.spawnError };
      if (/not logged/i.test(a.out)) return { state: 'not-logged-in', detail: 'Not signed in — run `agent login`.' };
      if (/logged in/i.test(a.out)) return { state: 'ok', detail: a.out.split('\n')[0]!.replace(/^✓\s*/, '') };
      return { state: 'unknown', detail: 'Could not read the sign-in state.' };
    },
    async selfTest(cfg: Config, level: SelfTestLevel): Promise<SelfTestResult> {
      const d = await this.detect(cfg);
      const a = d.state === 'ok' ? await this.auth(cfg) : null;
      const cheap = cheapSelfTest(d, a);
      if (level === 'cheap' || !cheap.ok) return { ...cheap, level };
      const r = await this.runReadOnly!({ stage: 'plan', cwd: process.cwd(), prompt: 'Return the JSON object {"ok": true} in a fenced json block. Do not use tools.', schema: { type: 'object' }, name: 'conductor probe', onEvent: () => undefined });
      return r.ok ? { level, state: 'ok', ok: true, detail: `Cursor answered (${r.model ?? 'model'})` } : { level, state: 'unknown', ok: false, detail: r.error ?? 'Cursor did not answer' };
    },
    async runReadOnly(req: ReadOnlyRunReq) {
      const cfg = d.getConfig();
      const bin = resolveBin(cfg.agents.cursor.bin);
      if (!bin) return { ok: false, text: '', exitCode: null, errorKind: 'spawn' as const, error: `Cursor CLI "${cfg.agents.cursor.bin}" not found. Install it (curl https://cursor.com/install -fsS | bash) or set agents.cursor.bin.` };
      const key = req.stage === 'plan' ? 'plan' : req.stage === 'plan_review' ? 'review' : 'verify';
      const sel = req.sel && req.sel.tool === 'cursor' ? req.sel : toolDefaultResolved(cfg, 'cursor'); // a selection for another tool is never applied here (CR-N2)
      const ce = childEnv('cursor', req.account, d.extraEnv, (text) => req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text }));
      if (!ce.ok) return { ok: false, text: '', exitCode: null, errorKind: 'isolation' as const, error: ce.error };
      try {
        return await runCursor({
          bin, cwd: req.cwd, prompt: req.prompt, stage: req.stage, name: req.name, schema: req.schema, mode: 'ask',
          model: sel.modelArg, env: ce.env, idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(cfg.pipeline.timeoutsMin[key]),
          signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: d.clock,
        });
      } finally {
        ce.release();
      }
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
        const sel = req.sel && req.sel.tool === 'cursor' ? req.sel : toolDefaultResolved(cfg, 'cursor'); // a selection for another tool is never applied here (CR-N2)
        // M8-3 (B5, S1, R2-1): default ⇒ today's exact composition. Named ⇒ the account env (pre-flight inside), then the envelope-resolved
        // fragment, then the envelope's git env with HOME/CURSOR_*/AGENT_CLI_*/XDG_* dropped; the BINDING assertion runs on the final env.
        let env: Record<string, string>;
        let release = () => undefined as void;
        try {
          if (isNamed(req.account)) {
            env = { ...accountEnv('cursor', req.account, d.extraEnv), ...(req.accountEnv ?? {}), ...dropForNamedBuild(req.env) };
            assertAccountEnv('cursor', req.account, env);
            release = acquireAccount(req.account);
          } else {
            env = cursorEnv({ ...d.extraEnv, ...req.env });
            if (req.accountEnv !== undefined) throw new AccountIsolationError('an added account setting on the main account');
            assertAccountEnv('cursor', req.account, env);
          }
        } catch (e) {
          const cls = e instanceof AccountIsolationError ? e.cls : 'an account folder that could not be checked';
          return { ok: false, text: '', exitCode: null, errorKind: 'isolation' as const, error: isolationMessage('added Cursor', cls) };
        }
        try {
          return await runCursor({
            bin, cwd: req.cwd, prompt: req.prompt, stage: 'build', name: req.name, mode: 'build',
            model: sel.modelArg, env,
            idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(cfg.pipeline.timeoutsMin.build),
            signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: d.clock,
          });
        } finally {
          release();
        }
      },
      verifyGuard(prep, { worktree }) {
        return W.checkCursorGuard(worktree, prep.guardSha);
      },
    },
  };
}
