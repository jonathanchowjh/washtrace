import { beforeEach, describe, expect, it, vi } from 'vitest';
import { METHODS, type AnalysisRow, type FlaggedTransfer, type Method, type MethodTotals } from '@washtrace/detect';

const A1 = '0x' + 'a1'.repeat(20);
const A2 = '0x' + 'a2'.repeat(20);
const TX = '0x' + 'cd'.repeat(32);

const totals = (ran: Method[]): Record<Method, MethodTotals> =>
  Object.fromEntries(METHODS.map((m) => [m, { transfers: 1, flagged: 0, sales: 1, flaggedSales: 0, volumeWei: '0', flaggedVolumeWei: '0', available: ran.includes(m) }])) as Record<Method, MethodTotals>;
const analysis = (throughBlock: number | null, ran: Method[] = ['A', 'AU', 'AC']) => ({ throughBlock, totals: totals(ran) }) as unknown as AnalysisRow;
const tr = (address: string, blockNumber: number, flags: FlaggedTransfer['flags'] = {}) =>
  ({ txHash: TX, logIndex: 0, blockNumber, tokenId: '1', from: '0x1', to: '0x2', flags, collection: { chainId: 1, address, name: null } }) as unknown as FlaggedTransfer;
const flag = { kind: 'pair' } as never;

const fake = {
  transfers: [] as FlaggedTransfer[],
  latest: {} as Record<string, AnalysisRow | null>,
  transaction: vi.fn(async () => fake.transfers),
  collection: vi.fn(async (_c: number, a: string) => (a in fake.latest ? { id: 1, latest: fake.latest[a] } : null)),
  token: vi.fn(async () => fake.transfers),
  flowsAmong: vi.fn(async () => []),
  lensRuns: vi.fn(async () => []),
  lensFlagsOfToken: vi.fn(async () => []),
  lensFlagsOfTx: vi.fn(async () => []),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));

const { txView } = await import('@/lib/views');
const { toneOf, answer } = await import('@/lib/metrics');
const { GET: transfersRoute } = await import('@/app/api/transfers/[chain]/[tx]/route');
const { GET: tokenRoute } = await import('@/app/api/collections/[chain]/[address]/tokens/[tokenId]/route');

beforeEach(() => { fake.transfers = []; fake.latest = {}; });

describe('what a transaction answers', () => {
  it('a transaction newer than its collection\'s analysis answers washTrade null and judged false', async () => {
    fake.transfers = [tr(A1, 11)];
    fake.latest = { [A1]: analysis(10) };
    const res = await transfersRoute(new Request('http://x'), { params: Promise.resolve({ chain: '1', tx: TX }) });
    expect(await res.json()).toMatchObject({ washTrade: null, judged: false, methods: [] });
  });

  it('the route answers its verdict and transfers, and reads nothing the page draws: no token, money, or lens of yours', async () => {
    fake.transfers = [tr(A1, 5, { A: flag, AU: flag })];
    fake.latest = { [A1]: analysis(10, ['A']) };
    for (const f of [fake.token, fake.flowsAmong, fake.lensRuns, fake.lensFlagsOfToken, fake.lensFlagsOfTx]) f.mockClear();
    const res = await transfersRoute(new Request('http://x'), { params: Promise.resolve({ chain: '1', tx: TX }) });
    expect(await res.json()).toEqual({
      chainId: 1, tx: TX, washTrade: true, judged: true, methods: ['A'], apartOnly: false, notRun: ['AU', 'AC'],
      transfers: [{ txHash: TX, logIndex: 0, blockNumber: 5, tokenId: '1', from: '0x1', to: '0x2', flags: { A: { kind: 'pair' } }, collection: { chainId: 1, address: A1, name: null } }],
    });
    for (const f of [fake.token, fake.flowsAmong, fake.lensRuns, fake.lensFlagsOfToken, fake.lensFlagsOfTx]) expect(f).not.toHaveBeenCalled();
  });

  it('a transaction across two collections, flagged by Round trips in the analysed one, answers washTrade true and judged false', async () => {
    fake.transfers = [tr(A1, 5, { A: flag }), tr(A2, 5)];
    fake.latest = { [A1]: analysis(10), [A2]: null };
    expect(await txView(1, TX)).toMatchObject({ washTrade: true, judged: false, by: ['A'] });
  });

  it('a judged, unflagged transaction answers washTrade false and judged true', async () => {
    fake.transfers = [tr(A1, 5)];
    fake.latest = { [A1]: analysis(10) };
    expect(await txView(1, TX)).toMatchObject({ washTrade: false, judged: true, by: [], notRun: [], apartOnly: false });
  });

  it('a transaction flagged only by Money loops back answers washTrade false, with AU in methods', async () => {
    fake.transfers = [tr(A1, 5, { AU: flag })];
    fake.latest = { [A1]: analysis(10) };
    expect(await txView(1, TX)).toMatchObject({ washTrade: false, by: ['AU'], apartOnly: true });
  });

  it('a money lens that did not run never counts as flagging', async () => {
    fake.transfers = [tr(A1, 5, { A: flag, AU: flag, AC: flag })];
    fake.latest = { [A1]: analysis(10, ['A']) };
    expect(await txView(1, TX)).toMatchObject({ washTrade: true, by: ['A'], apartOnly: false, notRun: ['AU', 'AC'] });
    expect(Object.keys((await txView(1, TX)).transfers[0]!.flags)).toEqual(['A']);
  });

  it('the token route carries only the lenses that ran, as the token page does', async () => {
    fake.transfers = [tr(A1, 5, { A: flag, AU: flag, AC: flag })];
    fake.latest = { [A1]: analysis(10, ['A']) };
    const res = await tokenRoute(new Request('http://x'), { params: Promise.resolve({ chain: '1', address: A1, tokenId: '1' }) });
    const body = await res.json();
    expect(Object.keys(body.transfers[0].flags)).toEqual(['A']);
    expect(body).toMatchObject({ washTrade: true, judged: true, methods: ['A'], apartOnly: false, notRun: ['AU', 'AC'] });
    expect(body).not.toHaveProperty('latest');
    expect(body).not.toHaveProperty('by');
  });

  it('a token with no transfers is 404, saying No transfer of this token is read.', async () => {
    fake.latest = { [A1]: analysis(10) };
    fake.transfers = [];
    const res = await tokenRoute(new Request('http://x'), { params: Promise.resolve({ chain: '1', address: A1, tokenId: '7' }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No transfer of this token is read.' });
    const unwatched = await tokenRoute(new Request('http://x'), { params: Promise.resolve({ chain: '1', address: A2, tokenId: '7' }) });
    expect(await unwatched.json()).toEqual({ error: 'This collection is not watched.' });
  });
});

describe('toneOf', () => {
  const w = flag;
  it('reads a trade by the strongest counted lens, and AU alone as apart', () => {
    expect(toneOf({ flags: { A: w } })).toBe('cycle');
    expect(toneOf({ flags: { AC: w } })).toBe('money');
    expect(toneOf({ flags: { AU: w } })).toBe('apart');
    expect(toneOf({ flags: { AU: w, AC: w } })).toBe('money');
    expect(toneOf({ flags: {} })).toBe('clean');
  });
});

describe('answer', () => {
  const v = { judged: true, washTrade: false, by: [] as Method[], apartOnly: false, notRun: [] as Method[] };
  it('says one title and tone per rung', () => {
    expect(answer({ ...v, washTrade: true, by: ['AC'] }, 'X')).toEqual({ title: 'X', tone: 'money' });
    expect(answer({ ...v, washTrade: true, by: ['A', 'AC'] }, 'X')).toEqual({ title: 'X', tone: 'cycle' });
    expect(answer({ ...v, judged: false, washTrade: null }, 'X')).toEqual({ title: 'Not judged yet', tone: 'clean' });
    expect(answer({ ...v, by: ['AU'], apartOnly: true }, 'X')).toEqual({ title: 'Flagged only by Money loops back, which is not counted', tone: 'apart' });
    expect(answer(v, 'X')).toEqual({ title: 'Not flagged by any lens', tone: 'clean' });
    expect(answer({ ...v, notRun: ['AU', 'AC'] }, 'X')).toEqual({ title: 'Not flagged by the lenses that ran', tone: 'clean' });
  });
});
