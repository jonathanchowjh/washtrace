import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';
import { DOWNLOAD_STALL_MS, STREAM_MAX_MS } from '@washtrace/detect';

const ADDR = '0x' + 'b'.repeat(40);
const SELLER = '0x' + '1'.repeat(40);
const BUYER = '0x' + '2'.repeat(40);
const ctx = { params: Promise.resolve({ chain: '1', address: ADDR }) };
const HEADER = 'date,token,seller,buyer,price,currency,marketplace,held_seconds,buyer_age_seconds,price_vs_floor,Round trips,Money loops back (not counted),Linked wallets,tx';

const row = (i: number, over: Record<string, unknown> = {}) => ({
  txHash: `0xtx${i}`, logIndex: 0, blockNumber: 5, blockTime: 1_680_000_000, tokenId: String(i), from: SELLER, to: BUYER,
  marketplace: 'seaport-1.5', priceWei: '1500000000000000000', currency: '', flags: {}, lenses: ['A'], judged: true, heldS: 7200, buyerAgeS: null, floorRatio: 1.25, ...over,
});


/** A saved lens of yours and its run on this collection (null: it has none here). */
const ownRun = (id: number, name: string, status: 'done' | 'queued' = 'done', throughBlock = 10) => ({
  lens: { id, key: `L${id}`, name, rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 },
  run: { lensId: id, collectionId: 1, status, progress: null, lensVersion: 1, analysisId: 1, throughBlock, totals: status === 'done' ? { available: true } : null, error: null, retryAt: null, finishedAt: null, tookMs: 1 },
});

const fresh = () => ({
  runs: [] as ReturnType<typeof ownRun>[], watched: true, moneyRan: true, total: 120, unjudged: 3, rows: [row(1)] as unknown[], calls: [] as unknown[][], streamArgs: [] as unknown[][],
  stream: async function* () { yield row(1); } as () => AsyncGenerator<unknown>, streaming: 0,
});
const state = fresh();

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => state.watched ? { id: 1, chainId: 1, address: ADDR, latest: { id: 1, throughBlock: 10, totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, { available: m === 'A' || state.moneyRan }])) } } : null,
    get streaming() { return state.streaming; },
    lensRuns: async () => state.runs,
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

  it('reads a repeated key as the Trades form sends it, every value and not only the last', async () => {
    await get('caught=A&caught=AC&market=opensea&market=blur');
    expect(state.calls[0]![1]).toMatchObject({ caught: ['A', 'AC'], venues: ['opensea', 'blur'] });
  });

  it('clamps a page past the last, and holds nothing for a lens that did not run', async () => {
    expect((await (await get('page=99999')).json()).page).toBe(3);
    state.moneyRan = false;
    expect(await (await get('caught=AU')).json()).toMatchObject({ total: 0, pages: 1, rows: [], ran: ['A'] });
  });

  it('holds nothing for a group on a lens that did not run, as the Trades page does, and reads no store for it', async () => {
    state.moneyRan = false;
    expect(await (await get(`group=AU.t.5`)).json()).toMatchObject({ total: 0, pages: 1, rows: [], ran: ['A'] });
    expect(await (await get(`group=AC.w.${SELLER}&format=csv`)).text()).toBe(HEADER + '\n');
    expect(state.calls).toEqual([]);
    expect(state.streamArgs).toEqual([]);
    // A group on a lens that ran is read.
    await get('group=A.t.5');
    expect(state.calls).toHaveLength(1);
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
    expect(lines[0]).toBe(`2023-03-28T10:40:00.000Z,1,${SELLER},${BUYER},1.5,ETH,OpenSea,7200,,1.25,,not run,not run,0xtx1`);
    expect(lines[1]).toBe(`2023-03-28T10:40:00.000Z,2,${SELLER},${BUYER},,,OpenSea,7200,,1.25,not judged yet,not run,not run,0xtx2`);
  });

  it('quotes per RFC 4180 and defuses a formula', async () => {
    state.stream = async function* () { yield row(1, { marketplace: '=1+1' }); yield row(2, { marketplace: 'a,"b"' }); };
    const text = await (await get('format=csv')).text();
    expect(text).toContain(",'=1+1,");
    expect(text).toContain(',"a,""b""",');
  });

  it('answers 429 before any body while three downloads hold a connection', async () => {
    state.streaming = 3;
    const res = await get('format=csv');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many downloads at once; try again in a minute.' });
    expect(state.streamArgs).toEqual([]);
    state.streaming = 2;
    expect((await get('format=csv')).status).toBe(200);
  });

  it('cancelling the download closes the generator', async () => {
    let closed = false;
    state.stream = async function* () { try { for (;;) yield row(0); } finally { closed = true; } };
    const reader = (await get('format=csv')).body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(closed).toBe(true);
  });

  describe('a download nobody is reading', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('is closed after DOWNLOAD_STALL_MS without a pull, and its body errors', async () => {
      vi.useFakeTimers();
      let closed = false;
      state.stream = async function* () { try { for (;;) yield row(0); } finally { closed = true; } };
      const reader = (await get('format=csv')).body!.getReader();
      await reader.read();
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(closed).toBe(true);
      await expect(reader.read()).rejects.toThrow('nothing was reading it');
    });

    it('is not stalled while the reader keeps pulling, and its timer goes with the end', async () => {
      vi.useFakeTimers();
      state.stream = async function* () { yield row(1); yield row(2); yield row(3); };
      const reader = (await get('format=csv')).body!.getReader();
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1);
        expect((await reader.read()).done).toBe(false);
      }
      expect((await reader.read()).done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is stopped once when the cap fires while a row is being read: no stall timer is armed after it', async () => {
      vi.useFakeTimers();
      let release = () => {};
      let returns = 0;
      state.stream = async function* () {
        try { yield row(0); await new Promise<void>((r) => { release = r; }); yield row(1); } finally { returns++; }
      };
      const reader = (await get('format=csv')).body!.getReader();
      await reader.read();
      const second = reader.read().catch((e) => e);
      await vi.advanceTimersByTimeAsync(STREAM_MAX_MS);
      release();
      expect(String(await second)).toContain('ran too long');
      expect(returns).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is closed past STREAM_MAX_MS even when read steadily, and its body errors', async () => {
      vi.useFakeTimers();
      let closed = false;
      state.stream = async function* () { try { for (;;) yield row(0); } finally { closed = true; } };
      const reader = (await get('format=csv')).body!.getReader();
      let failure: unknown = null;
      for (let elapsed = 0; elapsed <= STREAM_MAX_MS && failure === null; elapsed += DOWNLOAD_STALL_MS - 1) {
        await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1);
        await reader.read().catch((e) => { failure = e; });
      }
      expect(closed).toBe(true);
      expect(String(failure)).toContain('ran too long');
    });
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

  it('appends a column per lens of yours after the three built-ins, by name, and reads it as caught, empty or did not run', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop'), ownRun(9, 'Slow flips', 'queued')];
    state.stream = async function* () { yield row(1, { lenses: ['A', 'L7'] }); yield row(2, { lenses: [] }); };
    const lines = (await (await get('format=csv')).text()).trim().split('\n');
    expect(lines[0]).toBe(HEADER.replace('Linked wallets,tx', 'Linked wallets,Blur 3-hop,Slow flips,tx'));
    expect(lines[1]!.endsWith(',caught,,,caught,not run,0xtx1')).toBe(true);
    expect(lines[2]!.endsWith(',,,,,not run,0xtx2')).toBe(true);
    expect(lines.join('\n')).not.toMatch(/\bL7\b/);
  });

  it('says not judged yet in a lens of yours\'s cell for a trade past the block its run read, and bounds every read by it', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop', 'done', 8)];
    state.stream = async function* () { yield row(1, { blockNumber: 8, lenses: ['A', 'L7'] }); yield row(2, { blockNumber: 9, lenses: ['A'] }); };
    const lines = (await (await get('format=csv')).text()).trim().split('\n');
    expect(lines[1]!.endsWith(',caught,,,caught,0xtx1')).toBe(true);
    // Judged by the latest analysis (built-ins), but past what Blur 3-hop read: not "", which would read as not caught.
    expect(lines[2]!.endsWith(',caught,,,not judged yet,0xtx2')).toBe(true);
    expect(state.streamArgs[0]![2]).toMatchObject({ ran: ['A', 'AU', 'AC', 'L7'], through: { L7: 8 } });
    const body = await (await get('caught=L7')).json();
    expect(state.calls[0]![2]).toMatchObject({ through: { L7: 8 } });
    // The JSON says it too, so a reader can tell a row past it from one Blur 3-hop judged clean.
    expect(body.through).toEqual({ L7: 8 });
  });

  it('guards and quotes a hostile lens name in the header: a formula, commas and quotes, and a leading + - or @', async () => {
    const names = ['=HYPERLINK("x")', 'a, "b"', '+1', '-1', '@me'];
    state.runs = names.map((n, i) => ownRun(i + 1, n));
    const header = (await (await get('format=csv')).text()).split('\n')[0]!;
    expect(header).toBe(HEADER.replace('Linked wallets,tx', `Linked wallets,"'=HYPERLINK(""x"")","a, ""b""",'+1,'-1,'@me,tx`));
  });

  it('reads a filter on your lens that ran, holds nothing for one that did not, and drops a deleted one', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop'), ownRun(9, 'Slow flips', 'queued')];
    const body = await (await get('caught=L7')).json();
    expect(body.ran).toEqual(['A', 'AU', 'AC', 'L7']);
    expect(state.calls[0]![1]).toMatchObject({ caught: ['L7'] });
    state.calls.length = 0;
    expect(await (await get('caught=L9')).json()).toMatchObject({ total: 0, rows: [] });
    expect(state.calls).toEqual([]);
    expect((await (await get('caught=L99')).json()).total).toBe(120);
    expect(state.calls[0]![1]).toMatchObject({ caught: [] });
  });
});
