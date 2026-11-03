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
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
vi.mock('next/server', () => ({ connection: async () => {} }));

const { txView } = await import('@/lib/views');
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
