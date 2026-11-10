import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'a'.repeat(40);
const TX = '0x' + 'c'.repeat(64);
const more = { collections: false, tokens: false, wallets: false, trades: false };
const none = { collections: [], tokens: [], wallets: [], trades: [], more };
const state = { hits: none as Record<string, unknown>, calls: [] as unknown[], sources: {} as Record<string, unknown> };

vi.mock('@/lib/store', () => ({
  store: () => ({
    search: async (p: unknown, o: unknown) => { state.calls.push([p, o]); return state.hits; },
    sources: async () => state.sources, settings: async () => new Map<string, string>(),
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(() => { cleanup(); Object.assign(state, { hits: none, calls: [], sources: {} }); });

async function dom(sp: Record<string, string>): Promise<HTMLElement> {
  const { default: SearchPage } = await import('@/app/search/page');
  return render(await SearchPage({ searchParams: Promise.resolve(sp) })).container;
}
const coll = { chainId: 1, address: ADDR, name: 'Terraforms', symbol: 'TERRA' };

describe('the search page', () => {
  it('titles itself with the search and lists a name\'s collection as a link that says what it is', async () => {
    state.hits = { ...none, collections: [coll] };
    const c = await dom({ q: 'terra' });
    expect(c.querySelector('h1')?.textContent).toBe('Search: “terra”');
    const a = [...c.querySelectorAll('a')].find((x) => x.getAttribute('href') === `/c/1/${ADDR}`)!;
    expect(a.textContent).toContain('Collection on Ethereum · Terraforms');
  });

  it('says a token, a wallet and a trade each in a line, with its count in its heading', async () => {
    state.hits = {
      ...none,
      tokens: [{ chainId: 1, address: ADDR, name: 'Meebits', tokenId: '1234', transfers: 14 }],
      wallets: [{ chainId: 1, address: ADDR, transfers: 41 }],
      trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'Meebits', tokenId: '14022' }],
    };
    const c = await dom({ q: '#1234' });
    const t = c.textContent!;
    expect(t).toContain('Token #1234 in Meebits · 14 transfers');
    expect(t).toContain('Wallet on Ethereum · in 41 transfers of watched collections');
    expect(t).toContain('Trade in Meebits, token #14022');
    expect(c.querySelector(`a[href="/c/1/${ADDR}/t/1234"]`)).not.toBeNull();
    expect(c.querySelector(`a[href="/w/1/${ADDR}"]`)).not.toBeNull();
    expect(c.querySelector(`a[href="/c/1/${ADDR}/tx/${TX}"]`)).not.toBeNull();
    expect([...c.querySelectorAll('h2')].map((h) => h.textContent).join('|')).toMatch(/\(1\)/);
  });

  it('a kind with more says so and links to its own list', async () => {
    state.hits = { ...none, wallets: [{ chainId: 1, address: ADDR, transfers: 2 }], more: { ...more, wallets: true } };
    const c = await dom({ q: '0xaaaa' });
    expect(c.textContent).toContain('More than 20. See all wallets →');
    const a = [...c.querySelectorAll('a')].find((x) => x.textContent === 'See all wallets →')!;
    expect(a.getAttribute('href')).toBe('/search?q=0xaaaa&kind=wallets');
  });

  it('a kind view pages with Previous and Next, and asks the store for that page of that kind only', async () => {
    state.hits = { ...none, wallets: [{ chainId: 1, address: ADDR, transfers: 2 }], more: { ...more, wallets: true } };
    const c = await dom({ q: '0xaaaa', kind: 'wallets', page: '2' });
    expect(state.calls).toEqual([[{ kind: 'prefix', prefix: '0xaaaa' }, { offset: 20, only: 'wallets' }]]);
    const link = (label: string) => [...c.querySelectorAll('a')].find((x) => x.textContent === label)?.getAttribute('href');
    expect(link('‹ Previous')).toBe('/search?q=0xaaaa&kind=wallets');
    expect(link('Next ›')).toBe('/search?q=0xaaaa&kind=wallets&page=3');
    // The store cannot count the rest, so the total is a floor, not a number to page to.
    expect(c.textContent).toContain('of more than 21 wallets');
    expect(c.textContent).not.toContain('Last »');
    expect(c.querySelector('input[type=number]')?.hasAttribute('max')).toBe(false);
    expect(c.querySelector('input[name=q]')?.getAttribute('value')).toBe('0xaaaa');
  });

  it('says what is searched when nothing matches, with no explorer link for a name', async () => {
    const c = await dom({ q: 'hello' });
    expect(c.textContent).toContain('Nothing watched matches “hello”. washtrace searches watched collections, their tokens and wallets, and the trades it has read.');
    expect(c.textContent).not.toContain('Look it up');
  });

  it('adds an explorer link for an address or a hash that matches nothing', async () => {
    const a = (await dom({ q: ADDR })).querySelector('a[href^="https://etherscan.io/address/"]');
    expect(a?.textContent).toBe('Look it up on Etherscan ↗');
    expect(a?.getAttribute('target')).toBe('_blank');
    cleanup();
    expect((await dom({ q: TX })).querySelector(`a[href="https://etherscan.io/tx/${TX}"]`)).not.toBeNull();
  });

  it('shows the hint for empty or too-short text, and asks the store nothing', async () => {
    for (const q of ['', 'x', '#']) {
      expect((await dom({ q })).textContent).toContain('Type a collection name, a token number (#1234), a wallet address or its start, or a transaction hash.');
      cleanup();
    }
    expect((await dom({})).textContent).toContain('Type a collection name');
    expect(state.calls).toEqual([]);
  });

  it('drops junk in the URL without an error: an unknown kind, page=-2, and a page past the last', async () => {
    state.hits = { ...none, collections: [coll] };
    await dom({ q: 'terra', kind: 'nope', page: '-2' });
    expect(state.calls).toEqual([[{ kind: 'text', text: 'terra' }, { offset: 0, only: undefined }]]);
    cleanup();
    state.hits = none;
    const t = (await dom({ q: 'terra', kind: 'collections', page: '99999' })).textContent;
    expect(t).toContain('That page is past the last result.');
    expect(t).not.toContain('Nothing watched matches');
  });

  it('a pasted hash nothing matches links a check on each chain with an RPC', async () => {
    state.sources = { 'rpc.1': { from: 'env', value: 'https://…' }, 'rpc.8453': { from: 'env', value: 'https://…' } };
    const c = await dom({ q: TX });
    expect(c.textContent).toContain('Check it on');
    expect(c.querySelector(`a[href="/tx/1/${TX}"]`)?.textContent).toBe('Ethereum');
    expect(c.querySelector(`a[href="/tx/8453/${TX}"]`)?.textContent).toBe('Base');
  });

  it('offers no check for a pasted hash when no chain has an RPC', async () => {
    const c = await dom({ q: TX });
    expect(c.textContent).not.toContain('Check it on');
  });
});
