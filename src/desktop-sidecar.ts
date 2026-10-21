// The desktop app's server process (M7b, macOS): the same runtime as `conductor start`, started by the Electron main process as a
// utilityProcess. It binds 127.0.0.1 on port 0 and hands {port, otp} to the parent over the process's own message channel — never a fixed
// port (a squatter could receive the one-time code), never a control socket, never a file. The parent loads the dashboard with that code.
import { ensureHome, paths } from './paths.ts';
import { acquireLock, LockHeldError } from './lock.ts';
import { loadConfig } from './config.ts';
import { createRuntime } from './runtime.ts';
import { pruneLogs } from './log.ts';

const parent = (process as unknown as { parentPort?: { postMessage(m: unknown): void; on(ev: 'message', cb: (e: { data?: { type?: string } }) => void): void } }).parentPort;
if (!parent) {
  console.error('desktop-sidecar must be started by the desktop app (utilityProcess).');
  process.exit(2);
}

async function main(): Promise<void> {
  ensureHome();
  pruneLogs();
  let lock;
  try {
    lock = acquireLock(paths.lock());
  } catch (e) {
    if (e instanceof LockHeldError) {
      parent!.postMessage({ type: 'error', code: 'already-running', message: 'Conductor is already running (another window or `conductor start`). Close it first.' });
      process.exit(0);
    }
    throw e;
  }
  loadConfig();
  const rt = await createRuntime();
  const port = await rt.server.listen(0);
  lock.update({ port });
  rt.engine.start();
  rt.warmUp(); // R2-N1: one background zero-quota health read, so model discovery starts without a window asking for health
  const shutdown = async (): Promise<void> => {
    try {
      await rt.close();
    } finally {
      lock.release();
      process.exit(0);
    }
  };
  parent!.on('message', (e) => {
    if (e.data?.type === 'quit') void shutdown();
    if (e.data?.type === 'otp') parent!.postMessage({ type: 'otp', otp: rt.auth.mintOtp() });
  });
  process.on('SIGTERM', () => void shutdown());
  parent!.postMessage({ type: 'ready', port, otp: rt.auth.mintOtp() });
}
main().catch((e) => {
  parent!.postMessage({ type: 'error', code: 'start-failed', message: String((e as Error)?.message ?? e).slice(0, 400) });
  process.exit(1);
});
