import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import type { AgentHealth } from './types.ts';
import { loadConfig } from './config.ts';
import { ensureHome, paths } from './paths.ts';
import { acquireLock, LockHeldError, readLock } from './lock.ts';
import { configureLog, logger, pruneLogs } from './log.ts';
import { createRuntime, VERSION } from './runtime.ts';
import { isolationProbe, probe, runChecks } from './doctor.ts';
import { installService, serviceStatus, uninstallService, plistPath } from './service.ts';
import { startDemo } from './demo.ts';
import { SECRET_LINEAR, defaultSecretStore, dropSecret } from './secrets.ts';
import { errMsg } from './util.ts';

const log = logger('cli');
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const HELP = `Conductor ${VERSION} — Linear → Claude plans → Cursor builds → Claude verifies

Usage: conductor <command>

  start              run Conductor and open the dashboard (default)
  open               open a fresh signed-in dashboard tab (when it is already running)
  demo               try everything with scripted agents — no keys, no quota
  doctor             check your setup   [--isolation] [--probe] [--linear]
  service install    keep Conductor running in the background (launchd)   [--dry-run]
  service uninstall  remove the background service
  service status
  uninstall          remove the service and the stored Linear key   [--purge removes ~/.conductor]
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
    case 'uninstall':
      return uninstall();
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exit(2);
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
  await rt.refreshLinear();
  rt.engine.start();
  const url = rt.server.loginUrl();
  console.log(`\nConductor ${VERSION} is running → http://127.0.0.1:${port}\nHome: ${paths.home()}\nStop with Ctrl+C. Reopen the dashboard any time with:  npm run open\n`);
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

async function openCmd(): Promise<void> {
  const info = readLock();
  if (!info || !existsSync(paths.control())) {
    console.error('Conductor is not running. Start it with:  npm start');
    process.exit(1);
  }
  try {
    const r = await controlRequest('/otp', 'POST');
    openBrowser(r.url);
    console.log('Opened the dashboard in your browser (the sign-in link works once).');
  } catch (e) {
    console.error(`Could not reach the running Conductor: ${errMsg(e)}`);
    process.exit(1);
  }
}

async function demo(): Promise<void> {
  const d = await startDemo({ port: Number(opt('--port')) || undefined });
  console.log(`\nConductor DEMO is running (scripted agents, in-memory Linear — nothing real is touched).\n\n  ${d.url}\n\nThree sample tasks are queued: one waits for your plan approval, one shows the bug-fix loop, one asks you a question.\nCreate your own with “New task”. Stop with Ctrl+C.\n`);
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
  let linear = null;
  try {
    const rt = await createRuntime({ ephemeral: true, config: cfg });
    linear = rt.linearRef.port;
    await rt.close();
  } catch {
    /* no linear */
  }
  const checks = await runChecks(cfg, { linear });
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
  if (flag('--linear')) {
    console.log('\nLinear (read-only)…');
    const r = await probe(cfg, 'linear', linear);
    console.log(` ${r.ok ? '✓' : '✗'} ${r.detail}`);
    if (!r.ok) failed = true;
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
  await uninstallService();
  await dropSecret(defaultSecretStore(), SECRET_LINEAR);
  console.log('Removed the background service and the stored Linear key.');
  if (flag('--purge')) {
    rmSync(paths.home(), { recursive: true, force: true });
    console.log(`Deleted ${paths.home()}.`);
  } else console.log(`Your settings and run history are still in ${paths.home()} (use --purge to delete them).\nLinear labels/statuses created by Conductor are left in place — remove them in Linear if you like.`);
}

main().catch((e) => {
  console.error(`conductor: ${errMsg(e)}`);
  process.exit(1);
});
