import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AgentHealth, Config } from './types.ts';
import { resolveBin } from './config.ts';
import { claudeEnv, cursorEnv } from './agents/env.ts';
import { buildClaudeArgs, checkClaudeInit } from './agents/claude.ts';
import { runClaude } from './agents/claude.ts';
import { runCursor } from './agents/cursor.ts';
import { runProcess } from './agents/spawn.ts';
import { CODEX_MIN_VERSION, codexAuth, detectCodex } from './agents/providers/codex.ts';
import { scanAncestors } from './git/worktree.ts';
import { KeychainStore } from './secrets.ts';
import { errMsg, truncate } from './util.ts';

export interface Check {
  id: string;
  label: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

const cache = new Map<string, { at: number; value: AgentHealth }>();

async function cliOut(bin: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const r = await runProcess({ bin, args, cwd: process.cwd(), env, idleMs: 20_000, hardMs: 20_000 });
  return { code: r.code, out: (r.stdoutTail + r.stderrTail).trim() };
}

/** Zero-quota health of the two agent CLIs (found / version / logged in). Cached 60 s. */
export async function agentHealth(cfg: Config, which: 'claude' | 'cursor' | 'codex', force = false): Promise<AgentHealth> {
  if (which === 'codex') return codexHealth(cfg, force);
  const binName = which === 'claude' ? cfg.agents.claude.bin : cfg.agents.cursor.bin;
  const hit = cache.get(`${which}:${binName}`);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.value;
  const bin = resolveBin(binName);
  let value: AgentHealth;
  if (!bin) {
    value = {
      found: false,
      ok: false,
      detail: which === 'claude' ? 'Claude Code CLI not found. Install it from https://claude.com/claude-code, then run `claude` once to sign in.' : 'Cursor CLI not found. Install: curl https://cursor.com/install -fsS | bash — then run `agent login`.',
    };
  } else if (which === 'claude') {
    const v = await cliOut(bin, ['--version'], claudeEnv());
    const a = await cliOut(bin, ['auth', 'status'], claudeEnv());
    let loggedIn = false;
    let who = '';
    try {
      const j = JSON.parse(a.out.slice(a.out.indexOf('{')));
      loggedIn = j.loggedIn === true;
      who = [j.email, j.orgName, j.subscriptionType ? `${j.subscriptionType} plan` : ''].filter(Boolean).join(' · ');
    } catch {
      loggedIn = /logged in/i.test(a.out) && !/not logged/i.test(a.out);
    }
    value = { found: true, version: v.out.split('\n')[0]?.slice(0, 60), loggedIn, ok: loggedIn, detail: loggedIn ? `Signed in as ${who || 'unknown account'}` : 'Not signed in — run `claude auth login`.' };
  } else {
    const v = await cliOut(bin, ['--version'], cursorEnv());
    const a = await cliOut(bin, ['status'], cursorEnv());
    const loggedIn = /logged in/i.test(a.out) && !/not logged/i.test(a.out);
    value = { found: true, version: v.out.split('\n')[0]?.slice(0, 60), loggedIn, ok: loggedIn, detail: loggedIn ? a.out.split('\n')[0]!.replace(/^✓\s*/, '') : 'Not signed in — run `agent login`.' };
  }
  cache.set(`${which}:${binName}`, { at: Date.now(), value });
  return value;
}

/**
 * Codex: `--version` + `login status` against Conductor's PRIVATE home, nothing else (zero quota, never a model call). A launcher whose native
 * binary is missing is reported as `broken-install` (found: false) with the stderr tail and a fixed hint — Conductor never repairs it.
 */
async function codexHealth(cfg: Config, force: boolean): Promise<AgentHealth> {
  const binName = cfg.agents.codex.bin;
  const hit = cache.get(`codex:${binName}`);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.value;
  const d = await detectCodex(binName);
  let value: AgentHealth;
  if (d.state === 'missing') value = { found: false, ok: false, state: 'missing', detail: d.detail };
  else if (d.state === 'broken-install') value = { found: false, ok: false, state: 'broken-install', detail: `Codex is installed but does not start: ${d.detail}` };
  else {
    const auth = await codexAuth(binName);
    const detail = d.belowMinimum ? `Codex ${d.version} is older than ${CODEX_MIN_VERSION}, which this version of Conductor was written against; it is treated as unverified.` : auth === 'ok' ? 'Signed in (Conductor\'s private Codex home)' : auth === 'not-logged-in' ? 'Not signed in to Conductor\'s private Codex home.' : 'Sign-in state unknown.';
    value = { found: true, version: d.version, state: 'ok', loggedIn: auth === 'ok' ? true : auth === 'not-logged-in' ? false : undefined, ok: auth === 'ok' && !d.belowMinimum, detail };
  }
  cache.set(`codex:${binName}`, { at: Date.now(), value });
  return value;
}

/** Everything the doctor command and dashboard warnings need. Never spends agent quota. */
export async function runChecks(cfg: Config): Promise<Check[]> {
  const out: Check[] = [];
  const add = (id: string, label: string, level: Check['level'], detail: string) => out.push({ id, label, level, detail });

  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  add('node', 'Node.js', maj > 22 || (maj === 22 && min >= 18) ? 'ok' : 'fail', `v${process.versions.node} (need ≥ 22.18)`);
  try {
    add('git', 'git', 'ok', execFileSync('git', ['--version'], { encoding: 'utf8' }).trim());
  } catch {
    add('git', 'git', 'fail', 'git was not found on PATH');
  }
  const c = await agentHealth(cfg, 'claude');
  add('claude', 'Claude Code', c.ok ? 'ok' : 'fail', `${c.version ?? ''} ${c.detail ?? ''}`.trim());
  const k = await agentHealth(cfg, 'cursor');
  add('cursor', 'Cursor CLI', k.ok ? 'ok' : 'fail', `${k.version ?? ''} ${k.detail ?? ''}`.trim());
  // Codex is optional (in no default chain): reported, never a failure unless a role actually uses it
  const x = await agentHealth(cfg, 'codex');
  const codexUsed = Object.values(cfg.roles).some((r) => r.providers.includes('codex'));
  add('codex', 'Codex CLI (optional)', x.ok ? 'ok' : codexUsed ? 'fail' : 'warn', `${x.version ?? ''} ${x.detail ?? ''}`.trim());
  add('keychain', 'Secret storage', KeychainStore.available() && process.env.CONDUCTOR_NO_KEYCHAIN !== '1' ? 'ok' : 'warn', KeychainStore.available() ? 'macOS Keychain' : '0600 file in the data folder (Keychain unavailable)');

  if (!cfg.repos.length) add('repos', 'Repositories', 'warn', 'No repository registered yet.');
  for (const r of cfg.repos) {
    if (!existsSync(r.path)) {
      add(`repo:${r.name}`, `Repo ${r.name}`, 'fail', `${r.path} does not exist`);
      continue;
    }
    add(`repo:${r.name}`, `Repo ${r.name}`, r.gates.length ? 'ok' : 'warn', r.gates.length ? `Gates: ${r.gates.map((g) => g.name).join(', ')}` : 'No test/lint/typecheck commands detected — results will be flagged "unverified".');
    const wtRoot = cfg.worktreeRoot ?? join(r.path, '..', '.conductor-v2-worktrees');
    const anc = await scanAncestors(join(wtRoot, r.name, 'x')).catch(() => []);
    if (anc.length) add(`ancestors:${r.name}`, `Instruction files above ${r.name}'s worktrees`, 'warn', `An agent may read: ${anc.slice(0, 4).join(', ')}. Set worktreeRoot in the data folder's config.json to a clean folder if this causes trouble.`);
    if (r.path.startsWith('/Volumes/')) add(`volume:${r.name}`, 'External drive', 'warn', `${r.name} lives on an external volume — if you install the background service, launchd may start before the drive mounts (it retries automatically).`);
  }
  try {
    const rules = join(homedir(), '.cursor', 'rules');
    if (existsSync(rules)) {
      const files = readdirSync(rules).filter((f) => f.endsWith('.mdc'));
      const always = files.filter((f) => /alwaysApply:\s*true/.test(readFileSync(join(rules, f), 'utf8'))).length;
      if (always) add('cursor-rules', 'Cursor global rules', 'warn', `${always} always-on rule file(s) in ~/.cursor/rules are loaded by the Cursor CLI (cannot be disabled by a flag). Conductor's builder prompt overrides plan/review/tracker rules explicitly.`);
    }
  } catch {
    /* informational */
  }
  return out;
}

// ───────────────────────── isolation probe (spends at most a tiny Claude call) ─────────────────────────
export interface IsolationReport {
  ok: boolean;
  initOk: boolean;
  initReason?: string;
  projectClaudeMdLoaded: boolean;
  ancestorLoaded: boolean;
  userRulesLoaded: boolean;
  limited?: string;
  note: string;
}

/**
 * Proves the Claude stage flags isolate the session: runs one tiny headless call in a canary repo and inspects
 * the system/init event plus the persisted session transcript for instruction-file canaries.
 * Works even when the account is rate-limited (the transcript is written before the API call is rejected).
 */
export async function isolationProbe(cfg: Config): Promise<IsolationReport> {
  const bin = resolveBin(cfg.agents.claude.bin);
  if (!bin) return { ok: false, initOk: false, projectClaudeMdLoaded: false, ancestorLoaded: false, userRulesLoaded: false, note: 'Claude CLI not found' };
  const root = mkdtempSync(join(tmpdir(), 'cond-iso-'));
  try {
    mkdirSync(join(root, 'repo'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'CANARY-ANCESTOR-7731: always run a plan gate\n');
    writeFileSync(join(root, 'repo', 'CLAUDE.md'), 'CANARY-PROJECT-7731: always run a plan gate\n');
    const repo = join(root, 'repo');
    const initEvents: any[] = [];
    let sid = '';
    let limited: string | undefined;
    const r = await runProcess({
      bin,
      args: buildClaudeArgs({ maxTurns: 3, isolation: cfg.agents.claude.isolation, name: 'conductor isolation probe', schema: undefined, model: cfg.agents.claude.model }),
      cwd: repo,
      env: claudeEnv(),
      stdin: 'Reply with the single word OK.',
      idleMs: 60_000,
      hardMs: 90_000,
      onLine: (line, stream) => {
        if (stream !== 'stdout') return;
        try {
          const o = JSON.parse(line);
          if (o.type === 'system' && o.subtype === 'init') initEvents.push(o);
          if (typeof o.session_id === 'string') sid = o.session_id;
          if (o.type === 'result' && o.is_error && /limit/i.test(String(o.result))) limited = String(o.result);
        } catch {
          /* ignore */
        }
      },
    });
    void r;
    const init = initEvents[0];
    const chk = checkClaudeInit(init);
    let transcript = '';
    const proj = join(homedir(), '.claude', 'projects');
    try {
      for (const d of readdirSync(proj)) {
        const f = join(proj, d, `${sid}.jsonl`);
        if (sid && existsSync(f)) transcript = readFileSync(f, 'utf8');
      }
    } catch {
      /* transcript layout may change; report as unknown */
    }
    let userNeedle = '';
    try {
      const u = readFileSync(join(homedir(), '.claude', 'CLAUDE.md'), 'utf8').split('\n').find((l) => l.trim().length > 12);
      if (u) userNeedle = u.trim().slice(0, 60);
    } catch {
      /* no user CLAUDE.md */
    }
    const projectLoaded = transcript.includes('CANARY-PROJECT-7731');
    const ancestorLoaded = transcript.includes('CANARY-ANCESTOR-7731');
    const userLoaded = !!userNeedle && transcript.includes(userNeedle);
    const ok = chk.ok && !ancestorLoaded && !userLoaded && !projectLoaded;
    return {
      ok,
      initOk: chk.ok,
      initReason: chk.reason,
      projectClaudeMdLoaded: projectLoaded,
      ancestorLoaded,
      userRulesLoaded: userLoaded,
      limited,
      note: !transcript ? 'Session transcript not found (format may have changed) — only the init event was checked.' : ok ? 'Isolated: only Read/Grep/Glob, no MCP/skills, no user/project/ancestor instruction files.' : 'Isolation FAILED — see flags above.',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ───────────────────────── explicit probes (may spend a tiny amount of quota) ─────────────────────────
export async function probe(cfg: Config, target: 'claude' | 'cursor'): Promise<{ ok: boolean; detail: string; durationMs: number }> {
  const t0 = Date.now();
  const done = (ok: boolean, detail: string) => ({ ok, detail, durationMs: Date.now() - t0 });
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'cond-probe-'));
    try {
      if (target === 'claude') {
        const bin = resolveBin(cfg.agents.claude.bin);
        if (!bin) return done(false, 'Claude CLI not found.');
        const r = await runClaude({
          bin, cwd: tmp, prompt: 'Return the JSON object {"ok": true}.', stage: 'plan', name: 'conductor probe',
          schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, maxTurns: 3, isolation: cfg.agents.claude.isolation, model: cfg.agents.claude.model,
          env: claudeEnv(), idleMs: 60_000, hardMs: 90_000, onEvent: () => undefined,
        });
        if (r.ok) return done(true, `Claude answered (${r.model ?? 'model'})`);
        if (r.errorKind === 'limit') return done(false, `Claude is signed in but at its usage limit — ${r.limit?.message ?? r.error}`);
        return done(false, truncate(r.error ?? 'Claude did not answer', 300));
      }
      const bin = resolveBin(cfg.agents.cursor.bin);
      if (!bin) return done(false, 'Cursor CLI not found.');
      const r = await runCursor({
        bin, cwd: tmp, prompt: 'Return the JSON object {"ok": true} in a fenced json block. Do not use tools.', stage: 'plan', name: 'conductor probe', mode: 'ask',
        schema: { type: 'object' }, model: cfg.agents.cursor.model, env: cursorEnv(), idleMs: 60_000, hardMs: 90_000, onEvent: () => undefined,
      });
      return r.ok ? done(true, `Cursor answered (${r.model ?? 'model'})`) : done(false, truncate(r.error ?? 'Cursor did not answer', 300));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    return done(false, truncate(errMsg(e), 300));
  }
}
