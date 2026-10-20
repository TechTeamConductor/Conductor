#!/usr/bin/env node
// Scripted stand-in for the OpenAI Codex CLI. Event shapes follow the documented `codex exec --json` stream
// (thread.started / turn.started / item.* / turn.completed / turn.failed / error). NOT captured from a real binary: this machine's
// install is broken, so nothing here proves how the real CLI behaves — it exercises Conductor's handling of the documented shapes.
// Scenario: $FAKE_DIR/codex.json = { version, login, exec: [ {mode, ...}, … ] } — `exec` entries are used by call index.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const argv = process.argv.slice(2);
const dir = process.env.FAKE_DIR || '';
const sc = (() => {
  try {
    return JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const log = (o) => {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'codex-calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, envKeys: Object.keys(process.env), ...o }) + '\n');
};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (argv[0] === '--version') {
  log({ cmd: 'version' });
  const v = sc.version ?? 'ok';
  if (v === 'broken') {
    process.stderr.write("Error: spawn /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT\n");
    process.exit(1);
  }
  console.log(v === 'old' ? 'codex-cli 0.100.0' : 'codex-cli 0.128.0');
  process.exit(0);
}
// the credential lives in $CODEX_HOME/auth.json: a CLI that has none is not signed in (an explicit scenario `login` still wins)
const signedIn = () => existsSync(join(process.env.CODEX_HOME ?? '/nonexistent', 'auth.json'));
if (argv[0] === 'login' && argv[1] === 'status') {
  log({ cmd: 'login-status' });
  if ((sc.login ?? (signedIn() ? 'ok' : 'out')) === 'ok') {
    console.log('Logged in using ChatGPT');
    process.exit(0);
  }
  process.stderr.write('Not logged in\n');
  process.exit(1);
}
if (argv[0] !== 'exec') {
  process.stderr.write(`unexpected command: ${argv.join(' ')}\n`);
  process.exit(2);
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (!signedIn()) {
  // a real CLI cannot reach the model without a credential: this is what made an unauthenticated canary control impossible to pass
  log({ cmd: 'exec-unauthenticated' });
  out({ type: 'turn.failed', error: { message: 'Not logged in. Run `codex login`.' } });
  process.exit(1);
}
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const outFile = val('-o');
const schemaFile = val('--output-schema');
const counter = join(dir || '.', 'codex-counter');
let idx = 0;
if (dir) {
  appendFileSync(counter, 'x');
  idx = statSync(counter).size - 1;
}
const list = sc.exec ?? [];
const step = list[Math.min(idx, list.length - 1)] ?? { mode: 'ok' };
log({ cmd: 'exec', idx, promptBytes: prompt.length, promptHead: prompt.slice(0, 200), schemaFile, outFile, schemaBytes: schemaFile && existsSync(schemaFile) ? statSync(schemaFile).size : null });

const key = /^Issue key: ([A-Z][A-Z0-9]*-\d+)\s*$/m.exec(prompt)?.[1] ?? 'UNKNOWN-0';
const title = /^Title: (.*)$/m.exec(prompt)?.[1] ?? 'Untitled';
const stage = (/^# Stage: (\w+)/m.exec(prompt)?.[1] ?? 'PLAN').toLowerCase();
const planDefault = {
  summary: `Implement "${title}" with a small, tested change.`, blocked: { is: false, questions: [] }, assumptions: [],
  currentState: 'No implementation yet.', expectedState: 'Feature exists with a test.',
  acceptanceCriteria: [{ id: 'AC1', text: `${title} works`, verification: 'node --test' }],
  filesToChange: [{ path: `feature-${key.toLowerCase()}.mjs`, action: 'create', change: 'implement', reason: 'AC1' }],
  steps: ['Implement', 'Test'], testing: { commands: ['npm test'], cases: ['works'] }, risks: [], coverage: [{ requirement: title, change: 'new module', verification: 'npm test' }], complexity: 'S',
};
const payload = step.json ?? (stage === 'plan' ? planDefault : stage === 'plan_review' ? { decision: 'approved', summary: 'Looks right.', issues: [] } : { verdict: 'pass', summary: 'Verified.', acceptance: [{ id: 'AC1', status: 'met', evidence: 'feature.mjs:1' }], bugs: [] });
const text = step.text ?? JSON.stringify(payload);


// ───────── isolation-canary simulation ─────────
// step.canary = { honour: ['project-hook', 'user-mcp', …], sandboxWrite, networkReaches, leakEnv, skip: ['write','network','env','cred','rules'], controlBroken: ['hook','mcp','rule'] }
// This simulates a CLI that honours (or not) the layers it is told to; it is a test double for Conductor's EVIDENCE HANDLING, not a model of the real CLI.
async function canaryMode() {
  const cfg = step.canary ?? {};
  const honour = new Set(cfg.honour ?? []);
  const skip = new Set(cfg.skip ?? []);
  const broken = new Set(cfg.controlBroken ?? []);
  const isProd = argv.includes('--ignore-user-config');
  const layers = [];
  if (!isProd) layers.push({ dir: process.env.CODEX_HOME, tag: 'control', all: true });
  else {
    layers.push({ dir: join(process.env.HOME ?? '', '.codex'), tag: 'user' });
    layers.push({ dir: join(process.cwd(), '.codex'), tag: 'project' });
  }
  const loaded = (l, what) => (l.all ? !broken.has(what) : honour.has(`${l.tag}-${what}`));
  const hooks = [];
  const mcps = [];
  const forbidden = [];
  for (const l of layers) {
    try {
      if (loaded(l, 'hook')) for (const e of JSON.parse(readFileSync(join(l.dir, 'hooks.json'), 'utf8')).hooks?.PreToolUse ?? []) for (const h of e.hooks ?? []) hooks.push(h.command);
    } catch {}
    try {
      const t = readFileSync(join(l.dir, 'config.toml'), 'utf8');
      const m = /command = "([^"]+)"\nargs = \["([^"]+)"\]/.exec(t.replace(/\\\//g, '/'));
      if (m && loaded(l, 'mcp')) mcps.push([m[1], JSON.parse(`"${m[2]}"`)]);
    } catch {}
    try {
      if (loaded(l, 'rule') && !skip.has('rules')) for (const m of readFileSync(join(l.dir, 'rules', 'canary.rules'), 'utf8').matchAll(/pattern=\["echo", "([^"]+)"\], decision="forbidden"/g)) forbidden.push(m[1]);
    } catch {}
  }
  for (const [cmd, arg] of mcps) {
    const c = spawn(cmd, [arg], { stdio: 'ignore', detached: true });
    await new Promise((r) => setTimeout(r, 400));
    try { process.kill(-c.pid, 'SIGKILL'); } catch {}
  }
  const cmds = [...prompt.matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
  const CORE = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|TERM|TMPDIR)$/;
  let first = true;
  let n = 0;
  for (const command of cmds) {
    const kind = /^echo rule-probe/.test(command) ? 'rules' : /conductor-write-probe/.test(command) ? 'write' : /127\.0\.0\.1/.test(command) ? 'network' : /^env/.test(command) ? 'env' : /^cat /.test(command) ? 'cred' : 'plain';
    if (skip.has(kind)) continue;
    const id = `c${++n}`;
    const shown = cfg.wrapCommands ? `/bin/zsh -lc ${JSON.stringify(command)}` : command;
    out({ type: 'item.started', item: { id, type: 'command_execution', command: shown, status: 'in_progress' } });
    if (first) { for (const h of hooks) spawnSync('sh', ['-c', h]); first = false; }
    let output = '';
    let code = 0;
    if (kind === 'rules') {
      const probe = /rule-probe-[0-9a-f]+-[a-z]+/.exec(command)[0];
      if (forbidden.includes(probe)) { code = 1; output = ''; } else output = probe + '\n';
    } else if (kind === 'write') {
      const f = /conductor-write-probe-[0-9a-f]+\.txt/.exec(command)[0];
      if (cfg.sandboxWrite) writeFileSync(join(process.cwd(), f), 'x');
      else { code = 1; output = 'sh: ' + f + ': Read-only file system\n'; }
    } else if (kind === 'network') {
      const port = Number(/127\.0\.0\.1:(\d+)/.exec(command)[1]);
      if (cfg.networkReaches) await new Promise((r) => { const sock = net.connect(port, '127.0.0.1', () => { sock.end('GET / HTTP/1.0\r\n\r\n'); r(); }); sock.on('error', r); sock.on('close', r); });
      else code = cfg.networkExit ?? 7;
    } else if (kind === 'env') {
      output = Object.entries(process.env).filter(([k]) => cfg.leakEnv || CORE.test(k)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    } else if (kind === 'cred') {
      try { output = readFileSync(command.slice(4).trim(), 'utf8'); } catch { code = 1; output = 'No such file\n'; }
    } else output = 'hello\n';
    out({ type: 'item.completed', item: { id, type: 'command_execution', command: shown, aggregated_output: output, exit_code: code, status: code === 0 ? 'completed' : 'failed' } });
  }
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'DONE' } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
  process.exit(0);
}

if (/You are testing a sandbox/.test(prompt)) await canaryMode();
// two Codex processes must never run against one private home: an O_EXCL marker proves it
let holding = false;
if (dir) {
  try {
    closeSync(openSync(join(dir, 'codex-active'), 'wx'));
    holding = true;
  } catch {
    log({ cmd: 'overlap', idx });
  }
}
if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
process.on('exit', () => {
  if (holding) rmSync(join(dir, 'codex-active'), { force: true });
});
out({ type: 'thread.started', thread_id: 'thread-fake-0001' });
out({ type: 'turn.started' });
const mode = step.mode ?? 'ok';
if (mode === 'hang') await new Promise((r) => setTimeout(r, 120_000));
if (mode === 'limit') {
  out({ type: 'error', message: "You've hit your usage limit. Upgrade to Pro, or try again at 3:12 PM." });
  out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro, or try again at 3:12 PM." } });
  process.exit(1);
}
if (mode === 'auth') {
  out({ type: 'turn.failed', error: { message: '401 Unauthorized: invalid credentials' } });
  process.exit(1);
}
if (mode === 'forged-error') {
  const long = `${'x'.repeat(600)} usage limit reached usage limit`;
  out({ type: 'error', message: long });
  out({ type: 'turn.failed', error: { message: long } });
  process.exit(1);
}
if (mode === 'stderr-limit') {
  process.stderr.write('Error: rate limit exceeded, too many requests\n');
  process.exit(1);
}
if (mode === 'crash') {
  process.stderr.write('thread panicked at src/main.rs\n');
  process.exit(101);
}
if (mode === 'unknown-events') {
  out({ type: 'future.event', data: { anything: true } });
  out({ type: 'item.completed', item: { type: 'future_thing', id: 'x' } });
  out({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'Reading the repository.' } });
  out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a b', exit_code: 0, status: 'completed' } });
}
if (step.attemptWrite) {
  out({ type: 'item.started', item: { id: 'f1', type: 'command_execution', command: 'echo x > probe.txt', status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'f1', type: 'command_execution', command: 'echo x > probe.txt', aggregated_output: 'read-only file system', exit_code: 1, status: 'failed' } });
}
out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } });
if (outFile) writeFileSync(outFile, step.outText ?? text);
if (mode === 'no-completed') process.exit(0);
out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 150 } });
process.exit(0);
