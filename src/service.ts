import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveBin } from './config.ts';
import { paths } from './paths.ts';
import type { Config } from './types.ts';

/** v2's own launchd label: installing v2's service must never overwrite or remove v1's launch agent (security review B-7). */
export const SERVICE_LABEL = 'com.techteam.conductor-v2';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const plistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PlistInput {
  node: string;
  script: string;
  workdir: string;
  path: string;
  home: string;
  logDir: string;
  conductorHome?: string;
}

/** launchd agent that keeps Conductor running (absolute paths everywhere — launchd has a minimal PATH). */
export function buildPlist(i: PlistInput): string {
  const env: Record<string, string> = { PATH: i.path, HOME: i.home };
  if (i.conductorHome) env.CONDUCTOR_HOME = i.conductorHome;
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(i.node)}</string>
    <string>${esc(i.script)}</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(i.workdir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${esc(join(i.logDir, 'service.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(i.logDir, 'service.err.log'))}</string>
</dict>
</plist>
`;
}

export function servicePath(cfg: Config): string {
  const dirs = new Set<string>();
  for (const b of [cfg.agents.claude.bin, cfg.agents.cursor.bin, 'git', 'pnpm', 'yarn', 'bun', 'npm', 'node']) {
    const p = resolveBin(b);
    if (p) dirs.add(dirname(p));
  }
  dirs.add(dirname(process.execPath));
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) dirs.add(d);
  return [...dirs].join(':');
}

export function plistFor(cfg: Config): string {
  return buildPlist({
    node: process.execPath,
    script: join(ROOT, 'bin', 'conductor.mjs'),
    workdir: ROOT,
    path: servicePath(cfg),
    home: homedir(),
    logDir: paths.logs(),
    conductorHome: process.env.CONDUCTOR_HOME,
  });
}

function launchctl(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('/bin/launchctl', args, { timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export async function installService(cfg: Config, opts: { dryRun?: boolean } = {}): Promise<{ plist: string; path: string; notes: string[] }> {
  const plist = plistFor(cfg);
  const notes: string[] = [];
  if (cfg.repos.some((r) => r.path.startsWith('/Volumes/'))) notes.push('One or more repositories are on an external drive: if the drive is not mounted at login, runs for them wait until it is (the service restarts automatically).');
  if (opts.dryRun) return { plist, path: plistPath(), notes };
  mkdirSync(dirname(plistPath()), { recursive: true });
  mkdirSync(paths.logs(), { recursive: true });
  writeFileSync(plistPath(), plist, { mode: 0o644 });
  const uid = process.getuid?.() ?? 501;
  await launchctl(['bootout', `gui/${uid}/${SERVICE_LABEL}`]);
  const r = await launchctl(['bootstrap', `gui/${uid}`, plistPath()]);
  if (r.code !== 0) notes.push(`launchctl said: ${r.out || `exit ${r.code}`}`);
  return { plist, path: plistPath(), notes };
}

export async function uninstallService(): Promise<{ removed: boolean }> {
  const uid = process.getuid?.() ?? 501;
  await launchctl(['bootout', `gui/${uid}/${SERVICE_LABEL}`]);
  if (existsSync(plistPath())) {
    unlinkSync(plistPath());
    return { removed: true };
  }
  return { removed: false };
}

export async function serviceStatus(): Promise<{ installed: boolean; running: boolean; detail: string }> {
  const uid = process.getuid?.() ?? 501;
  const r = await launchctl(['print', `gui/${uid}/${SERVICE_LABEL}`]);
  return { installed: existsSync(plistPath()), running: r.code === 0 && /state = running/.test(r.out), detail: r.code === 0 ? 'loaded' : 'not loaded' };
}
