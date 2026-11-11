import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poll } from '@/lib/send';

type Row = { status: string };

/** Each fetch answers the next of `answers` (the last for ever after); `null` is no answer at all, a string a body that is no JSON. */
function answers(...list: ({ status: number; body: object } | string | null)[]) {
  const queue = [...list];
  const fetchMock = vi.fn(async (_url: string) => {
    const a = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (a === null) throw new TypeError('network');
    return new Response(typeof a === 'string' ? a : JSON.stringify(a.body), { status: typeof a === 'string' ? 200 : a.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const hooks = () => ({
  every: 1000,
  done: (r: Row) => r.status === 'done',
  onRow: vi.fn<(r: Row) => void>(),
  onLost: vi.fn(),
  onGone: vi.fn(),
});
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('poll', () => {
  it('asks at once, then every interval while the row is not done, handing each row over before the next ask', async () => {
    const fetchMock = answers({ status: 200, body: { status: 'queued' } }, { status: 200, body: { status: 'running' } }, { status: 200, body: { status: 'done' } });
    const h = hooks();
    poll('/x/1', h);
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/x/1');
    expect(h.onRow).toHaveBeenLastCalledWith({ status: 'queued' });
    await tick(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(1000);
    expect(h.onRow.mock.calls.map(([r]) => r.status)).toEqual(['queued', 'running', 'done']);
    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(h.onLost).not.toHaveBeenCalled();
    expect(h.onGone).not.toHaveBeenCalled();
  });

  it('calls onLost and asks again after no answer, a non-ok answer, a body that is no JSON, and a body with no status', async () => {
    const fetchMock = answers(null, { status: 500, body: { status: 'done' } }, 'not json', { status: 200, body: { id: 3 } }, { status: 200, body: { status: 'done' } });
    const h = hooks();
    poll('/x/1', h);
    await tick(0);
    await tick(1000);
    await tick(1000);
    await tick(1000);
    expect(h.onLost).toHaveBeenCalledTimes(4);
    expect(h.onRow).not.toHaveBeenCalled();
    await tick(1000);
    expect(h.onRow).toHaveBeenCalledWith({ status: 'done' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('calls onGone with the body on a 404 and stops', async () => {
    const fetchMock = answers({ status: 200, body: { status: 'running' } }, { status: 404, body: { error: 'gone' } });
    const h = hooks();
    poll('/x/1', h);
    await tick(0);
    await tick(1000);
    expect(h.onGone).toHaveBeenCalledWith({ error: 'gone' });
    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.onLost).not.toHaveBeenCalled();
  });

  it('calls onGone with null when a 404 has no JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 404 })));
    const h = hooks();
    poll('/x/1', h);
    await tick(0);
    expect(h.onGone).toHaveBeenCalledWith(null);
  });

  it('stops on a row that is done', async () => {
    const fetchMock = answers({ status: 200, body: { status: 'done' } });
    poll('/x/1', hooks());
    await tick(0);
    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the stop function clears the timer, and drops an answer still on its way', async () => {
    const fetchMock = answers({ status: 200, body: { status: 'running' } });
    const h = hooks();
    const stop = poll('/x/1', h);
    await tick(0);
    stop();
    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const h2 = hooks();
    const stop2 = poll('/x/2', h2);
    stop2();
    await tick(0);
    expect(h2.onRow).not.toHaveBeenCalled();
    expect(h2.onLost).not.toHaveBeenCalled();
  });
});
