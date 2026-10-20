import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import type { AgentHealth } from './types.ts';
import { loadConfig } from './config.ts';
import { ensureHome, paths } from './paths.ts';
import { acquireLock, LockHeldError, readLock } from './lock.ts';
import { migrate, MigrateError } from './migrate.ts';
import { configureLog, logger, pruneLogs } from './log.ts';
import { createRuntime, VERSION } from './runtime.ts';
import { isolationProbe, probe, runChecks } from './doctor.ts';
import { installService, serviceStatus, uninstallService, plistPath } from './service.ts';
import { startDemo } from './demo.ts';
import { errMsg } from './util.ts';

const log = logger('cli');
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
  open               open a fresh signed-in dashboard tab (when it is already running)
  demo               try everything with scripted agents — no keys, no quota
  doctor             check your setup   [--isolation] [--probe]
  service install    keep Conductor running in the background (launchd)   [--dry-run]
  service uninstall  remove the background service
  service status
  migrate            import a Conductor v1 data folder into a NEW v2 folder, side by side   [--from <dir>] [--to <dir>] [--apply]
  uninstall          remove the background service   [--purge removes the data folder]
  version

Flags for start: --no-open (do not open a browser tab), --port <n>
`;

function openBrowser(url: string): void {
  if (process.platform === 'darwin') execFile('/usr/bin/open', [url], () => undefined);
  else console.log(`Open this link: ${url}`);
}

function controlRequest(path: string, method: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: paths.control(), path, method, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

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
    case 'open':
      return openCmd();
    case 'demo':
      return demo();
    case 'doctor':
      return doctor();
    case 'service':
      return service();
    case 'migrate':
      return migrateCmd();
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
    else if (r.published) console.log(`\nDone. Start v2 with:  CONDUCTOR_HOME=${to} npm start   (or just  npm start  when ${to} is the default).\nYour v1 folder is untouched and keeps working. Nothing was written to Linear; the old Linear API key is still in your macOS Keychain (service "techteam-conductor", account "linear-api-key") — v2 never reads it; delete it yourself when you are sure you no longer need v1.`);
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
      console.log(`${e.message}\nOpen the dashboard with:  npm run open   (or: conductor open)`);
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
  await rt.server.listenControl(paths.control());
  rt.engine.start();
  const loginTarget = rt.server.loginFile(paths.runtime()) || rt.server.loginUrl();
  const url = `http://127.0.0.1:${port}`;
  console.log(`\nConductor ${VERSION} is running → http://127.0.0.1:${port}\nHome: ${paths.home()}\nStop with Ctrl+C. Reopen the dashboard any time with:  npm run open\n`);
  if (!flag('--no-open') && cfg.ui.openBrowser) openBrowser(loginTarget);
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

async function openCmd(): Promise<void> {
  const info = readLock();
  if (!info || !existsSync(paths.control())) {
    console.error('Conductor is not running. Start it with:  npm start');
    process.exit(1);
  }
  try {
    const r = await controlRequest('/otp', 'POST');
    openBrowser(r.file || r.url);
    console.log('Opened the dashboard in your browser (the sign-in link works once).');
  } catch (e) {
    console.error(`Could not reach the running Conductor: ${errMsg(e)}`);
    process.exit(1);
  }
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
  if (flag('--isolation')) {
    console.log('\nIsolation probe (one tiny Claude call in a canary repo)…');
    const r = await isolationProbe(cfg);
    console.log(` ${r.ok ? '✓' : '✗'} ${r.note}`);
    console.log(`   init predicate: ${r.initOk ? 'ok' : `FAILED — ${r.initReason}`} · project CLAUDE.md loaded: ${r.projectClaudeMdLoaded} · ancestor file loaded: ${r.ancestorLoaded} · your user rules loaded: ${r.userRulesLoaded}${r.limited ? `\n   (account is at its usage limit: ${r.limited}; the transcript check still ran)` : ''}`);
    if (!r.ok) failed = true;
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
  const cfg = loadConfig();
  if (sub === 'install') {
    const r = await installService(cfg, { dryRun: flag('--dry-run') });
    if (flag('--dry-run')) {
      console.log(`# Would write ${r.path}\n${r.plist}`);
    } else console.log(`Installed ${r.path}. Conductor now starts at login and restarts if it stops.\nDashboard: npm run open`);
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
  await uninstallService();
  console.log('Removed the background service.');
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
