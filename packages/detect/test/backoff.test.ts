import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/backoff.js';
import { retryMs } from '../src/store.js';

describe('Backoff', () => {
  it('does not wait for an unknown id', () => {
    expect(new Backoff().waits(1, 0)).toBe(false);
  });

  it('waits after a failure until retryMs(1) has passed', () => {
    const b = new Backoff();
    b.fail(1, 1000);
    expect(b.waits(1, 1000)).toBe(true);
    expect(b.waits(1, 1000 + retryMs(1) - 1)).toBe(true);
    expect(b.waits(1, 1000 + retryMs(1))).toBe(false);
  });

  it('counts failures in a row: the second uses retryMs(2)', () => {
    const b = new Backoff();
    b.fail(1, 0);
    b.fail(1, 0);
    expect(b.waits(1, retryMs(2) - 1)).toBe(true);
    expect(b.waits(1, retryMs(2))).toBe(false);
  });

  it('pins the wait for 1, 2, 3 and 10 failures to retryMs', () => {
    for (const n of [1, 2, 3, 10]) {
      const b = new Backoff();
      for (let i = 0; i < n; i += 1) b.fail(7, 500);
      expect(b.waits(7, 500 + retryMs(n) - 1)).toBe(true);
      expect(b.waits(7, 500 + retryMs(n))).toBe(false);
    }
  });

  it('keeps ids apart, and clear forgets one', () => {
    const b = new Backoff();
    b.fail(1, 0);
    b.fail(2, 0);
    b.clear(1);
    expect(b.waits(1, 0)).toBe(false);
    expect(b.waits(2, 0)).toBe(true);
    b.fail(1, 0);
    expect(b.waits(1, retryMs(1))).toBe(false);
  });

  it('lists the ids still waiting at now, in insertion order', () => {
    const b = new Backoff();
    expect(b.waiting(0)).toEqual([]);
    b.fail(3, 0);
    b.fail(1, 0);
    b.fail(2, 10_000_000);
    expect(b.waiting(retryMs(1) - 1)).toEqual([3, 1, 2]);
    expect(b.waiting(retryMs(1))).toEqual([2]);
    b.clear(2);
    expect(b.waiting(retryMs(1))).toEqual([]);
  });
});
