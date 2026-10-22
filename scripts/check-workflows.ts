// Static gate for the GitHub Actions workflows (no YAML parser needed, zero dependencies):
//   node scripts/check-workflows.ts
// Fails when a workflow could be injectable or over-privileged:
//   - a `run:` step interpolates an expression (`${{ … }}`): commit messages, branch names and inputs must reach shell code through `env:`
//   - `pull_request_target` is used
//   - there is no top-level `permissions:` block
//   - an action is not pinned to a full commit SHA (local `./` reuse is fine)
//   - `contents: write` is granted more than once in a file (only the publishing job may write)
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** All problems in one workflow file's text. */
export function findViolations(name: string, text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  if (!lines.some((l) => /^permissions:/.test(l))) out.push(`${name}: no top-level "permissions:" block`);
  let writes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const code = line.replace(/\s+#.*$/, '');
    if (/^\s*pull_request_target\b/.test(code) || /\bpull_request_target\s*:/.test(code)) out.push(`${name}:${i + 1}: pull_request_target is not allowed`);
    if (/^\s*contents:\s*write\b/.test(code)) writes++;
    const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(code);
    if (uses && !(uses[1] as string).startsWith('./') && !/@[0-9a-f]{40}$/.test(uses[1] as string)) out.push(`${name}:${i + 1}: action "${uses[1]}" is not pinned to a full commit SHA`);
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run) {
      const indent = (run[1] as string).length;
      const inline = (run[2] as string).trim();
      if (inline && !/^[|>][+-]?$/.test(inline)) {
        if (inline.includes('${{')) out.push(`${name}:${i + 1}: expression interpolated into run:`);
      } else {
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j] as string;
          if (l.trim() && l.length - l.trimStart().length <= indent) break;
          if (l.includes('${{')) out.push(`${name}:${j + 1}: expression interpolated into run:`);
        }
      }
    }
  }
  if (writes > 1) out.push(`${name}: "contents: write" is granted ${writes} times (only the publishing job may write)`);
  return out;
}

export function checkDir(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) out.push(...findViolations(f, readFileSync(join(dir, f), 'utf8')));
  return out;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const problems = checkDir(join(import.meta.dirname, '..', '.github', 'workflows'));
  for (const p of problems) process.stderr.write(`${p}\n`);
  if (problems.length) process.exit(1);
  process.stdout.write('workflows ok\n');
}
