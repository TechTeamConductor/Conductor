// A run-independent read-only agent call (M5): router + chain advance (inside `Agents.readOnly`), schema validation with ONE corrective
// re-ask, a max-turns retry, and classification of the ways it can end. Used by Quick Ask and Research; the engine's own `callReadOnly`
// (which also drives run transitions and budgets) is deliberately left untouched — a behaviour-identical extraction of that proven path was
// judged riskier than a second small caller (recorded in the M5 plan).
import type { Agents } from './provider.ts';
import type { EmitEvent } from './claude.ts';
import type { Schema } from './json.ts';
import type { Role } from './roles.ts';
import type { States } from './routing.ts';
import type { ProviderId } from './providers/types.ts';
import type { LimitInfo } from '../types.ts';
import { truncate } from '../util.ts';
import type { LimitRule } from '../accounts/limit-rule.ts';
import type { AccountRef } from '../accounts/types.ts';

export interface CallAgentReq {
  agents: Agents;
  role: Role;
  states: States;
  prompt: string;
  schema: Schema;
  cwd: string;
  validate: (json: unknown) => string[];
  secrets: string[];
  onEvent: (ev: EmitEvent) => void;
  signal?: AbortSignal;
  onLimit?: (l: LimitInfo) => void;
  name: string;
  /** M8-2 model/effort selection role (code constants only; selection never changes routing or the profile — M8-6 S2). */
  selRole?: Role;
  /** M8-6 S3: narrowing-only provider filter forwarded to `Agents.readOnly`. */
  onlyProviders?: readonly ProviderId[];
  /** M8-3 (C1): REQUIRED — `effectiveLimitRule(cfg)` (code review B1); and the per-attempt account callback (removal ⇒ abort). */
  rule: LimitRule;
  onCandidate?: (ref: AccountRef) => void;
}
export type CallAgentResult =
  | { kind: 'ok'; json: unknown; agent: string; fellBackFrom?: string }
  | { kind: 'paused'; limit: LimitInfo }
  | { kind: 'offline'; message: string }
  | { kind: 'aborted' }
  | { kind: 'failed'; reason: string };

export async function callAgent(req: CallAgentReq): Promise<CallAgentResult> {
  let corrective = '';
  let retried = false;
  let turnsFactor = 1;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (req.signal?.aborted) return { kind: 'aborted' };
    const res = await req.agents.readOnly({
      role: req.role,
      complexity: undefined,
      states: req.states,
      onLimit: req.onLimit ?? (() => undefined),
      stage: 'plan',
      cwd: req.cwd,
      prompt: req.prompt + corrective,
      schema: req.schema,
      name: req.name,
      onEvent: req.onEvent,
      signal: req.signal,
      secrets: req.secrets,
      maxTurnsFactor: turnsFactor,
      ...(req.selRole ? { selRole: req.selRole } : {}),
      ...(req.onlyProviders ? { onlyProviders: req.onlyProviders } : {}),
      rule: req.rule,
      ...(req.onCandidate ? { onCandidate: req.onCandidate } : {}),
    });
    if (res.ok) {
      const errs = req.validate(res.json);
      if (!errs.length) return { kind: 'ok', json: res.json, agent: res.agent, fellBackFrom: res.fellBack && res.from !== res.agent ? res.from : undefined };
      if (retried) return { kind: 'failed', reason: `The ${res.agent} reply kept failing validation: ${errs[0]}` };
      retried = true;
      corrective = `\n\n## Your previous reply was rejected\nIt did not match the required format:\n${errs.slice(0, 8).map((e) => `- ${e}`).join('\n')}\nReturn a corrected JSON object.`;
      continue;
    }
    switch (res.errorKind) {
      case 'limit':
        return { kind: 'paused', limit: res.limit ?? { provider: res.agent, resetsAt: null, message: res.error ?? 'limit' } };
      case 'network':
        return { kind: 'offline', message: res.error ?? 'network unreachable' };
      case 'aborted':
        return { kind: 'aborted' };
      case 'auth':
      case 'isolation':
      case 'spawn':
        return { kind: 'failed', reason: res.error ?? 'the agent could not start' };
      case 'max_turns':
        if (retried) return { kind: 'failed', reason: 'The agent ran out of turns twice.' };
        retried = true;
        turnsFactor = 1.5;
        continue;
      case 'parse':
        if (retried) return { kind: 'failed', reason: res.error ?? 'could not parse the agent reply' };
        retried = true;
        corrective = '\n\n## Your previous reply was rejected\nNo JSON object could be found. Reply with ONLY the fenced ```json block.';
        continue;
      default:
        if (retried) return { kind: 'failed', reason: `${res.agent} failed twice: ${truncate(res.error ?? 'unknown error', 300)}` };
        retried = true;
        continue;
    }
  }
  return { kind: 'failed', reason: 'The agent could not produce a valid reply.' };
}
