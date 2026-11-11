import { retryMs } from './store.js';

/** The back-off the worker keeps in memory for one kind of work, by collection: failures in a row and when the next try is due. */
export class Backoff {
  private readonly failed = new Map<number, { failures: number; retryAt: number }>();

  /** Counts a failure at `now`; the next try waits retryMs of the count. */
  fail(id: number, now: number): void {
    const failures = (this.failed.get(id)?.failures ?? 0) + 1;
    this.failed.set(id, { failures, retryAt: now + retryMs(failures) });
  }

  /** Whether the wait after the last failure is still running at `now`. */
  waits(id: number, now: number): boolean {
    return (this.failed.get(id)?.retryAt ?? 0) > now;
  }

  clear(id: number): void {
    this.failed.delete(id);
  }
}
