import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpotResult } from '@washtrace/detect';
import { SpotCheck } from '@/components/spot-check';
import { SPOT_AT_LEAST } from '@/lib/format';

const TX = `0x${'7'.repeat(64)}`;
const S = `0x${'5'.repeat(40)}`, B = `0x${'b'.repeat(40)}`, M = `0x${'d'.repeat(40)}`, C = `0x${'c'.repeat(40)}`;
const sale = { txHash: TX, logIndex: 0, blockNumber: 9, blockTime: null, tokenId: '114', from: S, to: B, marketplace: 'seaport-1.6', priceWei: '9', currency: '', collection: C };
const linked: SpotResult = {
  washTrade: true, methods: ['AC'], notRun: ['AU'], atLeast: false, finalized: true, source: 'spot',
  transfers: [{ ...sale, flags: { AC: { kind: 'pair', pair: [S, B], middle: M, flowTx: TX } } }],
};

/** POST answers `post`; each GET the next of `gets`, the last for ever after. */
function routes(post: { status: number; body: object }, gets: { status: number; body: object }[] = []) {
  const queue = [...gets];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const r = init?.method === 'POST' ? post : (queue.length > 1 ? queue.shift()! : queue[0]!);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const lenses = [{ key: 'L7', name: 'Pay back', refusal: null }, { key: 'L8', name: 'Token loops', refusal: 'This lens uses Other tokens, which a spot check does not read.' }];
const view = () => render(<SpotCheck chainId={1} tx={TX} lenses={lenses} writable />);
const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function check(c: ReturnType<typeof view>) {
  fireEvent.click(c.getByRole('button', { name: 'Check this transaction' }));
  await tick(0);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SpotCheck', () => {
  it('checks with the built-in methods by default, polls, and shows the flag with its wallets', async () => {
    const fetchMock = routes({ status: 202, body: { id: 41, status: 'queued', reused: false } }, [
      { status: 200, body: { id: 41, status: 'running', result: null, error: null } },
      { status: 200, body: { id: 41, status: 'done', result: linked, error: null } },
    ]);
    const c = view();
    await check(c);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, JSON.parse(init.body as string)]).toEqual(['/api/spots', { chainId: 1, tx: TX }]);
    expect(c.container.textContent).toContain('Checking: reading the transaction, its tokens and its wallets’ money…');
    await tick();
    const t = c.container.textContent!;
    expect(t).toContain('Flagged as a wash trade by Linked wallets.');
    expect(t).toContain('#114');
    expect(c.container.querySelector(`a[href="/w/1/${M}"]`)).not.toBeNull();
    expect(t).toContain('This was a spot check of one transaction.');
  });

  it('a stored answer shows at once, with no poll', async () => {
    const fetchMock = routes({ status: 200, body: { status: 'done', result: { ...linked, source: 'watched' } } });
    const c = view();
    await check(c);
    await tick(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.container.textContent).toContain('From the latest analysis of its collection.');
  });

  it('sends the lens chosen, and a lens that cannot be spot checked is disabled with why', async () => {
    const fetchMock = routes({ status: 202, body: { id: 42, status: 'queued', reused: false } }, [{ status: 200, body: { id: 42, status: 'queued' } }]);
    const c = view();
    const blocked = [...c.container.querySelectorAll('option')].find((o) => o.value === 'L8')!;
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toContain('This lens uses Other tokens, which a spot check does not read.');
    fireEvent.change(c.getByLabelText('Judge with'), { target: { value: 'L7' } });
    await check(c);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ chainId: 1, tx: TX, lens: 'L7' });
  });

  it('an at-least answer never reads as clean', async () => {
    routes({ status: 202, body: { id: 43, status: 'queued' } }, [
      { status: 200, body: { id: 43, status: 'done', result: { ...linked, washTrade: null, methods: [], atLeast: true, transfers: [{ ...sale, flags: {} }] } } },
    ]);
    const c = view();
    await check(c);
    const t = c.container.textContent!;
    expect(t).toContain(SPOT_AT_LEAST);
    expect(t).not.toMatch(/not flagged|clean result\.$|is clean/i);
  });

  it('a failed check shows the reason and can be tried again', async () => {
    const fetchMock = routes({ status: 202, body: { id: 44, status: 'queued' } }, [
      { status: 200, body: { id: 44, status: 'failed', result: null, error: 'No such transaction on chain 1.' } },
    ]);
    const c = view();
    await check(c);
    expect(c.getByRole('alert').textContent).toBe('No such transaction on chain 1.');
    fireEvent.click(c.getByRole('button', { name: 'Try again' }));
    await tick(0);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(2);
  });

  it('keeps polling through a failed poll, and stops on unmount', async () => {
    const fetchMock = routes({ status: 202, body: { id: 45, status: 'queued' } }, [
      { status: 502, body: {} },
      { status: 200, body: { id: 45, status: 'running' } },
    ]);
    const c = view();
    await check(c);
    expect(c.container.textContent).toContain('Lost touch with the service; trying again every second.');
    await tick();
    expect(c.container.textContent).not.toContain('Lost touch');
    c.unmount();
    const calls = fetchMock.mock.calls.length;
    await tick(5_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('is disabled where this console may not write', () => {
    const c = render(<SpotCheck chainId={1} tx={TX} lenses={[]} writable={false} />);
    expect((c.getByRole('button', { name: 'Check this transaction' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
