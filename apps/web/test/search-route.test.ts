import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'a'.repeat(40);
const W = '0x' + 'b'.repeat(40);
const RING = '0x' + '1'.repeat(40);
const more = { collections: false, tokens: false, wallets: false, trades: false };
const none = { collections: [], tokens: [], wallets: [], trades: [], more };
const wallet = { ...none, wallets: [{ chainId: 1, address: W, transfers: 3 }] };
const fake = {
  hits: wallet as Record<string, unknown>,
  collection: vi.fn(async () => ({ id: 9, chainId: 1, address: ADDR })),
  search: vi.fn(async () => structuredClone(fake.hits)),
  ringsOf: vi.fn(async () => [RING]),
  ringLines: vi.fn(async () => [{ anchor: RING, rank: 2 }]),
  walletTokens: vi.fn(async () => ['101', '7']),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));

const { GET } = await import('@/app/api/search/route');
const search = async (query: string) => (await GET(new Request(`http://x/api/search?${query}`))).json();

beforeEach(() => { vi.clearAllMocks(); fake.hits = wallet; });

describe('GET /api/search', () => {
  it('lists what a scoped search\'s best match, a wallet, is connected to in that collection', async () => {
    expect((await search(`q=0xbbbb&scope=1:${ADDR}`)).connected).toEqual({ wallet: W, rings: [{ anchor: RING, rank: 2 }], tokens: ['101', '7'] });
    expect(fake.ringsOf).toHaveBeenCalledWith(9, { wallet: W });
    expect(fake.walletTokens).toHaveBeenCalledWith(1, W, ADDR, 3);
  });

  it('adds nothing unscoped, for a page of one kind, or when the best match is not a wallet', async () => {
    expect((await search('q=0xbbbb')).connected).toBeUndefined();
    expect((await search(`q=0xbbbb&scope=1:${ADDR}&kind=wallets`)).connected).toBeUndefined();
    fake.hits = { ...wallet, tokens: [{ chainId: 1, address: ADDR, name: null, tokenId: '7', transfers: 1 }] };
    expect((await search(`q=%237&scope=1:${ADDR}`)).connected).toBeUndefined();
    expect(fake.ringsOf).not.toHaveBeenCalled();
  });
});
