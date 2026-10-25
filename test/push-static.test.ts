// The builder never pushes. Ship (src/git/ship.ts) is the ONLY code that runs `git push` (the manual click runs Ship too).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
const ALLOWED = new Set(['git/ship.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

/** Drop block and line comments (only when preceded by start/space, so `https://` survives) so prose about pushing does not trip the scan. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

// An argv element 'push', a spawn of `git push ...`, or a shell line with it.
const PUSH_ARGV = /(?:\[|,)\s*['"`]push['"`]\s*(?:,|\])/;
const PUSH_SHELL = /['"`]\s*git\s+(?:\S+\s+){0,6}?push\s+\S/;

describe('push is confined to ship.ts', () => {
  it('finds git push nowhere else under src/', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(readFileSync(f, 'utf8'));
      if (PUSH_ARGV.test(code) || PUSH_SHELL.test(code)) offenders.push(rel);
    }
    assert.deepEqual(offenders, []);
  });

  it('the scan itself catches the shapes it is meant to (self-check)', () => {
    for (const bad of ["git(root, ['push', 'origin'])", "run('git', ['-c', 'k=v', 'push'])", 'const a = [\'x\', "push", y]', "sh('git push origin main')", "sh('git -c a=b push origin')"]) {
      const code = stripComments(bad);
      assert.ok(PUSH_ARGV.test(code) || PUSH_SHELL.test(code), bad);
    }
    for (const ok of ["// git push is forbidden", "/* ['push'] */", "case 'push':", "const label = 'git push';"]) {
      const code = stripComments(ok);
      assert.ok(!(PUSH_ARGV.test(code) || PUSH_SHELL.test(code)), ok);
    }
  });

  it('ship.ts is the push site and has no force, +refspec or --no-verify; push-ticket.ts has no push, commit, amend or rebase', () => {
    const ship = readFileSync(join(SRC, 'git/ship.ts'), 'utf8');
    const ticket = stripComments(readFileSync(join(SRC, 'git/push-ticket.ts'), 'utf8'));
    assert.match(stripComments(ship), /'push'/);
    const code = stripComments(ship);
    assert.doesNotMatch(code, /--force(?![-a-z])|'-f'|--no-verify|--mirror|--delete|\+refs|`\+/);
    assert.doesNotMatch(ticket, /'push'|'commit'|'rebase'|'amend'|--amend|commitOnly|pushTicket|reauthorTip/);
    const engine = stripComments(readFileSync(join(SRC, 'pipeline/engine.ts'), 'utf8'));
    assert.doesNotMatch(engine, /pushTicket|push-ticket\.ts/);
  });
});
