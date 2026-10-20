// Loaded into every test process (node --test --import): the suite must never create or touch the user's real data/backup folders
// (review N8). Tests that need a specific home still set CONDUCTOR_HOME / CONDUCTOR_BACKUP_DIR themselves.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'cond-suite-'));
// ALWAYS overridden: a CONDUCTOR_HOME exported in the developer's shell must never leak into the suite (review N8)
process.env.CONDUCTOR_HOME = join(base, 'home');
process.env.CONDUCTOR_BACKUP_DIR = join(base, 'backups');
