import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { AgentHealth } from './types.ts';
import { loadConfig, resolveBin, saveConfig } from './config.ts';
import { runCodexCanary } from './agents/providers/canary.ts';
import { addRecord } from './agents/providers/verification.ts';
import { CURSOR_GUARD_JSON } from './git/worktree.ts';
import { assertHomeIsUsable, ensureHome, paths } from './paths.ts';
import { ModelService } from './models/service.ts';
import type { CatalogView } from './models/types.ts';
import { acquireLock, LockHeldError, readLock } from './lock.ts';
import { migrate, MigrateError } from './migrate.ts';
import { configureLog, logger, pruneLogs } from './log.ts';
import { createRuntime, VERSION } from './runtime.ts';
import { agentHealth, isolationProbe, probe, runChecks } from './doctor.ts';
import { installService, serviceStatus, uninstallService, plistPath } from './service.ts';
import { startDemo } from './demo.ts';
import { parsePort, realStopDeps, realUpdateDeps, runStop, runUpdate } from './lifecycle.ts';
import { errMsg, sha256 } from './util.ts';
import { accountsCli, socketClient } from './accounts/cli.ts';
import { AccountService } from './accounts/service.ts';

const log = logger('cli');
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const HELP = `Conductor ${VERSION} — a board → Claude plans → Cursor builds → Claude verifies

Usage: conductor <command>

  start              run Conductor and open the dashboard (default)
  stop               stop the running Conductor   [--port <n> stops the Conductor listening on that port] [--force]
  restart            stop it and start it again   [--no-open] [--port <n>]
  update             update to the latest release   [--check only reports]
  demo               try everything with scripted agents — no keys, no quota
  doctor             check your setup   [--isolation [claude|codex]] [--probe] [--verify-build cursor] [--clear-block codex] [--yes]
  service install    keep Conductor running in the background (macOS launchd only)   [--dry-run]
  service uninstall  remove the background service
  service status
  models             show the models each tool offers   [--refresh] [--json]
  accounts           more sign-ins per tool: list | add | login | check | move | remove   (conductor accounts help)
  migrate            import a Conductor v1 data folder into a NEW v2 folder, side by side   [--from <dir>] [--to <dir>] [--apply]
  uninstall          remove the background service   [--purge removes the data folder]
  version

Flags for start: --no-open (do not open a browser tab), --port <n>
`;

function openBrowser(url: string): void {
  // CONDUCTOR_NO_OPEN=1 (exactly "1"): never launch a browser, just print the link (headless machines, CI, tests)
  if (process.env.CONDUCTOR_NO_OPEN === '1') {
    console.log(`Open this link: ${url}`);
    return;
  }
  if (process.platform === 'darwin') execFile('/usr/bin/open', [url], () => undefined);
  else if (process.platform === 'win32') {
    // explorer.exe hands the file to the default browser (it exits non-zero even on success, so the exit code is ignored)
    execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [url], () => undefined);
    console.log(`If no browser opened, open this link: ${url}`);
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    execFile('xdg-open', [url], () => undefined);
    console.log(`If no browser opened, open this link: ${url}`);
  } else console.log(`Open this link: ${url}`);
}

/** Shown on every start under Windows: the installer and dashboard work, the rest of the product is not ported yet. */
const WINDOWS_NOTICE = `Windows support is EXPERIMENTAL. The dashboard runs, but registering repositories, running gates and launching the claude / agent CLIs are not ported yet.
For the full product use WSL2 (install and run Conductor inside it) or a Mac.\n`;

const mark = (l: 'ok' | 'warn' | 'fail') => (l === 'ok' ? '✓' : l === 'warn' ? '!' : '✗');

async function main(): Promise<void> {
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      return void console.log(HELP);
    case 'version':
    case '--version':
      return void console.log(VERSION);
    case 'start':
      return start();
    case 'stop':
      return stopCmd();
    case 'restart':
      return restartCmd();
    case 'update':
      return updateCmd();
    case 'demo':
      return demo();
    case 'doctor':
      return doctor();
    case 'service':
      return service();
    case 'migrate':
      return migrateCmd();
    case 'models':
      return modelsCmd();
    case 'accounts':
      return accountsCmd();
    case 'uninstall':
      return uninstall();
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exit(2);
  }
}

async function migrateCmd(): Promise<void> {
  const from = opt('--from') ?? join(homedir(), '.conductor');
  const to = opt('--to') ?? paths.home();
  try {
    const r = await migrate({ from, to, apply: flag('--apply') });
    console.log(`${r.dryRun ? 'DRY RUN — nothing was written anywhere.' : r.published ? 'Imported.' : 'Not published.'}\n  from  ${r.from}  (read-only; never modified)\n  to    ${r.to}\n`);
    for (const p of r.projects) console.log(`  project ${p.key}${p.repo ? ` → repository "${p.repo}"` : ' (no repository set yet)'}: ${p.cards} card(s)`);
    for (const x of r.runs) console.log(`  ${x.oldKey}${x.oldKey === x.newKey ? '' : ` → ${x.newKey}`}  ${x.status} → lane ${x.lane}${x.note ? `\n      ${x.note}` : ''}`);
    for (const w of r.warnings) console.log(` ! ${w}`);
    if (r.willRun) {
      // C-5: the imported config is not just data — these commands run as you at the next setup/gate/stage
      console.log('\nThe imported settings will RUN these on your machine (check them — only migrate a folder you created):');
      console.log(`  agent binaries: claude="${r.willRun.agentBins.claude}"  cursor="${r.willRun.agentBins.cursor}"`);
      for (const x of r.willRun.repos) {
        console.log(`  repository "${x.name}" at ${x.path}`);
        console.log(`    setup:  ${x.setup ?? '(auto-detected)'}`);
        console.log(`    gates:  ${x.gates.length ? x.gates.join('  |  ') : '(none)'}`);
        if (x.envPassthrough.length) console.log(`    passes these environment variables to gates: ${x.envPassthrough.join(', ')}`);
        if (x.copyFiles.length) console.log(`    copies these ignored files into worktrees: ${x.copyFiles.join(', ')}`);
      }
    }
    if (r.backupDir) console.log(`\nBackup copy of what was read: ${r.backupDir}`);
    if (r.dryRun) console.log('\nLooks right? Run the same command with --apply to create the v2 folder.');
    else if (r.published) console.log(`\nDone. Start v2 with:  CONDUCTOR_HOME=${to} conductor start   (or just  conductor start  when ${to} is the default).\nYour v1 folder is untouched and keeps working. Nothing was written to Linear; the old Linear API key is still in your macOS Keychain (service "techteam-conductor", account "linear-api-key") — v2 never reads it; delete it yourself when you are sure you no longer need v1.`);
  } catch (e) {
    if (e instanceof MigrateError) {
      console.error(`migrate: ${e.message}`);
      process.exit(e.code === 'target_exists' || e.code === 'changed_during_import' || e.code === 'target_changed' ? 3 : 2);
    }
    throw e;
  }
}

async function start(): Promise<void> {
  ensureHome();
  pruneLogs();
  let lock;
  try {
    lock = acquireLock(paths.lock());
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.log(e.message);
      if (!flag('--no-open') && openBrowserSetting() && e.info.port) openBrowser(`http://127.0.0.1:${e.info.port}/`);
      process.exit(0);
    }
    throw e;
  }
  const cfg = loadConfig();
  const rt = await createRuntime();
  const want = Number(opt('--port')) || cfg.ui.port;
  let port = 0;
  for (let p = want; p < want + 10 && !port; p++) {
    try {
      port = await rt.server.listen(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!port) {
    console.error(`Ports ${want}–${want + 9} are all busy. Free one or choose another with --port.`);
    process.exit(1);
  }
  lock.update({ port });
  try {
    await rt.server.listenControl(paths.control());
  } catch (e) {
    // S11 / code review N2: a run folder that is not private ⇒ NO control socket (the dashboard still starts); `conductor accounts` then refuses
    // (its direct mode cannot take the lock this server holds), so there is never a second config writer
    log.warn(`control socket not opened: ${errMsg(e)}`);
    console.error(`Note: the control socket was not opened (${errMsg(e)}). \`conductor accounts\` cannot reach this server until the folder is fixed.`);
  }
  rt.engine.start();
  rt.warmUp(); // R2-N1: one background zero-quota health read, so a headless start discovers models too
  const url = `http://127.0.0.1:${port}/`;
  console.log(`\nConductor ${VERSION} is running → http://127.0.0.1:${port}\nHome: ${paths.home()}\nStop with Ctrl+C.\n`);
  if (process.platform === 'win32') console.log(WINDOWS_NOTICE);
  if (!flag('--no-open') && cfg.ui.openBrowser) openBrowser(url);
  const shutdown = async (sig: string) => {
    log.info(`${sig}: shutting down`);
    try {
      await rt.close();
    } finally {
      lock.release();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Same allow-listed view as GET /api/models (S14). */
function printModels(views: CatalogView[]): void {
  if (flag('--json')) return void console.log(JSON.stringify({ providers: views }, null, 2));
  for (const v of views) {
    const when = v.fetchedAt ? new Date(v.fetchedAt).toLocaleString() : '—';
    const count = v.models ? `${v.models.length} model(s)` : 'no list';
    console.log(`${v.provider.padEnd(7)} ${v.state.padEnd(11)} ${count.padEnd(14)} fetched ${when}   CLI ${v.cliVersion ?? '—'}${v.signedIn === false ? '   (signed out)' : ''}`);
    if (v.reason) console.log(`        ${v.reason}`);
  }
}

async function modelsCmd(): Promise<void> {
  assertHomeIsUsable();
  ensureHome();
  configureLog({ level: 'error' });
  const cfg = loadConfig();
  const svc = () => new ModelService({ getConfig: () => cfg });
  if (!flag('--refresh')) return printModels(svc().viewAll());
  // N6/R2-N4: never discover beside a running server (its in-memory view would go stale). acquireLock refuses while a live server holds
  // it (readLock + pid-alive inside); we then hold it ourselves for the duration of our refresh, so a server starting meanwhile cannot race us.
  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock(paths.lock());
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.log('Conductor is running — use Refresh models in Settings. The saved lists:\n');
      return printModels(svc().viewAll());
    }
    throw e;
  }
  try {
    const s = svc();
    for (const p of ['claude', 'cursor'] as const) {
      const h = await agentHealth(cfg, p);
      s.noteVersion(p, h.version ?? null); // records the version the catalog is stamped with (Cursor's list has none)
      await s.refresh(p, 'manual');
    }
    printModels(s.viewAll());
  } finally {
    lock.release();
  }
}

/** M8-3 §2.8 / S13: through the running server's control socket, or directly under the lock (held for the whole command). */
async function accountsCmd(): Promise<void> {
  assertHomeIsUsable();
  ensureHome();
  configureLog({ level: 'error' });
  const running = readLock();
  const control = running && existsSync(paths.control()) ? socketClient(paths.control()) : null;
  const code = await accountsCli(argv.slice(1), {
    control,
    direct: async () => {
      const lock = acquireLock(paths.lock()); // LockHeldError ⇒ a server started meanwhile: the command fails, nothing is written
      let cfg = loadConfig();
      let ref: AccountService | null = null;
      // discovery for a named account gets the account env (pre-flight + assertion) and holds its S9 lease until the child was reaped
      const models = new ModelService({ getConfig: () => cfg, envFor: (p, a) => ref!.envFor(p, a), afterDiscovery: (p, a) => ref?.afterDiscovery(p, a) });
      const svc = new AccountService({ getConfig: () => cfg, saveConfig: (c) => { saveConfig(c); cfg = c; }, models });
      ref = svc;
      return { svc, release: () => { models.stop(); lock.release(); } };
    },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
  process.exitCode = code;
}

/** `ui.openBrowser` from config.json, read-only: never writes, renames or quarantines (another Conductor owns the data folder). Default true. */
function openBrowserSetting(): boolean {
  try {
    const v = JSON.parse(readFileSync(paths.config(), 'utf8')) as { ui?: { openBrowser?: unknown } };
    return v?.ui?.openBrowser !== false;
  } catch {
    return true;
  }
}

function portOption(): number | null | undefined {
  const raw = opt('--port');
  if (raw === undefined) return undefined;
  const p = parsePort(raw);
  if (p === null) {
    console.error('--port must be a whole number between 1024 and 65535.');
    process.exit(2);
  }
  return p;
}

async function stopCmd(): Promise<void> {
  const r = await runStop({ port: portOption() ?? null, force: flag('--force') }, realStopDeps());
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}

async function restartCmd(): Promise<void> {
  const explicit = portOption();
  const r = await runStop({ port: null, force: false }, realStopDeps());
  for (const l of r.lines) console.log(l);
  if (r.code !== 0) {
    console.error('Not restarting: the running Conductor could not be stopped.');
    process.exit(r.code);
  }
  if (explicit === undefined && r.port !== null && parsePort(String(r.port)) !== null) argv.push('--port', String(r.port)); // keep the port the old instance used
  console.log(r.stopped ? 'Restarting Conductor …' : 'Starting Conductor …');
  return start();
}

async function updateCmd(): Promise<void> {
  const r = await runUpdate({ check: flag('--check') }, { appDir: ROOT_DIR, version: VERSION, env: process.env }, realUpdateDeps());
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}

async function demo(): Promise<void> {
  const d = await startDemo({ port: Number(opt('--port')) || undefined });
  console.log(`\nConductor DEMO is running (scripted agents, a throw-away board — nothing real is touched).\n\n  ${d.url}\n\nThree sample tasks are queued: one waits for your plan approval, one shows the bug-fix loop, one asks you a question.\nCreate your own with “New task”. Stop with Ctrl+C.\n`);
  if (!flag('--no-open')) openBrowser(d.url);
  const stop = async () => {
    await d.close();
    rmSync(d.home, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

async function doctor(): Promise<void> {
  ensureHome();
  const cfg = loadConfig();
  configureLog({ level: 'error' });
  const checks = await runChecks(cfg); // never opens the board (it must work while the app is running)
  console.log(`Conductor ${VERSION} — setup check\n`);
  for (const c of checks) console.log(` ${mark(c.level)} ${c.label.padEnd(28)} ${c.detail}`);
  let failed = checks.some((c) => c.level === 'fail');
  if (flag('--isolation') && opt('--isolation') === 'codex') {
    // the Codex isolation canary: a model must run shell commands, so it spends quota — never without --yes
    if (!flag('--yes')) {
      console.log('\nThe Codex isolation check calls the model and uses your plan\'s quota. Re-run with --yes to run it.');
      process.exit(2);
    }
    console.log('\nCodex isolation check (two short model runs in scratch folders; nothing in your repositories is touched)…');
    const rep = await runCodexCanary({ bin: cfg.agents.codex.bin });
    for (const i of rep.items) console.log(` ${i.outcome === 'pass' ? '✓' : i.outcome === 'fail' ? '✗' : i.outcome === 'info' ? 'i' : '?'} ${i.id.padEnd(16)} ${i.detail}`);
    if (rep.binding) addRecord({ provider: 'codex', kind: 'readOnly', verdict: rep.verdict, source: 'canary', binding: rep.binding, at: rep.ranAt, items: rep.items.map((i) => ({ id: i.id, outcome: i.outcome })) });
    console.log(`\nResult: ${rep.verdict.toUpperCase()} — ${rep.verdict === 'pass' ? 'Codex may be used for read-only roles (tier: partial, like Cursor).' : rep.verdict === 'blocked' ? 'Codex is BLOCKED for every role until a later check passes.' : 'nothing was proven; Codex stays "unverified".'}`);
    if (rep.verdict === 'blocked') failed = true;
  } else if (flag('--isolation')) {
    console.log('\nIsolation probe (one tiny Claude call in a canary repo)…');
    const r = await isolationProbe(cfg);
    console.log(` ${r.ok ? '✓' : '✗'} ${r.note}`);
    console.log(`   init predicate: ${r.initOk ? 'ok' : `FAILED — ${r.initReason}`} · project CLAUDE.md loaded: ${r.projectClaudeMdLoaded} · ancestor file loaded: ${r.ancestorLoaded} · your user rules loaded: ${r.userRulesLoaded}${r.limited ? `\n   (account is at its usage limit: ${r.limited}; the transcript check still ran)` : ''}`);
    if (!r.ok) failed = true;
  }
  if (opt('--clear-block')) {
    // a sticky `blocked` that no check can clear would be a trap: the user can clear it on purpose (recorded, add-only — the next check decides again)
    if (opt('--clear-block') !== 'codex') {
      console.log('\nOnly a Codex block can be cleared.');
      process.exit(2);
    }
    addRecord({ provider: 'codex', kind: 'readOnly', verdict: 'inconclusive', source: 'user-clear', binding: { cliVersion: 'cleared', binSha256: null, argvDigest: sha256('cleared'), privateConfigSha: sha256('cleared'), canaryVersion: 0 }, at: Date.now() });
    console.log('\nThe Codex block was cleared. Codex is "unverified" again until a new isolation check says otherwise.');
  }
  if (opt('--verify-build')) {
    const who = opt('--verify-build');
    if (who !== 'cursor') {
      console.log(`\nOnly Cursor can be re-verified for building (the repo's live suite): "${who}" is not a builder.`);
      process.exit(2);
    }
    if (!flag('--yes')) {
      console.log('\nRe-verifying Cursor runs the live no-push attack suite against the real CLI and uses your plan\'s quota. Re-run with --yes to run it.');
      process.exit(2);
    }
    const suite = join(ROOT_DIR, 'test', 'live', 'cursor-nopush.test.ts');
    console.log('\nRunning the live no-push suite (test/live/cursor-nopush.test.ts)…');
    const r = spawnSync(process.execPath, ['--test', '--import', join(ROOT_DIR, 'test', 'preload.ts'), suite], { env: { ...process.env, LIVE: '1' }, stdio: 'inherit', cwd: ROOT_DIR });
    if (r.status === 0) {
      const v = spawnSync(resolveBin(cfg.agents.cursor.bin) ?? cfg.agents.cursor.bin, ['--version'], { encoding: 'utf8' });
      const ver = /(\d+(?:\.\d+)+)/.exec(String(v.stdout))?.[1] ?? 'unknown';
      addRecord({ provider: 'cursor', kind: 'build', verdict: 'pass', source: 'live-suite', suite: 'cursor-nopush', suiteDigest: sha256(readFileSync(suite)), binding: { cliVersion: ver, binSha256: null, argvDigest: sha256('cursor-build-v1'), privateConfigSha: sha256(CURSOR_GUARD_JSON), canaryVersion: 1 }, at: Date.now() });
      console.log(`\n✓ Cursor ${ver}: the live suite passed and was recorded.`);
    } else {
      console.log('\n✗ The live suite did not pass — nothing was recorded.');
      failed = true;
    }
  }
  if (flag('--probe')) {
    console.log('\nProbes (may use a tiny amount of quota)…');
    for (const t of ['claude', 'cursor'] as const) {
      const r = await probe(cfg, t);
      console.log(` ${r.ok ? '✓' : '✗'} ${t.padEnd(8)} ${r.detail} (${r.durationMs} ms)`);
      if (!r.ok) failed = true;
    }
  }
  const h: AgentHealth | undefined = undefined;
  void h;
  process.exit(failed ? 1 : 0);
}

async function service(): Promise<void> {
  const sub = argv[1];
  if (process.platform !== 'darwin') {
    console.error('The background service is only available on macOS (launchd). On this system run `conductor start` in a terminal, or use your own service manager.');
    process.exit(1);
  }
  const cfg = loadConfig();
  if (sub === 'install') {
    const r = await installService(cfg, { dryRun: flag('--dry-run') });
    if (flag('--dry-run')) {
      console.log(`# Would write ${r.path}\n${r.plist}`);
    } else console.log(`Installed ${r.path}. Conductor now starts at login and restarts if it stops.`);
    for (const n of r.notes) console.log(` ! ${n}`);
    return;
  }
  if (sub === 'uninstall') {
    const r = await uninstallService();
    return void console.log(r.removed ? 'Background service removed.' : 'No background service was installed.');
  }
  if (sub === 'status') {
    const s = await serviceStatus();
    return void console.log(`${s.installed ? 'installed' : 'not installed'} (${s.detail})${s.running ? ', running' : ''}\n${plistPath()}`);
  }
  console.error('Usage: conductor service install|uninstall|status');
  process.exit(2);
}

async function uninstall(): Promise<void> {
  // refuse to purge anything that is not a v2 data folder BEFORE touching the service or the disk (security review B-8)
  if (flag('--purge') && !existsSync(join(paths.home(), 'home.json'))) {
    console.error(`Refusing to delete ${paths.home()}: it is not a Conductor v2 data folder (no home.json marker).`);
    process.exit(2);
  }
  if (process.platform === 'darwin') {
    await uninstallService();
    console.log('Removed the background service.');
  } else console.log('There is no background service on this system (it is macOS only), nothing to remove there.');
  if (flag('--purge')) {
    if (!existsSync(join(paths.home(), 'home.json'))) {
      console.error(`Refusing to delete ${paths.home()}: it is not a Conductor v2 data folder (no home.json marker).`);
      process.exit(2);
    }
    rmSync(paths.home(), { recursive: true, force: true });
    console.log(`Deleted ${paths.home()}.`);
  } else console.log(`Your settings and run history are still in ${paths.home()} (use --purge to delete them).`);
}

main().catch((e) => {
  console.error(`conductor: ${errMsg(e)}`);
  process.exit(1);
});
