// A counting semaphore with a limit that is read on every acquisition (so a config change applies to the next waiter), FIFO hand-off, an
// abortable wait and an idempotent release. Used for the engine's ONE cap on concurrent read-only analysis calls (task graphs, M3).

interface Waiter {
  wake: () => void;
}

export class Semaphore {
  private active = 0;
  private waiters: Waiter[] = [];
  private limit: () => number;
  constructor(limit: () => number) {
    this.limit = limit;
  }

  get inUse(): number {
    return this.active;
  }

  /** Resolves with a `release` function once a slot is free, or with null when `signal` aborts first (no slot is taken then). */
  async acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    while (this.active >= Math.max(1, Math.floor(this.limit()))) {
      if (signal?.aborted) return null;
      const woke = await new Promise<boolean>((resolve) => {
        const w: Waiter = { wake: () => resolve(true) };
        this.waiters.push(w);
        signal?.addEventListener(
          'abort',
          () => {
            const i = this.waiters.indexOf(w);
            if (i >= 0) this.waiters.splice(i, 1);
            resolve(false);
          },
          { once: true },
        );
      });
      if (!woke) return null;
    }
    if (signal?.aborted) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.wake();
    };
  }
}
