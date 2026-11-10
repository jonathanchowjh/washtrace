import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'ab'.repeat(20);
const ANCHOR = '0x' + '12'.repeat(20);
const line = (rank: number) => ({ anchor: ANCHOR, rank, wallets: 2, sample: [ANCHOR], sales: 3, floorSales: 3, tokens: 1, volumeWei: '0', firstAt: null, lastAt: null });
/** 45 rings, as the store pages them. */
const TOTAL = 45;
const fake = {
  collection: vi.fn(async () => ({ id: 1, latest: null })),
  rings: vi.fn(async (_id: number, _ctx: unknown, limit: number, offset: number) => ({ rows: Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, i) => line(offset + i + 1)), total: TOTAL })),
  ring: vi.fn(async (_id: number, anchor: string) => (anchor === ANCHOR ? { line: line(1), wallets: [], walletsCut: false, tokens: [] } : null)),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
vi.mock('next/server', () => ({ connection: async () => {} }));

const { GET: list } = await import('@/app/api/collections/[chain]/[address]/rings/route');
const { GET: one } = await import('@/app/api/collections/[chain]/[address]/rings/[anchor]/route');
const params = Promise.resolve({ chain: '1', address: ADDR });

beforeEach(() => vi.clearAllMocks());

describe('GET a collection\'s rings', () => {
  it('pages them twenty at a time, and reads a page past the last as the last', async () => {
    const body = await (await list(new Request(`http://x/api/collections/1/${ADDR}/rings?page=2`), { params })).json();
    expect(body).toMatchObject({ total: 45, page: 2, pages: 3 });
    expect(fake.rings.mock.calls[0]!.slice(2)).toEqual([20, 20]);
    const past = await (await list(new Request(`http://x/api/collections/1/${ADDR}/rings?page=99`), { params })).json();
    expect(past).toMatchObject({ page: 3, pages: 3 });
    expect(past.rings).toHaveLength(5);
  });

  it('answers one ring by its anchor, and 404 for an anchor no ring has or that is no address', async () => {
    const at = (anchor: string) => one(new Request(`http://x/api/collections/1/${ADDR}/rings/${anchor}`), { params: Promise.resolve({ chain: '1', address: ADDR, anchor }) });
    expect((await (await at(ANCHOR.toUpperCase().replace('0X', '0x'))).json()).line.rank).toBe(1);
    expect((await at('0x' + '9'.repeat(40))).status).toBe(404);
    expect((await at('nope')).status).toBe(404);
    expect(fake.ring).toHaveBeenCalledTimes(2);
  });
});
