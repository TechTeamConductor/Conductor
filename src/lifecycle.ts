// `conductor stop`, `restart` and `update`.
//
// Stopping is deliberately paranoid: a process is signalled only when it is verifiably a Conductor CLI server (full command-line shape,
// same owner, unchanged start time), never because a pid in a file or a port number says so. Everything that touches the system is behind
// small injectable dependencies so the decisions can be tested without killing anything.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir, uptime } from 'node:os';
import { basename, join } from 'node:path';
import { readLock } from './lock.ts';
import type { LockInfo } from './lock.ts';
import { paths } from './paths.ts';
import { plistPath, SERVICE_LABEL } from './service.ts';

export const DEFAULT_PORTS = [4327, 4328, 4329, 4330, 4331, 4332, 4333, 4334, 4335, 4336];
const REPO = 'TechTeamConductor/Conductor';

// ───────────────────────────── liveness (same rule as acquireLock) ─────────────────────────────
// TODO: move into src/lock.ts (next to isStale/inspect) once the stale-lock takeover fix is merged; kept here to avoid conflicting with it.
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock's holder when it is alive: the pid exists AND the lock was written after the last boot (a recycled pid is not a holder). */
export function liveLock(path: string = paths.lock()): LockInfo | null {
  const held = readLock(path);
  if (!held) return null;
  const bootedAt = Date.now() - uptime() * 1000 - 5000;
  return held.startedAt >= bootedAt && pidAlive(held.pid) ? held : null;
}

// ───────────────────────────── process identity ─────────────────────────────
export interface ProcInfo {
  uid: number | null;
  /** an opaque start-time token: equal tokens mean the same process instance */
  start: string | null;
  /** exact argv (Linux /proc) when known */
  argv: string[] | null;
  /** the flattened command line (ps) */
  command: string | null;
}

const PORT_ARGS = /^[0-9]+$/;
const isScript = (s: string): boolean => (s.startsWith('/') && s.endsWith('/bin/conductor.mjs')) || s === 'bin/conductor.mjs' || s === './bin/conductor.mjs';

/** `node [-flags] <…/bin/conductor.mjs> start|restart [--no-open] [--port N]` as an exact argv. */
export function matchesServerArgv(argv: readonly string[]): boolean {
  if (argv.length < 3 || basename(argv[0] as string) !== 'node') return false;
  let i = 1;
  while (i < argv.length && (argv[i] as string).startsWith('-')) i++;
  if (!isScript(argv[i] ?? '')) return false;
  if (argv[i + 1] !== 'start' && argv[i + 1] !== 'restart') return false;
  for (let j = i + 2; j < argv.length; j++) {
    const a = argv[j] as string;
    if (a === '--no-open') continue;
    if (a === '--port' && PORT_ARGS.test(argv[j + 1] ?? '')) { j++; continue; }
    return false;
  }
  return true;
}

const COMMAND_LINE = /^(?:\S*\/)?node(?:\s+-\S+)*\s+((?:\/.*?\/bin\/conductor\.mjs)|(?:\.?\/?bin\/conductor\.mjs))\s+(start|restart)((?:\s+--no-open|\s+--port\s+[0-9]+)*)\s*$/;

/** The same shape from a flattened `ps` line (spaces are only allowed inside an absolute script path). */
export function matchesServerCommandLine(line: string): boolean {
  if (line.includes('\n') || line.includes('\0')) return false;
  const m = COMMAND_LINE.exec(line.trim());
  if (!m) return false;
  const script = m[1] as string;
  return script === 'bin/conductor.mjs' || script === './bin/conductor.mjs' || (script.startsWith('/') && script.endsWith('/bin/conductor.mjs'));
}

export type Identity = { ok: true; start: string } | { ok: false; reason: string };

export function identifyServer(info: ProcInfo | null, ownUid: number | null): Identity {
  if (!info) return { ok: false, reason: 'the process could not be inspected (it may have just exited, or ps/proc is not available)' };
  if (ownUid === null || info.uid === null || info.uid !== ownUid) return { ok: false, reason: 'it belongs to another user (or its owner could not be read)' };
  if (!info.start) return { ok: false, reason: 'its start time could not be read' };
  const shaped = info.argv ? matchesServerArgv(info.argv) : info.command !== null && matchesServerCommandLine(info.command);
  if (!shaped) {
    const first = info.argv?.[0] ?? (info.command ?? '?').split(/\s+/)[0] ?? '?';
    return { ok: false, reason: `it is not a Conductor server (it is running: ${basename(first).slice(0, 60)})` }; // the executable name only: a command line can hold secrets
  }
  return { ok: true, start: info.start };
}

const run = (file: string, args: string[], timeoutMs = 5000): string | null => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

export function readProc(pid: number): ProcInfo | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/cmdline`)) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');
      if (argv[argv.length - 1] === '') argv.pop();
      const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; // field 22: starttime
      return { uid: uid ? Number(uid[1]) : null, start, argv, command: argv.join(' ') };
    } catch {
      return null;
    }
  }
  const ps = '/bin/ps';
  if (!existsSync(ps)) return null;
  // ONE ps call, so uid, start time and command line come from the same instant: `<uid> <Dow Mon dd hh:mm:ss yyyy> <command…>`
  const line = run(ps, ['-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='])?.split('\n')[0] ?? '';
  const m = /^\s*([0-9]+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})\s+(\S.*)$/.exec(line);
  if (!m) return null;
  return { uid: Number(m[1]), start: m[2] as string, argv: null, command: (m[3] as string).trim() };
}

/** Pids listening on a TCP port (via lsof, absolute path). `available` is false when lsof does not exist. */
export function listeners(port: number): { pids: number[]; available: boolean } {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { pids: [], available: true };
  const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => existsSync(p));
  if (!lsof) return { pids: [], available: false };
  const out = run(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']) ?? '';
  const pids = [...new Set([...out.matchAll(/^p([0-9]+)$/gm)].map((m) => Number(m[1])))];
  return { pids, available: true };
}

/** The pid launchd reports for the installed background service, if it is running. */
export function servicePid(): { running: boolean; pid: number | null } {
  if (process.platform !== 'darwin' || !existsSync(plistPath())) return { running: false, pid: null };
  const uid = process.getuid?.();
  if (uid === undefined) return { running: false, pid: null };
  const out = run('/bin/launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`]);
  if (!out || !/state = running/.test(out)) return { running: false, pid: null };
  const m = /\bpid = ([0-9]+)/.exec(out);
  return { running: true, pid: m ? Number(m[1]) : null };
}

/** A zombie has exited but its parent has not collected it yet: kill(pid,0) still succeeds for it, so it must not count as running. */
export function isZombie(pid: number): boolean {
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/stat`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
    } catch {
      return false;
    }
  }
  if (!existsSync('/bin/ps')) return false;
  return (run('/bin/ps', ['-p', String(pid), '-o', 'stat=']) ?? '').trim().startsWith('Z');
}

export const portInUse = (port: number): Promise<boolean> => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port, timeout: 500 });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('timeout', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(false));
});

// ───────────────────────────── stop ─────────────────────────────
export interface StopDeps {
  platform: NodeJS.Platform;
  uid: number | null;
  alive(pid: number): boolean;
  proc(pid: number): ProcInfo | null;
  listeners(port: number): { pids: number[]; available: boolean };
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void;
  servicePid(): { running: boolean; pid: number | null };
  portInUse(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  lock(): LockInfo | null;
  graceMs: number;
}

export function realStopDeps(): StopDeps {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? null,
    alive: (pid) => pidAlive(pid) && !isZombie(pid),
    proc: readProc,
    listeners,
    signal: (pid, sig) => { try { process.kill(pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } },
    servicePid,
    portInUse,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    lock: () => liveLock(),
    graceMs: 30_000,
  };
}

export interface StopResult { code: 0 | 1; lines: string[]; stopped: boolean; port: number | null }

const waitGone = async (pid: number, d: StopDeps, ms: number): Promise<boolean> => {
  for (let waited = 0; waited < ms; waited += 200) {
    if (!d.alive(pid)) return true;
    await d.sleep(200);
  }
  return !d.alive(pid);
};

/** Stop ONE verified Conductor server: identity, owner, port owner, start time, then SIGTERM; SIGKILL only with force and never for the service. */
export async function terminate(pid: number, d: StopDeps, o: { port: number | null; force: boolean }): Promise<StopResult> {
  const refuse = (why: string): StopResult => ({ code: 1, stopped: false, port: o.port, lines: [`Not stopping pid ${pid}: ${why}.`, `If you are sure, stop it yourself with:  kill ${pid}`] });
  const first = d.proc(pid);
  const id = identifyServer(first, d.uid);
  if (!id.ok) return refuse(id.reason);
  let crossChecked = true;
  if (o.port !== null) {
    const l = d.listeners(o.port);
    if (l.available && !l.pids.includes(pid)) return refuse(`it is not the process listening on port ${o.port}`);
    crossChecked = l.available;
  }
  const svc = d.servicePid();
  const managed = svc.running && (svc.pid === null || svc.pid === pid);
  if (managed && o.force) return refuse('it is managed by the Conductor background service, which must not be force-killed (stop it without --force; the service stays installed and starts again at your next login)');
  const again = d.proc(pid);
  const stillIt = identifyServer(again, d.uid);
  if (!stillIt.ok || stillIt.start !== id.start) return refuse('the process changed while it was being checked');
  d.signal(pid, 'SIGTERM');
  let gone = await waitGone(pid, d, d.graceMs);
  if (!gone) {
    if (!o.force) return { code: 1, stopped: false, port: o.port, lines: [`Conductor (pid ${pid}) did not stop within ${Math.round(d.graceMs / 1000)} s. It may be finishing a run; try again later, or force it with:  conductor stop --force`] };
    const last = d.proc(pid);
    if (!identifyServer(last, d.uid).ok || last?.start !== id.start) return refuse('the process changed before it could be force-stopped');
    d.signal(pid, 'SIGKILL');
    gone = await waitGone(pid, d, 3000);
    if (!gone) return { code: 1, stopped: false, port: o.port, lines: [`Could not stop pid ${pid} even with --force.`] };
  }
  const lines = [`Stopped Conductor (pid ${pid}).`];
  if (!crossChecked) lines.push(`Note: the pid was not cross-checked against the port owner (lsof is not installed).`);
  if (o.port !== null) {
    let busy = await d.portInUse(o.port);
    for (let i = 0; busy && i < 15; i++) { await d.sleep(200); busy = await d.portInUse(o.port); }
    lines.push(busy ? `Port ${o.port} is still in use by something else.` : `Port ${o.port} is free.`);
  }
  if (managed) lines.push('It was started by the background service: the service stays installed and starts again at your next login (conductor service uninstall removes it).');
  return { code: 0, stopped: true, port: o.port, lines };
}

export function parsePort(v: string | undefined): number | null {
  if (v === undefined || !/^[0-9]{4,5}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1024 && n <= 65535 ? n : null;
}

const WINDOWS_STOP = (pid: number | null): string[] => [
  'Stopping from the command line is not supported on Windows yet (experimental).',
  `Press Ctrl+C in the terminal where Conductor runs${pid ? `, or check that pid ${pid} is Conductor and run:  taskkill /PID ${pid}` : ''}.`,
];

/** `conductor stop [--port N] [--force]`. Default: this data folder's instance only; a port is stopped only when named explicitly. */
export async function runStop(opts: { port: number | null; force: boolean }, d: StopDeps): Promise<StopResult> {
  if (d.platform === 'win32') return { code: 1, stopped: false, port: null, lines: WINDOWS_STOP(readLock()?.pid ?? null) };
  if (opts.port !== null) {
    const l = d.listeners(opts.port);
    if (!l.available) return { code: 1, stopped: false, port: opts.port, lines: ['Cannot look up what listens on that port: lsof is not installed. Find the pid yourself and stop it with  kill <pid>'] };
    if (l.pids.length === 0) return { code: 0, stopped: false, port: opts.port, lines: [`Nothing is listening on port ${opts.port}.`] };
    const verdicts = l.pids.map((pid) => ({ pid, id: identifyServer(d.proc(pid), d.uid) }));
    const ours = verdicts.filter((v) => v.id.ok);
    const others = verdicts.filter((v) => !v.id.ok);
    const lines = others.map((v) => `Port ${opts.port} is used by pid ${v.pid}, which is not a Conductor server of yours (${(v.id as { reason: string }).reason}); leaving it alone.`);
    if (ours.length === 0) return { code: 1, stopped: false, port: opts.port, lines };
    if (ours.length > 1) return { code: 1, stopped: false, port: opts.port, lines: [...lines, `More than one Conductor listens on port ${opts.port} (pids ${ours.map((v) => v.pid).join(', ')}); stop them one by one with kill <pid>.`] };
    const r = await terminate((ours[0] as { pid: number }).pid, d, { port: opts.port, force: opts.force });
    return { ...r, lines: [...lines, ...r.lines] };
  }
  const lock = d.lock();
  if (lock) return terminate(lock.pid, d, { port: lock.port ?? null, force: opts.force });
  const lines = ['Conductor is not running (for this data folder).'];
  for (const port of DEFAULT_PORTS) {
    const l = d.listeners(port);
    if (!l.available) { lines.push('Could not scan the Conductor ports for other instances: lsof is not installed.'); break; }
    for (const pid of l.pids) {
      if (identifyServer(d.proc(pid), d.uid).ok) lines.push(`pid ${pid} (http://127.0.0.1:${port}) is a Conductor that does not belong to this data folder. Stop it with:  conductor stop --port ${port}`);
    }
  }
  return { code: 0, stopped: false, port: null, lines };
}

// ───────────────────────────── update ─────────────────────────────
const TAG_PREFIX = `https://github.com/${REPO}/releases/tag/`;
const TAG_RE = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/;
const VERSION_RE = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

/** The release tag from the final URL of the /releases/latest redirect, or null. */
export function tagFromUrl(url: string): string | null {
  if (!url.startsWith(TAG_PREFIX)) return null;
  const tag = url.slice(TAG_PREFIX.length);
  return TAG_RE.test(tag) ? tag : null;
}

/** >0 when a is newer than b; null when either is not a plain X.Y.Z (a dev or pre-release build). */
export function compareVersions(a: string, b: string): number | null {
  const x = VERSION_RE.exec(a);
  const y = VERSION_RE.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** The expected SHA-256 of `file` from SHA256SUMS.txt: exactly one `<64 lowercase hex>  <file>` line, else null. */
export function sumFor(sums: string, file: string): string | null {
  const re = new RegExp(`^([0-9a-f]{64})  ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const hits = sums.replace(/\r/g, '').split('\n').map((l) => re.exec(l)).filter((m): m is RegExpExecArray => m !== null);
  return hits.length === 1 ? (hits[0] as RegExpExecArray)[1] as string : null;
}

const ENV_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'CONDUCTOR_BIN_DIR'];

/** The ONLY environment the installer gets: an allow-list plus the values this command derived. Never tokens or other variables. */
export function buildUpdateEnv(env: NodeJS.ProcessEnv, o: { appDir: string; version: string | null; localDir: string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_PASSTHROUGH) if (typeof env[k] === 'string' && env[k] !== '') out[k] = env[k] as string;
  out.CONDUCTOR_INSTALL_DIR = o.appDir;
  if (o.version) out.CONDUCTOR_INSTALL_VERSION = o.version;
  if (o.localDir) out.CONDUCTOR_LOCAL_DIR = o.localDir;
  return out;
}

export interface UpdateDeps {
  platform: NodeJS.Platform;
  /** final URL after following redirects of a HEAD request, or null on failure */
  resolveLatest(url: string): string | null;
  /** download an https URL into a file; false on any failure (size/time capped) */
  download(url: string, dest: string): boolean;
  /** run the verified installer with this exact environment; the exit code */
  runInstaller(script: string, env: Record<string, string>): number;
  liveLock(): LockInfo | null;
  curlAvailable(): boolean;
}

const CURL = '/usr/bin/curl';
const CURL_FLAGS = ['--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--max-redirs', '5', '--max-time', '60', '--max-filesize', '1048576', '-fsSL'];
const CURL_TIMEOUT_MS = 70_000; // a little above curl's own --max-time, so slow links work and a hung curl is still cut off

/** `-q` must come first: it makes curl ignore ~/.curlrc, which could otherwise weaken the flags below. */
export function curlArgs(extra: string[]): string[] {
  return ['-q', ...CURL_FLAGS, ...extra];
}

export function realUpdateDeps(): UpdateDeps {
  return {
    platform: process.platform,
    resolveLatest: (url) => run(CURL, curlArgs(['-I', '-o', '/dev/null', '-w', '%{url_effective}', url]), CURL_TIMEOUT_MS)?.trim() || null,
    download: (url, dest) => run(CURL, curlArgs(['-o', dest, url]), CURL_TIMEOUT_MS) !== null && existsSync(dest),
    runInstaller: (script, env) => spawnSync('/bin/bash', [script], { env, stdio: 'inherit' }).status ?? 1,
    liveLock: () => liveLock(),
    curlAvailable: () => existsSync(CURL),
  };
}

const ONE_LINER = [
  'macOS / Linux:  curl -fsSL https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.sh | bash',
  'Windows:        irm https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.ps1 | iex',
];

export async function runUpdate(opts: { check: boolean }, ctx: { appDir: string; version: string; env: NodeJS.ProcessEnv }, d: UpdateDeps): Promise<{ code: 0 | 1; lines: string[] }> {
  const fail = (...lines: string[]): { code: 1; lines: string[] } => ({ code: 1, lines });
  if (d.platform === 'win32') return fail('Updating from the command line is not supported on Windows yet (files are locked while Conductor runs). Press Ctrl+C in the terminal where Conductor runs, then run this in PowerShell:', ONE_LINER[1] as string);
  if (!existsSync(join(ctx.appDir, '.conductor-installer'))) return fail('This copy of Conductor was not made by the installer (a git clone?), so it cannot update itself. Update a clone with:  git pull', 'Or install the packaged version:', ...ONE_LINER);
  const localDir = ctx.env.CONDUCTOR_LOCAL_DIR || null;
  const notices: string[] = [];
  let tag: string | null = null;
  if (localDir) {
    notices.push(`Using the local folder ${localDir}: its SHA256SUMS.txt only catches corruption, it does not prove where the files came from.`);
  } else {
    if (!d.curlAvailable()) return fail(`${CURL} was not found, so the update cannot be downloaded safely from here. Run the install command instead:`, ...ONE_LINER);
    const url = d.resolveLatest(`https://github.com/${REPO}/releases/latest`);
    tag = url ? tagFromUrl(url) : null;
    if (!tag) return fail('Could not find the latest release (no network, a proxy in the way, or no published release yet).');
    const latest = tag.slice(1);
    const cmp = compareVersions(latest, ctx.version);
    if (cmp !== null && cmp <= 0) return { code: 0, lines: [`Conductor ${ctx.version} is up to date (latest release: ${latest}).`] };
    if (opts.check) return { code: 0, lines: [`Update available: ${ctx.version} → ${latest}. Run:  conductor update`] };
    notices.push(`Updating ${ctx.version} → ${latest}.`);
  }
  if (opts.check) return { code: 0, lines: [...notices, 'Update from a local folder is available (--check does not run it).'] };
  const running = d.liveLock();
  if (running) return fail(`Conductor is running (pid ${running.pid}). Stop it first with  conductor stop , then run  conductor update  again.`);
  const dir = mkdtempSync(join(tmpdir(), 'conductor-update-'));
  try {
    const script = join(dir, 'install.sh');
    const sums = join(dir, 'SHA256SUMS.txt');
    if (localDir) {
      try {
        copyFileSync(join(localDir, 'install.sh'), script);
        copyFileSync(join(localDir, 'SHA256SUMS.txt'), sums);
      } catch {
        return fail('CONDUCTOR_LOCAL_DIR must hold install.sh and SHA256SUMS.txt.');
      }
    } else {
      const base = `https://github.com/${REPO}/releases/download/${tag}`;
      if (!d.download(`${base}/install.sh`, script) || !d.download(`${base}/SHA256SUMS.txt`, sums)) return fail('Could not download the installer (network problem or an incomplete release). Nothing was changed.');
    }
    const expect = sumFor(readFileSync(sums, 'utf8'), 'install.sh');
    if (!expect) return fail('SHA256SUMS.txt has no single valid line for install.sh, refusing to run it. Nothing was changed.');
    const actual = createHash('sha256').update(readFileSync(script)).digest('hex');
    if (actual !== expect) return fail('The downloaded installer does not match SHA256SUMS.txt, refusing to run it. Nothing was changed.');
    const env = buildUpdateEnv(ctx.env, { appDir: ctx.appDir, version: tag ? tag.slice(1) : null, localDir });
    const launcher = env.CONDUCTOR_BIN_DIR ?? join(ctx.env.HOME || homedir(), '.local', 'bin');
    const lines = [...notices, `Installing into ${ctx.appDir}, launcher in ${launcher}.`, 'If a Conductor for another data folder runs from this same app folder, stop it too (conductor stop --port <n>) before relying on the update.'];
    for (const l of lines) console.log(l);
    const code = d.runInstaller(script, env);
    return code === 0 ? { code: 0, lines: ['Updated. Start it with:  conductor start'] } : { code: 1, lines: ['The installer reported a problem (see above); the previous version was kept.'] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
