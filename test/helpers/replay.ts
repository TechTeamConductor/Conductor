import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Executable that prints a recorded ndjson fixture to stdout (ignoring args/stdin) and exits with `code`. */
export function replayBin(fixturePath: string, code = 0, extra = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'cond-replay-'));
  const bin = join(dir, 'replay.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('replay'); process.exit(0); }
for await (const _ of process.stdin) {}
${extra}
process.stdout.write(readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
process.exit(${code});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
