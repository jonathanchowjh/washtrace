import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'ab'.repeat(20);
const W = '0x' + '12'.repeat(20);
const fake = {
  collection: vi.fn(async () => ({ id: 1, latest: { id: 4 } })),
  walletTradeCount: vi.fn(async (_c: number, _a: string, f: { flaggedOnly?: boolean }) => (f.flaggedOnly ? 1 : 5)),
  ringsOf: vi.fn(async (_id: number, _of: unknown) => [W]),
  ringLines: vi.fn(async (_id: number, anchors: string[]) => anchors.map((anchor) => ({ anchor, rank: 2 }))),
  token: vi.fn(async (_id: number, tokenId: string) => (tokenId === '7' ? [{ flags: { A: {} } }, { flags: {} }, { flags: { AU: {} } }]
    : tokenId === '9' ? [{ flags: { AC: {} } }] : tokenId === '10' ? [{ flags: { AU: {} } }] : [])),
  walletTiers: vi.fn(async (_id: number, wallets: string[]) => new Map(wallets.map((a) => [a, 'ceiling']))),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));

const { GET } = await import('@/app/api/collections/[chain]/[address]/card/route');
const card = (q: string) => GET(new Request(`http://x/api/collections/1/${ADDR}/card?${q}`), { params: Promise.resolve({ chain: '1', address: ADDR }) });

beforeEach(() => vi.clearAllMocks());

describe('GET a hover card', () => {
  it('says a wallet\'s trades here, those counted flagged, and its highest-ranked ring', async () => {
    expect(await (await card(`wallet=${W}`)).json()).toMatchObject({ kind: 'wallet', judged: true, trades: 5, flagged: 1, rings: 1, ring: { rank: 2 }, tier: 'ceiling' });
    expect(fake.walletTradeCount.mock.calls[0]![2]).toEqual({ collection: ADDR });
  });

  it('names the ring of highest rank, not the one of smallest anchor', async () => {
    const low = '0x' + '01'.repeat(20), high = '0x' + 'f1'.repeat(20);
    fake.ringsOf.mockResolvedValueOnce([low, high]);
    fake.ringLines.mockResolvedValueOnce([{ anchor: high, rank: 1 }, { anchor: low, rank: 57 }]);
    expect((await (await card(`wallet=${W}`)).json()).ring).toEqual({ anchor: high, rank: 1 });
    expect(fake.ringLines.mock.calls[0]![1]).toEqual([low, high]);
  });

  it('counts a token\'s transfers and those a counted lens flags, Money loops back left out', async () => {
    expect(await (await card('token=7')).json()).toMatchObject({ kind: 'token', judged: true, tokenId: '7', transfers: 3, flagged: 1 });
    expect((await card('token=8')).status).toBe(404);
  });

  it('gives a token its tier and its highest ring: the floor if Round trips flags it, else the ceiling, else none', async () => {
    expect(await (await card('token=7')).json()).toMatchObject({ tier: 'cycle', ring: { anchor: W, rank: 2 } });
    expect(fake.ringsOf.mock.calls[0]![1]).toEqual({ tokenId: '7' });
    expect((await (await card('token=9')).json()).tier).toBe('ceiling');
    // Only Money loops back flags it: not counted, so no tier; and in no ring.
    fake.ringsOf.mockResolvedValueOnce([]);
    expect(await (await card('token=10')).json()).toMatchObject({ flagged: 0, tier: null, ring: null });
  });

  it('wants exactly one of wallet, token or ring', async () => {
    expect((await card('')).status).toBe(400);
    expect((await card(`wallet=${W}&token=7`)).status).toBe(400);
  });
});
