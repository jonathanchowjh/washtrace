import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewResult } from '@washtrace/detect';
import { DEFAULT_RULE, type LensRule } from '@washtrace/detect/lens-rule';
import { Preview } from '@/components/preview';

const ADDR = '0x' + 'b'.repeat(40);
const RESULT: PreviewResult = {
  sampled: 2000, judged: 2000, hops: 2000, ofSales: 9000, caught: 300, atLeast: false, roundTrips: { caught: 100 }, topMarket: { name: 'Blur', caught: 120 },
  truncated: 0, untimed: 0, tookMs: 4000,
};
const row = (over: object) => ({ id: 41, collectionId: 3, rule: DEFAULT_RULE, status: 'queued', progress: null, result: null, error: null, ...over });

/** POST answers `post`; each GET answers the next of `gets`, the last one for ever after. */
function routes(post: { status: number; body: object }, gets: { status: number; body: object }[]) {
  const queue = [...gets];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const r = init?.method === 'POST' ? post : (queue.length > 1 ? queue.shift()! : queue[0]!);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const done = (result: Partial<PreviewResult> = {}, rule: LensRule = DEFAULT_RULE) =>
  ({ status: 200, body: row({ status: 'done', rule, result: { ...RESULT, ...result } }) });
const props = { chainId: 1, address: ADDR, rule: DEFAULT_RULE, roundTripsName: 'Round trips', notFinal: [], funded: true };
const view = (over: Partial<Parameters<typeof Preview>[0]> = {}) => render(<Preview {...props} {...over} />);
/** Click Preview and let the POST and the first poll settle. */
async function run(c: ReturnType<typeof view>) {
  fireEvent.click(c.getByRole('button', { name: 'Preview' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Preview polling', () => {
  it('sends the rule, then shows waiting, then N%, then the result line, polling every second', async () => {
    const fetchMock = routes({ status: 202, body: { id: 41 } }, [
      { status: 200, body: row({ status: 'queued' }) },
      { status: 200, body: row({ status: 'running', progress: 0.42 }) },
      done(),
    ]);
    const c = view();
    await run(c);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, init.method, JSON.parse(init.body as string)]).toEqual(['/api/lenses/previews', 'POST', { chainId: 1, address: ADDR, rule: DEFAULT_RULE }]);
    expect(c.container.textContent).toContain('Waiting for the worker (an analysis or lens run may be going)');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/lenses/previews/41');
    await tick();
    expect(c.container.textContent).toContain('Previewing… 42%');
    expect(c.container.textContent).not.toContain('Waiting for the worker');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await tick();
    expect(c.container.textContent).toContain('Caught 15.0% of 2,000 sales sampled · Round trips caught 5.0% of the same sales · Most caught on Blur (120)');
    const calls = fetchMock.mock.calls.length;
    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it('says all N sales when the sample is the whole collection', async () => {
    routes({ status: 202, body: { id: 41 } }, [done({ sampled: 800, judged: 800, hops: 800, ofSales: 800, caught: 80, roundTrips: { caught: 40 } })]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Caught 10.0% of all 800 sales sampled · Round trips caught 5.0% of the same sales');
  });

  it('says at least when the result is a floor', async () => {
    routes({ status: 202, body: { id: 41 } }, [done({ atLeast: true, truncated: 2 })]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Caught at least 15.0% of 2,000 sales sampled');
  });

  it('says at least for a money lens whose funding is not final, though the result says atLeast: false', async () => {
    const money: LensRule = structuredClone(DEFAULT_RULE);
    money.edges.eth.use = true;
    routes({ status: 202, body: { id: 41 } }, [done({ atLeast: false, truncated: 0, untimed: 0 }, money)]);
    const c = view({ rule: money, funded: false });
    await run(c);
    expect(c.container.textContent).toContain('Caught at least 15.0% of');
  });

  it('does not say at least for a money lens when funding is final', async () => {
    const money: LensRule = structuredClone(DEFAULT_RULE);
    money.edges.eth.use = true;
    routes({ status: 202, body: { id: 41 } }, [done({}, money)]);
    const c = view({ rule: money, funded: true });
    await run(c);
    expect(c.container.textContent).toContain('Caught 15.0% of');
    expect(c.container.textContent).not.toContain('at least');
  });

  it('judges at least by the rule that was previewed, not the one in the form now', async () => {
    const money: LensRule = structuredClone(DEFAULT_RULE);
    money.edges.eth.use = true;
    routes({ status: 202, body: { id: 41 } }, [done({}, money)]);
    const c = view({ rule: DEFAULT_RULE, funded: false });
    await run(c);
    expect(c.container.textContent).toContain('Caught at least 15.0% of');
  });

  it('leaves the Round trips clause out when it did not run, and the market clause when none was caught', async () => {
    routes({ status: 202, body: { id: 41 } }, [done({ roundTrips: null, topMarket: null })]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Caught 15.0% of 2,000 sales sampled');
    expect(c.container.textContent).not.toContain('Round trips caught');
    expect(c.container.textContent).not.toContain('Most caught on');
  });

  it('names Round trips by the name it is given', async () => {
    routes({ status: 202, body: { id: 41 } }, [done()]);
    const c = view({ roundTripsName: 'Back and forth' });
    await run(c);
    expect(c.container.textContent).toContain('Back and forth caught 5.0% of the same sales');
  });
});

describe('Preview numbers and states', () => {
  it('the share is caught over judged, and Round trips states its own base', async () => {
    // 1,500 judged, 1,800 with a hop (300 untimed): Round trips judges those 1,800.
    routes({ status: 202, body: { id: 41 } }, [done({ sampled: 2000, judged: 1500, hops: 1800, caught: 300, roundTrips: { caught: 90 } })]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Caught 20.0% of 1,500 sales judged from 2,000 sampled · Round trips caught 5.0% of the 1,800 sales it judged · Most caught on Blur (120)');
  });

  it('says "the same sales" for Round trips when both judged the same ones', async () => {
    routes({ status: 202, body: { id: 41 } }, [done({ sampled: 2000, judged: 1500, hops: 1500, caught: 300, roundTrips: { caught: 75 } })]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Caught 20.0% of 1,500 sales judged from 2,000 sampled · Round trips caught 5.0% of the same sales');
  });

  it('does not read at least for untimed trades, which are already out of the base', async () => {
    routes({ status: 202, body: { id: 41 } }, [done({ untimed: 40 })]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Caught 15.0% of 2,000 sales sampled');
    expect(c.container.textContent).not.toContain('at least');
  });

  it('reads a progress that floors to 0% as still loading', async () => {
    routes({ status: 202, body: { id: 41 } }, [{ status: 200, body: row({ status: 'running', progress: 0.004 }) }]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Loading the collection…');
    expect(c.container.textContent).not.toContain('0%');
  });

  it('keeps the plain line when every sampled sale was judged', async () => {
    routes({ status: 202, body: { id: 41 } }, [done({ sampled: 800, judged: 800, hops: 800, ofSales: 800, caught: 80, roundTrips: { caught: 40 } })]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Caught 10.0% of all 800 sales sampled · Round trips caught 5.0% of the same sales');
  });

  it('keeps the floor in the judged line', async () => {
    routes({ status: 202, body: { id: 41 } }, [done({ judged: 1500, hops: 1500, truncated: 3 })]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Caught at least 20.0% of 1,500 sales judged from 2,000 sampled');
  });

  it('while progress is null or 0, it reads "Loading the collection…", not 0%', async () => {
    routes({ status: 202, body: { id: 41 } }, [
      { status: 200, body: row({ status: 'running', progress: null }) },
      { status: 200, body: row({ status: 'running', progress: 0 }) },
      { status: 200, body: row({ status: 'running', progress: 0.25 }) },
    ]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Loading the collection…');
    expect(c.container.textContent).not.toContain('Previewing');
    await tick();
    expect(c.container.textContent).toContain('Loading the collection…');
    expect(c.container.textContent).not.toContain('0%');
    await tick();
    expect(c.container.textContent).toContain('Previewing… 25%');
    expect(c.container.textContent).not.toContain('Loading the collection');
  });

  it('a 200 that is not a preview row is a failed poll, and polling retries', async () => {
    const fetchMock = routes({ status: 202, body: { id: 41 } }, [{ status: 200, body: { ok: true } }, done()]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('Lost touch with the service; trying again every second.');
    expect(c.container.textContent).not.toContain('Caught');
    await tick();
    expect(c.container.textContent).toContain('Caught 15.0% of 2,000 sales sampled');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('Preview failures', () => {
  it('shows the error of a failed preview and stops polling', async () => {
    const fetchMock = routes({ status: 202, body: { id: 41 } }, [{ status: 200, body: row({ status: 'failed', error: 'The worker stopped during this preview.' }) }]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('The worker stopped during this preview.');
    await tick(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says the preview is gone on a 404 and stops polling', async () => {
    const fetchMock = routes({ status: 202, body: { id: 41 } }, [
      { status: 200, body: row({ status: 'running', progress: 0.1 }) },
      { status: 404, body: { error: 'This preview is gone. Run it again.' } },
    ]);
    const c = view();
    await run(c);
    await tick();
    expect(c.container.textContent).toContain('This preview is gone. Run it again.');
    expect(c.container.textContent).not.toContain('Previewing');
    await tick(3000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /** POST answers id 41; each GET answers the next of `gets`, the last for ever after: a Response, a body of raw text, or 'down' for a fetch that fails. */
  function polls(gets: ({ status: number; body: object } | { status: number; text: string } | 'down')[]) {
    const queue = [...gets];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 41 }), { status: 202 });
      const r = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (r === 'down') throw new TypeError('fetch failed');
      return new Response('text' in r ? r.text : JSON.stringify(r.body), { status: r.status });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const LOST = 'Lost touch with the service; trying again every second.';

  it('keeps polling through a 500, showing what it last knew, then shows the result', async () => {
    const fetchMock = polls([{ status: 200, body: row({ status: 'running', progress: 0.3 }) }, { status: 500, body: { error: 'Internal error.' } }, done()]);
    const c = view();
    await run(c);
    await tick();
    expect(c.container.textContent).toContain('Previewing… 30%');
    expect(c.container.textContent).toContain(LOST);
    expect(c.container.textContent).not.toContain('Internal error.');
    // Still running as far as it knows, so a second preview is not offered.
    expect(c.getByRole('button', { name: 'Preview' })).toHaveProperty('disabled', true);
    await tick();
    expect(c.container.textContent).toContain('Caught 15.0% of 2,000 sales sampled');
    expect(c.container.textContent).not.toContain(LOST);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps polling through a network failure on the first poll, then running, then done', async () => {
    polls(['down', { status: 200, body: row({ status: 'running', progress: 0.5 }) }, done()]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain(LOST);
    expect(c.container.textContent).not.toContain('did not answer');
    await tick();
    expect(c.container.textContent).toContain('Previewing… 50%');
    expect(c.container.textContent).not.toContain(LOST);
    await tick();
    expect(c.container.textContent).toContain('Caught 15.0% of 2,000 sales sampled');
  });

  it('reads a 200 it cannot parse as a failed poll, and tries again', async () => {
    polls([{ status: 200, text: '<html>proxy</html>' }, done()]);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain(LOST);
    await tick();
    expect(c.container.textContent).toContain('Caught 15.0% of 2,000 sales sampled');
  });

  it('shows the refusal of the POST, and polls nothing', async () => {
    const fetchMock = routes({ status: 409, body: { error: 'This collection has no sales to preview on.' } }, []);
    const c = view();
    await run(c);
    expect(c.container.textContent).toContain('This collection has no sales to preview on.');
    await tick(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send a rule the checker refuses, and says why', async () => {
    const bad: any = structuredClone(DEFAULT_RULE);
    bad.hops = { min: 3, max: 1 };
    const fetchMock = routes({ status: 202, body: { id: 41 } }, []);
    const c = view({ rule: bad });
    await run(c);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(c.getByRole('alert').textContent).toBeTruthy();
  });
});

describe('Preview after an edit', () => {
  it('marks a result Previewed before your last change once the rule differs, and not before', async () => {
    routes({ status: 202, body: { id: 41 } }, [done()]);
    const c = view();
    await run(c);
    expect(c.container.textContent).not.toContain('Previewed before your last change');
    const changed: LensRule = structuredClone(DEFAULT_RULE);
    changed.hops = { min: 1, max: 2 };
    c.rerender(<Preview {...props} rule={changed} />);
    expect(c.container.textContent).toContain('Previewed before your last change');
    expect(c.container.textContent).toContain('Caught 15.0% of');
    c.rerender(<Preview {...props} rule={DEFAULT_RULE} />);
    expect(c.container.textContent).not.toContain('Previewed before your last change');
  });
});

describe('Preview copy', () => {
  it('names lenses, never their codes, and says what the button is for', async () => {
    routes({ status: 202, body: { id: 41 } }, [done()]);
    const c = view();
    expect(c.getByRole('button', { name: 'Preview' }).getAttribute('title')).toBeTruthy();
    await run(c);
    expect(c.container.innerHTML).not.toMatch(/\b(AU|AC)\b|\bL\d+\b|"A"/);
  });
});
