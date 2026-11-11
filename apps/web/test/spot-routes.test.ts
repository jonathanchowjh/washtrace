import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COPIES, DEFAULT_RULE } from '@washtrace/detect/lens-rule';

const TX = `0x${'7'.repeat(64)}`;
const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`, C = `0x${'c'.repeat(40)}`;
const lens = { id: 7, key: 'L7', name: 'Pay back', rule: COPIES.AC.rule, version: 3, createdAt: 0, updatedAt: 0 };
const sale = { txHash: TX, logIndex: 0, blockNumber: 9, blockTime: null, tokenId: '1', from: A, to: B, marketplace: null, priceWei: null, currency: null };
/** A stored verdict: one transfer, judged and flagged by Round trips. */
const judgedView = {
  transfers: [{ ...sale, flags: { A: { kind: 'scc', wallets: [A, B], cycles: 2 } }, collection: { chainId: 1, address: C, name: 'Lab' } }],
  watched: {}, judged: true, washTrade: true, by: ['A'], apartOnly: false, notRun: [],
};

const fake = {
  lens: vi.fn(async (): Promise<typeof lens | null> => lens),
  requestSpot: vi.fn(async () => ({ id: 41, reused: false })),
  spot: vi.fn(async (): Promise<object | null> => ({ id: 41, status: 'queued' })),
};
const verdictOf = vi.fn(async (): Promise<object> => ({ ...judgedView, transfers: [], judged: false, washTrade: null, by: [] }));
vi.mock('@/lib/store', () => ({ store: () => fake }));
vi.mock('@/lib/views', () => ({ txVerdict: verdictOf }));

const { POST: ask } = await import('@/app/api/spots/route');
const { GET: poll } = await import('@/app/api/spots/[id]/route');
const { fromVerdict } = await import('@/lib/spot');
const { LOCAL_ONLY } = await import('@/lib/auth');

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api/spots', { method: 'POST', body: JSON.stringify(body), headers: { host: 'localhost:8080', 'content-type': 'application/json', ...headers } });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/spots', () => {
  it('a transaction a watched analysis covers is answered at once', async () => {
    verdictOf.mockResolvedValueOnce(judgedView);
    const res = await ask(req({ chainId: 1, tx: TX }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'done', result: { source: 'watched', washTrade: true, methods: ['A'] } });
    expect(fake.requestSpot).not.toHaveBeenCalled();
  });

  it('a transaction no analysis covers is queued', async () => {
    const res = await ask(req({ chainId: 1, tx: TX }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 41, status: 'queued', reused: false });
    expect(fake.requestSpot).toHaveBeenCalledWith(1, TX, null);
  });

  it('with a lens, a covered transaction is still queued, at the lens\'s version', async () => {
    verdictOf.mockResolvedValueOnce(judgedView);
    const res = await ask(req({ chainId: 1, tx: TX, lens: 'L7' }));
    expect(res.status).toBe(202);
    expect(fake.lens).toHaveBeenCalledWith(7);
    expect(fake.requestSpot).toHaveBeenCalledWith(1, TX, { key: 'L7', version: 3 });
  });

  it('a lens key that is not one of yours is 404', async () => {
    fake.lens.mockResolvedValueOnce(null);
    const res = await ask(req({ chainId: 1, tx: TX, lens: 'L99' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such lens.' });
  });

  it('a lens using Other tokens is 400 with the sentence', async () => {
    const on = { use: true, direction: 'along', max: null, minWei: null, repeats: 'each' } as const;
    fake.lens.mockResolvedValueOnce({ ...lens, rule: { ...DEFAULT_RULE, edges: { ...DEFAULT_RULE.edges, 'other-tokens': on } } });
    const res = await ask(req({ chainId: 1, tx: TX, lens: 'L7' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This lens uses Other tokens, which a spot check does not read.' });
  });

  it('refuses a bad tx hash, a chainId given as a string, and a lens that is not a key', async () => {
    for (const body of [{ chainId: 1, tx: '0x123' }, { chainId: '1', tx: TX }, { chainId: 1, tx: TX, lens: 'AC' }]) {
      expect((await ask(req(body))).status).toBe(400);
    }
    expect(fake.requestSpot).not.toHaveBeenCalled();
  });

  it('a request from another machine without auth is 403', async () => {
    const res = await ask(req({ chainId: 1, tx: TX }, { host: 'evil.example' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: LOCAL_ONLY });
  });
});

describe('GET /api/spots/[id]', () => {
  it('returns the check, and 404 for an unknown id', async () => {
    const res = await poll(new Request('http://x'), idCtx('41'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 41, status: 'queued' });
    fake.spot.mockResolvedValueOnce(null);
    const gone = await poll(new Request('http://x'), idCtx('42'));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'No such spot check.' });
    expect((await poll(new Request('http://x'), idCtx('x'))).status).toBe(404);
  });
});

describe('fromVerdict', () => {
  it('gives the stored answer the spot result\'s shape', () => {
    expect(fromVerdict(judgedView as never)).toEqual({
      washTrade: true, methods: ['A'], notRun: [], atLeast: false, finalized: true, source: 'watched',
      transfers: [{ ...sale, collection: C, flags: { A: { kind: 'scc', wallets: [A, B], cycles: 2 } } }],
    });
  });

  it('a stored clean answer without Linked wallets is not judged, as a spot check would say', () => {
    const clean = { ...judgedView, transfers: [{ ...judgedView.transfers[0]!, flags: {} }], washTrade: false, by: [] };
    expect(fromVerdict({ ...clean, notRun: ['AU', 'AC'] } as never).washTrade).toBeNull();
    // Money loops back is not counted, so without it a clean answer stands.
    expect(fromVerdict({ ...clean, notRun: ['AU'] } as never).washTrade).toBe(false);
  });
});
