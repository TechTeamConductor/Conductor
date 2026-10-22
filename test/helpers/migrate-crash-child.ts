// SIGKILLs itself at the requested migrate point (crash-window test).
import { migrate } from '../../src/migrate.ts';

const point = process.env.CRASH_AT!;
await migrate({
  from: process.env.FROM!,
  to: process.env.TO!,
  apply: true,
  backupRoot: process.env.BACKUPS,
  hooks: { at: (p) => { if (p === point) process.kill(process.pid, 'SIGKILL'); } },
});
