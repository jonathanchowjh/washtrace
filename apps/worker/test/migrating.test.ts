import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@washtrace/detect';
import { Migrating } from '../src/migrating.js';

const URL = 'postgres://washtrace:hunter2@db-primary.internal:5432/washtrace';

/** A store whose every migrate attempt waits for the test to settle it, in order. */
function stubStore() {
  const attempts: { resolve: (v: number) => void; reject: (e: unknown) => void }[] = [];
  const store = { migrate: () => new Promise<number>((resolve, reject) => { attempts.push({ resolve, reject }); }) } as unknown as Store;
  return { store, attempts };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Migrating: the start-up migration and what /health answers meanwhile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('answers 200 migrating while nothing has failed, 503 with the scrubbed error after a failed attempt, and 200 again once one takes', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, attempts } = stubStore();
    const m = new Migrating(store, URL);
    m.pause = async () => {};
    const done = m.run();
    await settle();
    // The first attempt, in progress: a slow migration (#28 builds an index over every flow) is not a dead worker.
    expect(attempts).toHaveLength(1);
    expect(m.health()).toEqual({ status: 200, body: { ok: true, migrating: true } });

    attempts[0]!.reject(new Error(`connect ECONNREFUSED for ${URL} at db-primary.internal`));
    await settle();
    // The second attempt is in progress, after one that failed: unhealthy, saying why, and never the store's URL or its password.
    expect(attempts).toHaveLength(2);
    const failing = m.health();
    expect(failing).toMatchObject({ status: 503, body: { ok: false, migrating: true, error: expect.stringContaining('connect ECONNREFUSED') } });
    expect(JSON.stringify(failing)).not.toMatch(/hunter2|postgres:\/\/|db-primary/);
    expect(String(logged.mock.calls[0])).not.toMatch(/hunter2|db-primary/);

    // It keeps failing, and says so on each.
    attempts[1]!.reject(new Error('the database system is starting up'));
    await settle();
    expect(m.health()).toEqual({ status: 503, body: { ok: false, migrating: true, error: 'the database system is starting up' } });

    attempts[2]!.resolve(32);
    await done;
    expect(m.health()).toEqual({ status: 200, body: { ok: true, migrating: true } });

    // A later attempt after one that succeeded: nothing has failed since, so it reads as the first did.
    const again = m.run();
    await settle();
    expect(m.health()).toEqual({ status: 200, body: { ok: true, migrating: true } });
    attempts[3]!.resolve(32);
    await again;
  });

  it('waits longer between attempts, up to 30 s', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fails = 4;
    const store = { migrate: async () => { if (fails-- > 0) throw new Error('not yet'); return 32; } } as unknown as Store;
    const m = new Migrating(store, URL);
    const waits: number[] = [];
    m.pause = async (ms) => { waits.push(ms); };
    await m.run();
    expect(waits).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(m.health().status).toBe(200);
  });
});
