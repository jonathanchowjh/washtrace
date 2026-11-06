import { afterEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'b'.repeat(40);
const SELLER = '0x' + '1'.repeat(40);
const BUYER = '0x' + '2'.repeat(40);
const ctx = { params: Promise.resolve({ chain: '1', address: ADDR }) };
const HEADER = 'date,token,seller,buyer,price,currency,marketplace,held_seconds,buyer_age_seconds,price_vs_floor,Round trips,Money loops back (not counted),Linked wallets,tx';

const row = (i: number, over: Record<string, unknown> = {}) => ({
  txHash: `0xtx${i}`, logIndex: 0, blockNumber: 5, blockTime: 1_680_000_000, tokenId: String(i), from: SELLER, to: BUYER,
  marketplace: 'seaport-1.5', priceWei: '1500000000000000000', currency: '', flags: {}, lenses: ['A'], judged: true, heldS: 7200, buyerAgeS: null, floorRatio: 1.25, ...over,
});

const fresh = () => ({
  watched: true, moneyRan: true, total: 120, unjudged: 3, rows: [row(1)] as unknown[], calls: [] as unknown[][], streamArgs: [] as unknown[][],
  stream: async function* () { yield row(1); } as () => AsyncGenerator<unknown>,
});
const state = fresh();

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => state.watched ? { id: 1, chainId: 1, address: ADDR, latest: { throughBlock: 10, totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, { available: m === 'A' || state.moneyRan }])) } } : null,
    tradeCount: async () => ({ total: state.total, unjudged: state.unjudged }),
    trades: async (...a: unknown[]) => { state.calls.push(a); return state.rows; },
    tradeStream: (...a: unknown[]) => { state.streamArgs.push(a); return state.stream(); },
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

afterEach(() => { Object.assign(state, fresh()); });

const get = async (qs = '') => (await import('@/app/api/collections/[chain]/[address]/trades/route')).GET(new Request(`http://x/api/collections/1/${ADDR}/trades?${qs}`), ctx);

describe('GET trades', () => {
  it('pages as JSON with the same filters as the page', async () => {
    const body = await (await get('caught=A&page=2')).json();
    expect(body).toMatchObject({ total: 120, unjudged: 3, page: 2, pages: 3, ran: ['A', 'AU', 'AC'] });
    expect(body.rows).toHaveLength(1);
    expect(state.calls[0]!.slice(3)).toEqual([50, 50]);
  });

  it('clamps a page past the last, and holds nothing for a lens that did not run', async () => {
    expect((await (await get('page=99999')).json()).page).toBe(3);
    state.moneyRan = false;
    expect(await (await get('caught=AU')).json()).toMatchObject({ total: 0, pages: 1, rows: [], ran: ['A'] });
  });

  it('streams CSV, reading nothing before the body is read', async () => {
    let pulled = 0;
    state.stream = async function* () { for (let i = 0; i < 3; i++) { pulled++; yield row(i); } };
    const res = await get('format=csv&caught=A');
    expect(pulled).toBe(0);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${ADDR}-trades.csv"`);
    const text = await res.text();
    expect(text.split('\n')[0]).toBe(HEADER);
    expect(text.trim().split('\n')).toHaveLength(4);
    expect(text.split('\n')[1]).toBe(`2023-03-28T10:40:00.000Z,0,${SELLER},${BUYER},1.5,ETH,OpenSea,7200,,1.25,caught,,,0xtx0`);
  });

  it('reads each lens cell as caught, empty, not judged yet or did not run, and blanks an unpriced sale', async () => {
    state.moneyRan = false;
    state.stream = async function* () { yield row(1, { lenses: [] }); yield row(2, { judged: false, lenses: [], currency: '0xabc' }); };
    const lines = (await (await get('format=csv')).text()).trim().split('\n').slice(1);
    expect(lines[0]).toBe(`2023-03-28T10:40:00.000Z,1,${SELLER},${BUYER},1.5,ETH,OpenSea,7200,,1.25,,did not run,did not run,0xtx1`);
    expect(lines[1]).toBe(`2023-03-28T10:40:00.000Z,2,${SELLER},${BUYER},,,OpenSea,7200,,1.25,not judged yet,did not run,did not run,0xtx2`);
  });

  it('quotes per RFC 4180 and defuses a formula', async () => {
    state.stream = async function* () { yield row(1, { marketplace: '=1+1' }); yield row(2, { marketplace: 'a,"b"' }); };
    const text = await (await get('format=csv')).text();
    expect(text).toContain(",'=1+1,");
    expect(text).toContain(',"a,""b""",');
  });

  it('cancelling the download closes the generator', async () => {
    let closed = false;
    state.stream = async function* () { try { for (;;) yield row(0); } finally { closed = true; } };
    const reader = (await get('format=csv')).body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(closed).toBe(true);
  });

  it('a generator that throws on its second row errors the body instead of hanging', async () => {
    state.stream = async function* () { yield row(1); throw new Error('cursor lost'); };
    const reader = (await get('format=csv')).body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow('cursor lost');
  });

  it('passes the parsed filters and the lenses that ran to both the page read and the stream', async () => {
    state.moneyRan = false;
    await get('caught=A');
    await (await get('format=csv&caught=A')).text();
    for (const [, q, c] of [state.calls[0]!, state.streamArgs[0]!] as [unknown, { caught: string[] }, { ran: string[] }][]) {
      expect(q.caught).toEqual(['A']);
      expect(c.ran).toEqual(['A']);
    }
  });

  it('a row that fails to format still closes the generator, and errors the body', async () => {
    let closed = false;
    state.stream = async function* () { try { yield row(1, { blockTime: Number.NaN }); yield row(2); } finally { closed = true; } };
    await expect((await get('format=csv')).text()).rejects.toThrow();
    expect(closed).toBe(true);
  });

  it('a stream that rejects before its first row errors the body', async () => {
    state.stream = async function* () { throw new Error('no connection'); };
    await expect((await get('format=csv')).text()).rejects.toThrow('no connection');
  });

  it('cancelling before any read pulls nothing', async () => {
    let pulled = 0;
    state.stream = async function* () { pulled++; yield row(1); };
    await (await get('format=csv')).body!.cancel();
    expect(pulled).toBe(0);
  });

  it('guards strings, not numbers: a leading tab is defused and a negative number is left alone', async () => {
    state.stream = async function* () { yield row(1, { marketplace: '\tx', heldS: -5 }); };
    const line = (await (await get('format=csv')).text()).split('\n')[1]!;
    expect(line).toContain(",'\tx,-5,");
  });

  it('an unwatched collection is a 404 with a sentence', async () => {
    state.watched = false;
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'This collection is not watched.' });
  });
});
