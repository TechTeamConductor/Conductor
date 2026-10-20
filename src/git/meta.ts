import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, gitOk } from './exec.ts';

/** Repo-local git settings that cause code execution or redirect pushes. Everything else in .git/config is ignored. */
const DANGEROUS_KEY = /^(core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|attributesfile|excludesfile)|alias\.|credential\.|url\.|include\.|includeif\.|filter\.|remote\..*\.(pushurl|url|proxy|receivepack|uploadpack)|diff\..*\.(command|textconv)|merge\..*\.driver|http\.|gpg\.|sequence\.editor|protocol\.|safe\.)/i;

export interface GitMeta {
  gitDir: string;
  repo: string;
  config: Map<string, string[]>;
  hooks: Map<string, Buffer>;
}

async function readConfig(repo: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const r = await git(repo, ['config', '--local', '--null', '--list']);
  if (r.code !== 0) return out;
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const i = rec.indexOf('\n');
    const key = (i >= 0 ? rec.slice(0, i) : rec).toLowerCase();
    const val = i >= 0 ? rec.slice(i + 1) : '';
    if (!DANGEROUS_KEY.test(key)) continue;
    out.set(key, [...(out.get(key) ?? []), val]);
  }
  return out;
}

async function readHooks(gitDir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  try {
    for (const f of await readdir(join(gitDir, 'hooks'))) {
      if (f.endsWith('.sample')) continue;
      try {
        out.set(f, await readFile(join(gitDir, 'hooks', f)));
      } catch {
        /* directories etc. */
      }
    }
  } catch {
    /* no hooks dir */
  }
  return out;
}

/** Take this right before an agent runs; compare/restore right after (M8: a builder must not plant persistent code execution). */
export async function snapshotGitMeta(repo: string): Promise<GitMeta> {
  const gitDir = await gitOk(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { gitDir, repo, config: await readConfig(repo), hooks: await readHooks(gitDir) };
}

/** Compare to the snapshot, UNDO every difference, and return what was changed (empty = nothing happened). */
export async function revertGitMeta(snap: GitMeta): Promise<string[]> {
  const changed: string[] = [];
  const now = await readConfig(snap.repo);
  for (const [k, vals] of now) {
    const before = snap.config.get(k);
    if (!before || before.join('\0') !== vals.join('\0')) {
      changed.push(`git config ${k}`);
      await git(snap.repo, ['config', '--local', '--unset-all', k]);
      for (const v of before ?? []) await git(snap.repo, ['config', '--local', '--add', k, v]);
    }
  }
  for (const [k, before] of snap.config) {
    if (!now.has(k)) {
      changed.push(`git config ${k} (removed)`);
      for (const v of before) await git(snap.repo, ['config', '--local', '--add', k, v]);
    }
  }
  const hooksNow = await readHooks(snap.gitDir);
  for (const [f, buf] of hooksNow) {
    const before = snap.hooks.get(f);
    if (!before || !before.equals(buf)) {
      changed.push(`.git/hooks/${f}`);
      if (before) await writeFile(join(snap.gitDir, 'hooks', f), before, { mode: 0o755 });
      else await rm(join(snap.gitDir, 'hooks', f), { force: true });
    }
  }
  for (const [f, before] of snap.hooks) {
    if (!hooksNow.has(f)) {
      changed.push(`.git/hooks/${f} (removed)`);
      await writeFile(join(snap.gitDir, 'hooks', f), before, { mode: 0o755 });
    }
  }
  return changed;
}
