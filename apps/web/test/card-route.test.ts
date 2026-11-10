import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'ab'.repeat(20);
const W = '0x' + '12'.repeat(20);
const fake = {
  collection: vi.fn(async () => ({ id: 1, latest: { id: 4 } })),
  walletTradeCount: vi.fn(async (_c: number, _a: string, f: { flaggedOnly?: boolean }) => (f.flaggedOnly ? 1 : 5)),
  ringsOf: vi.fn(async () => [W]),
  ringLines: vi.fn(async (_id: number, anchors: string[]) => anchors.map((anchor) => ({ anchor, rank: 2 }))),
  token: vi.fn(async (_id: number, tokenId: string) => (tokenId === '7' ? [{ flags: { A: {} } }, { flags: {} }, { flags: { AU: {} } }] : [])),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
vi.mock('next/server', () => ({ connection: async () => {} }));

const { GET } = await import('@/app/api/collections/[chain]/[address]/card/route');
const card = (q: string) => GET(new Request(`http://x/api/collections/1/${ADDR}/card?${q}`), { params: Promise.resolve({ chain: '1', address: ADDR }) });

beforeEach(() => vi.clearAllMocks());

describe('GET a hover card', () => {
  it('says a wallet\'s trades here, those counted flagged, and its first ring', async () => {
    expect(await (await card(`wallet=${W}`)).json()).toMatchObject({ kind: 'wallet', judged: true, trades: 5, flagged: 1, rings: 1, ring: { rank: 2 } });
    expect(fake.walletTradeCount.mock.calls[0]![2]).toEqual({ collection: ADDR });
  });

  it('counts a token\'s transfers and those a counted lens flags, Money loops back left out', async () => {
    expect(await (await card('token=7')).json()).toEqual({ kind: 'token', judged: true, tokenId: '7', transfers: 3, flagged: 1 });
    expect((await card('token=8')).status).toBe(404);
  });

  it('wants exactly one of wallet, token or ring', async () => {
    expect((await card('')).status).toBe(400);
    expect((await card(`wallet=${W}&token=7`)).status).toBe(400);
  });
});
