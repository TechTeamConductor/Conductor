// The environment report for the onboarding wizard (M6): OS/arch, Node and git versions. Informational — it changes no behaviour.
import { execFileSync } from 'node:child_process';
import { arch, platform, release } from 'node:os';
export interface EnvReport { os: string; arch: string; release: string; node: string; nodeOk: boolean; git: string | null; gitOk: boolean }
export function environmentReport(): EnvReport {
  let git: string | null = null;
  try {
    git = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^git version /, '').slice(0, 40);
  } catch { /* not installed */ }
  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  return { os: platform(), arch: arch(), release: release().slice(0, 40), node: process.versions.node, nodeOk: maj > 22 || (maj === 22 && min >= 18), git, gitOk: !!git };
}
