import { afterEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'a'.repeat(40);
const TX = '0x' + 'c'.repeat(64);
const none = { collections: [], tokens: [], wallets: [], trades: [], more: { collections: false, tokens: false, wallets: false, trades: false } };
const state = { watched: false, hits: none as Record<string, unknown>, asked: undefined as unknown, chains: [] as number[] };
vi.mock('@/lib/store', () => ({
  store: () => ({ collection: async () => (state.watched ? { id: 1, chainId: 1 } : null), collections: async () => state.chains.map((chainId) => ({ chainId })), search: async (_p: unknown, opts: unknown) => { state.asked = opts; return state.hits; } }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), connection: async () => {} }));

afterEach(() => { Object.assign(state, { watched: false, hits: none, chains: [] }); });

async function go(q: string, chain?: string): Promise<string> {
  const { GET } = await import('@/app/go/route');
  const { NextRequest } = await import('next/server');
  const res = await GET(new NextRequest(`http://x/go?q=${encodeURIComponent(q)}${chain === undefined ? '' : `&chain=${chain}`}`));
  expect(res.status).toBe(303);
  // Relative, so it stays on the host the reader asked on.
  expect(res.headers.get('location')).toMatch(/^\//);
  const to = new URL(res.headers.get('location')!, 'http://x');
  return to.pathname + to.search;
}
const coll = { chainId: 1, address: ADDR, name: 'Terraforms', symbol: 'TERRA', totals: null };

describe('/go', () => {
  it('sends a transaction hash to its transaction, under its collection\'s tabs, even when search would find more', async () => {
    state.hits = { ...none, trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'A', tokenId: '1' }, { chainId: 1, txHash: TX, address: ADDR, name: 'A', tokenId: '2' }] };
    expect(await go(TX.toUpperCase().replace('0X', '0x'))).toBe(`/c/1/${ADDR}/tx/${TX}`);
  });

  it('a transaction that moved tokens of two collections opens on its own page, under neither', async () => {
    const other = '0x' + 'b'.repeat(40);
    state.hits = { ...none, trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'A', tokenId: '1' }, { chainId: 1, txHash: TX, address: other, name: 'B', tokenId: '2' }] };
    expect(await go(TX)).toBe(`/tx/1/${TX}`);
  });

  it('with no chain given, finds a transaction hash on whichever chain holds it', async () => {
    state.hits = { ...none, trades: [{ chainId: 8453, txHash: TX, address: ADDR, name: 'A', tokenId: '1' }] };
    expect(await go(TX)).toBe(`/c/8453/${ADDR}/tx/${TX}`);
  });

  it('with no chain given, a hash on two chains goes to the results, and one nothing holds goes there to say so', async () => {
    state.hits = { ...none, trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'A', tokenId: '1' }, { chainId: 8453, txHash: TX, address: ADDR, name: 'B', tokenId: '1' }] };
    expect(await go(TX)).toBe(`/search?q=${TX}`);
    state.hits = none;
    expect(await go(TX)).toBe(`/search?q=${TX}`);
  });

  // Past one page of hits, its other transfers could be in another collection: it opens on its own page.
  it('a hash of a transaction with more transfers than one page of hits still opens it', async () => {
    state.hits = { ...none, trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'A', tokenId: '1' }], more: { ...none.more, trades: true } };
    expect(await go(TX)).toBe(`/tx/1/${TX}`);
  });

  it('opens the one transaction the start of a hash finds', async () => {
    state.hits = { ...none, trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'A', tokenId: '1' }, { chainId: 1, txHash: TX, address: ADDR, name: 'A', tokenId: '2' }] };
    expect(await go('0xcccc')).toBe(`/c/1/${ADDR}/tx/${TX}`);
  });

  it('with a chain given, a hash goes straight to that chain’s transaction', async () => {
    expect(await go(TX, '8453')).toBe(`/tx/8453/${TX}`);
  });

  it('with a chain given, sends an address to that chain: a watched collection to it, any other to the wallet', async () => {
    expect(await go(ADDR, '8453')).toBe(`/w/8453/${ADDR}`);
    state.watched = true;
    expect(await go(ADDR, '8453')).toBe(`/c/8453/${ADDR}`);
  });

  it('with no chain given, finds an address on whichever chain holds it', async () => {
    state.hits = { ...none, collections: [{ ...coll, chainId: 8453 }] };
    expect(await go(ADDR)).toBe(`/c/8453/${ADDR}`);
    state.hits = { ...none, wallets: [{ chainId: 8453, address: ADDR, transfers: 3 }] };
    expect(await go(ADDR)).toBe(`/w/8453/${ADDR}`);
  });

  it('with no chain given, an address that is a collection and a wallet opens the collection', async () => {
    state.hits = { ...none, collections: [{ ...coll, chainId: 8453 }], wallets: [{ chainId: 8453, address: ADDR, transfers: 3 }] };
    expect(await go(ADDR)).toBe(`/c/8453/${ADDR}`);
  });

  it('with no chain given, an address nothing holds opens its wallet page, and one on two chains goes to the results', async () => {
    expect(await go(ADDR)).toBe(`/w/1/${ADDR}`);
    state.hits = { ...none, wallets: [{ chainId: 1, address: ADDR, transfers: 3 }, { chainId: 8453, address: ADDR, transfers: 1 }] };
    expect(await go(ADDR)).toBe(`/search?q=${ADDR}`);
  });

  it('an address nothing holds opens its wallet on the one chain that is watched, else on Ethereum', async () => {
    state.chains = [31337, 31337];
    expect(await go(ADDR)).toBe(`/w/31337/${ADDR}`);
    state.chains = [1, 8453];
    expect(await go(ADDR)).toBe(`/w/1/${ADDR}`);
  });

  it('redirects to the one thing a name finds', async () => {
    state.hits = { ...none, collections: [coll] };
    expect(await go('terraforms')).toBe(`/c/1/${ADDR}`);
  });

  it('redirects to a token or a wallet when that is the only hit', async () => {
    state.hits = { ...none, tokens: [{ chainId: 1, address: ADDR, name: 'T', tokenId: '7', transfers: 3 }] };
    expect(await go('#7')).toBe(`/c/1/${ADDR}/t/7`);
    state.hits = { ...none, wallets: [{ chainId: 1, address: ADDR, transfers: 3 }] };
    expect(await go('0xaaaa')).toBe(`/w/1/${ADDR}`);
  });

  it('sends two hits, or a hit cut by its limit, to the results page', async () => {
    state.hits = { ...none, collections: [coll, { ...coll, chainId: 10 }] };
    expect(await go('terraforms')).toBe('/search?q=terraforms');
    state.hits = { ...none, collections: [coll], more: { ...none.more, collections: true } };
    expect(await go('terraforms')).toBe('/search?q=terraforms');
  });

  it('never lands on /?q=: no hit, empty and junk all go to the results page', async () => {
    expect(await go('terraforms')).toBe('/search?q=terraforms');
    expect(await go('')).toBe('/search?q=');
    expect(await go('0xzz')).toBe('/search?q=0xzz');
  });
});

describe('/go from inside a collection', () => {
  const W = '0x' + 'b'.repeat(40);

  it('narrows the search to the collection, opens a wallet it finds under its tabs, and keeps the scope on the results', async () => {
    state.watched = true;
    state.hits = { ...none, wallets: [{ chainId: 1, address: W, transfers: 3 }] };
    const { GET } = await import('@/app/go/route');
    const { NextRequest } = await import('next/server');
    const at = async (q: string) => new URL((await GET(new NextRequest(`http://x/go?q=${encodeURIComponent(q)}&scope=1:${ADDR}`))).headers.get('location')!, 'http://x');
    const to = await at('0xbbbbbb');
    expect(to.pathname).toBe(`/c/1/${ADDR}/w/${W}`);
    expect(state.asked).toEqual({ scope: { id: 1, chainId: 1 } });
    state.hits = { ...none, wallets: [{ chainId: 1, address: W, transfers: 3 }, { chainId: 1, address: ADDR, transfers: 1 }] };
    const many = await at('0xbbbbbb');
    expect(many.pathname + many.search).toBe(`/search?q=0xbbbbbb&scope=1:${ADDR}`);
  });

  it('opens a ring’s middle it finds, one that never traded here, under the collection’s tabs, where its role is said', async () => {
    state.watched = true;
    // As the store finds a funder by the start of its address: no transfer, not here, the ceiling's tier.
    state.hits = { ...none, wallets: [{ chainId: 1, address: W, transfers: 0, here: false, tier: 'ceiling' }] };
    const { GET } = await import('@/app/go/route');
    const { NextRequest } = await import('next/server');
    const to = new URL((await GET(new NextRequest(`http://x/go?q=0xbbbbbb&scope=1:${ADDR}`))).headers.get('location')!, 'http://x');
    expect(to.pathname).toBe(`/c/1/${ADDR}/w/${W}`);
    // One that never traded here and is no middle opens on its own page.
    state.hits = { ...none, wallets: [{ chainId: 1, address: W, transfers: 0, here: false, tier: null }] };
    const away = new URL((await GET(new NextRequest(`http://x/go?q=0xbbbbbb&scope=1:${ADDR}`))).headers.get('location')!, 'http://x');
    expect(away.pathname).toBe(`/w/1/${W}`);
  });

  it('ignores a scope that names no watched collection', async () => {
    state.watched = false;
    state.hits = { ...none, wallets: [{ chainId: 1, address: W, transfers: 3 }] };
    const { GET } = await import('@/app/go/route');
    const { NextRequest } = await import('next/server');
    const to = new URL((await GET(new NextRequest(`http://x/go?q=0xbbbbbb&scope=1:${ADDR}`))).headers.get('location')!, 'http://x');
    expect(to.pathname).toBe(`/w/1/${W}`);
    expect(state.asked).toEqual({});
  });
});
