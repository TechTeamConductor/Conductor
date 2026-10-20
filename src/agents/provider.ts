import type { AgentName, AgentResult, Config, StageName } from '../types.ts';
import { resolveBin } from '../config.ts';
import type { Clock } from '../util.ts';
import { systemClock } from '../util.ts';
import { claudeEnv, cursorEnv } from './env.ts';
import { describeSchema, type Schema } from './json.ts';
import { runClaude, type EmitEvent } from './claude.ts';
import { runCursor } from './cursor.ts';
import { runProcess } from './spawn.ts';
import { createProviders } from './providers/registry.ts';
import type { Provider, ProviderId } from './providers/types.ts';

export interface ReadOnlyReq {
  stage: Extract<StageName, 'plan' | 'plan_review' | 'verify'>;
  cwd: string;
  prompt: string;
  schema: Schema;
  name: string; // session display name, e.g. "conductor ENG-12 plan"
  onEvent: (ev: EmitEvent) => void;
  signal?: AbortSignal;
  secrets?: string[];
  /** Force a specific agent (otherwise from config.stages). */
  agent?: AgentName;
  /** Multiply the Claude --max-turns cap (retry after error_max_turns). */
  maxTurnsFactor?: number;
}
export type AgentOutcome = AgentResult & { agent: AgentName; fellBack?: boolean };

/** Appended to read-only prompts: works for every provider, and is the Claude fallback when structured_output is absent. */
export function jsonInstruction(schema: Schema): string {
  return [
    '',
    '## Required output format',
    'Reply with ONLY one fenced ```json code block holding a single JSON object — no prose before or after the block. Fields:',
    describeSchema(schema),
  ].join('\n');
}

const minutes = (n: number) => n * 60_000;

export class Agents {
  private getConfig: () => Config;
  private clock: Clock;
  private versions = new Map<string, Promise<string>>();
  private extraEnv: Record<string, string>;
  private providers: Record<ProviderId, Provider>;

  constructor(getConfig: () => Config, opts: { clock?: Clock; extraEnv?: Record<string, string> } = {}) {
    this.getConfig = getConfig;
    this.clock = opts.clock ?? systemClock;
    this.extraEnv = opts.extraEnv ?? {};
    this.providers = createProviders({ getConfig, clock: this.clock, extraEnv: this.extraEnv });
  }

  /** A registry provider. Builds are started only by pipeline/envelope.ts (static test) — not through this class. */
  provider(id: ProviderId): Provider {
    return this.providers[id];
  }

  /** `<bin> --version`, cached per binary. */
  cliVersion(agent: AgentName): Promise<string> {
    const cfg = this.getConfig();
    const bin = resolveBin(agent === 'claude' ? cfg.agents.claude.bin : cfg.agents.cursor.bin);
    if (!bin) return Promise.resolve('not found');
    let p = this.versions.get(bin);
    if (!p) {
      p = runProcess({
        bin,
        args: ['--version'],
        cwd: process.cwd(),
        env: agent === 'claude' ? claudeEnv() : cursorEnv(),
        idleMs: 15_000,
        hardMs: 15_000,
      }).then((r) => (r.stdoutTail.trim().split('\n')[0] ?? '').slice(0, 80) || 'unknown');
      this.versions.set(bin, p);
    }
    return p;
  }

  async readOnly(req: ReadOnlyReq): Promise<AgentOutcome> {
    const cfg = this.getConfig();
    const key = req.stage === 'plan' ? 'plan' : req.stage === 'plan_review' ? 'review' : 'verify';
    const agent: AgentName = req.agent ?? cfg.stages[key];
    const hardMin = req.stage === 'plan' ? cfg.pipeline.timeoutsMin.plan : req.stage === 'plan_review' ? cfg.pipeline.timeoutsMin.review : cfg.pipeline.timeoutsMin.verify;
    const prompt = req.prompt + '\n' + jsonInstruction(req.schema);

    const runOn = async (which: AgentName): Promise<AgentResult> => {
      if (which === 'claude') {
        const bin = resolveBin(cfg.agents.claude.bin);
        if (!bin) return { ok: false, text: '', exitCode: null, errorKind: 'spawn', error: `Claude CLI "${cfg.agents.claude.bin}" not found. Install Claude Code or set agents.claude.bin.` };
        const baseTurns = key === 'plan' ? cfg.agents.claude.maxTurns.plan : key === 'review' ? cfg.agents.claude.maxTurns.review : cfg.agents.claude.maxTurns.verify;
        const maxTurns = Math.round(baseTurns * (req.maxTurnsFactor ?? 1));
        return runClaude({
          bin, cwd: req.cwd, prompt, stage: req.stage, name: req.name, schema: req.schema,
          maxTurns, isolation: cfg.agents.claude.isolation, model: cfg.agents.claude.model,
          env: claudeEnv(this.extraEnv), idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(hardMin),
          signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: this.clock,
        });
      }
      const bin = resolveBin(cfg.agents.cursor.bin);
      if (!bin) return { ok: false, text: '', exitCode: null, errorKind: 'spawn', error: `Cursor CLI "${cfg.agents.cursor.bin}" not found. Install it (curl https://cursor.com/install -fsS | bash) or set agents.cursor.bin.` };
      return runCursor({
        bin, cwd: req.cwd, prompt, stage: req.stage, name: req.name, schema: req.schema, mode: 'ask',
        model: cfg.agents.cursor.model, env: cursorEnv(this.extraEnv), idleMs: minutes(cfg.pipeline.timeoutsMin.idle), hardMs: minutes(hardMin),
        signal: req.signal, onEvent: req.onEvent, secrets: req.secrets, clock: this.clock,
      });
    };

    const first = await runOn(agent);
    if (!first.ok && first.errorKind === 'limit' && agent === 'claude' && cfg.pipeline.onClaudeLimit === 'cursor') {
      req.onEvent({ agent: 'conductor', stage: req.stage, kind: 'note', text: 'Claude usage limit reached — falling back to Cursor (read-only) for this stage.' });
      const second = await runOn('cursor');
      return { ...second, agent: 'cursor', fellBack: true };
    }
    return { ...first, agent };
  }
}
