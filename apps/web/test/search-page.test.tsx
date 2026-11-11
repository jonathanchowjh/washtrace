import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'a'.repeat(40);
const TX = '0x' + 'c'.repeat(64);
const more = { collections: false, tokens: false, wallets: false, trades: false };
const none = { collections: [], tokens: [], wallets: [], trades: [], more };
const state = { hits: none as Record<string, unknown>, calls: [] as unknown[], sources: {} as Record<string, unknown>, collection: null as Record<string, unknown> | null };

vi.mock('@/lib/store', () => ({
  store: () => ({
    search: async (p: unknown, o: unknown) => { state.calls.push([p, o]); return state.hits; },
    sources: async () => state.sources, settings: async () => new Map<string, string>(), collection: async () => state.collection,
  }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(() => { cleanup(); Object.assign(state, { hits: none, calls: [], sources: {}, collection: null }); });

async function dom(sp: Record<string, string>): Promise<HTMLElement> {
  const { default: SearchPage } = await import('@/app/search/page');
  return render(await SearchPage({ searchParams: Promise.resolve(sp) })).container;
}
const coll = { chainId: 1, address: ADDR, name: 'Terraforms', symbol: 'TERRA', totals: null };
// Round trips flags 18 of 100 sales, Linked wallets 25.
const t = (flaggedSales: number, available = true) => ({ transfers: 100, flagged: flaggedSales, sales: 100, flaggedSales, volumeWei: '0', flaggedVolumeWei: '0', wallets: 0, tokens: 0, available });

describe('the search page', () => {
  it('titles itself with the search and lists a name\'s collection as a link that says what it is', async () => {
    state.hits = { ...none, collections: [coll] };
    const c = await dom({ q: 'terra' });
    expect(c.querySelector('h1')?.textContent).toBe('Search: “terra”');
    const a = [...c.querySelectorAll('a')].find((x) => x.getAttribute('href') === `/c/1/${ADDR}`)!;
    expect(a.textContent).toContain('TerraformsCollection on Ethereum · 0xaaaa…aaaa');
  });

  it('leads each hit with what was searched for, the kind and chain under it, and a hash in mono', async () => {
    state.hits = { ...none, wallets: [{ chainId: 1, address: ADDR, transfers: 41 }], trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'Meebits', tokenId: '14022' }] };
    const c = await dom({ q: '0xaaaa' });
    const parts = (href: string) => [...c.querySelector(`a[href="${href}"]`)!.querySelectorAll('span.block')].map((s) => [s.textContent, s.className.includes('font-mono')]);
    expect(parts(`/w/1/${ADDR}`)).toEqual([['0xaaaa…aaaa', true], ['Wallet on Ethereum · in 41 transfers of watched collections', false]]);
    expect(parts(`/c/1/${ADDR}/tx/${TX}`)).toEqual([['0xcccc…cccc', true], ['Trade on Ethereum · Meebits #14022', false]]);
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
    expect(t).toContain('Meebits #1234Token on Ethereum · 14 transfers');
    expect(t).toContain('0xaaaa…aaaaWallet on Ethereum · in 41 transfers of watched collections');
    expect(t).toContain('0xcccc…ccccTrade on Ethereum · Meebits #14022');
    expect(c.querySelector(`a[href="/c/1/${ADDR}/t/1234"]`)).not.toBeNull();
    expect(c.querySelector(`a[href="/w/1/${ADDR}"]`)).not.toBeNull();
    expect(c.querySelector(`a[href="/c/1/${ADDR}/tx/${TX}"]`)).not.toBeNull();
    expect([...c.querySelectorAll('h2')].map((h) => h.textContent).join('|')).toMatch(/\(1\)/);
  });

  it('lists the transactions the start of a hash matches, after the wallets, under a heading that says so', async () => {
    state.hits = { ...none, wallets: [{ chainId: 1, address: ADDR, transfers: 2 }], trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'Meebits', tokenId: '14022' }] };
    const c = await dom({ q: '0xcccc' });
    expect(state.calls).toEqual([[{ kind: 'prefix', prefix: '0xcccc' }, { offset: 0, only: undefined }]]);
    expect([...c.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Which wallets match? (1)', 'Which transactions start that way? (1)']);
    expect(c.querySelector(`a[href="/c/1/${ADDR}/tx/${TX}"]`)).not.toBeNull();
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

  it('says a query too short to be read as a token or the start of an address is too short', async () => {
    expect((await dom({ q: '10' })).textContent).toContain('Nothing watched is named “10”. Too short for a token number: type 3 digits, or #10.');
    cleanup();
    expect((await dom({ q: '0x18' })).textContent).toContain('Nothing watched is named “0x18”. Too short to search wallets and transactions: type at least 4 characters after 0x.');
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
      expect((await dom({ q })).textContent).toContain('Type a collection name, a token number (#1234), a wallet address or a transaction hash, or the start of either.');
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

  it('heads with its title alone, no trail, and its rows run the page\'s width', async () => {
    state.hits = { ...none, collections: [coll] };
    const c = await dom({ q: 'terra' });
    expect(c.querySelector('nav[aria-label=Trail]')).toBeNull();
    expect(c.querySelector('ul')?.className).not.toMatch(/max-w-/);
  });

  it('gives each row what it knows besides its title: a symbol, whether a wallet traded here; a trade, its hash already its title, none', async () => {
    const W = '0x' + 'b'.repeat(40);
    state.collection = { id: 3, chainId: 1, address: ADDR, name: 'Terraforms' };
    state.hits = {
      ...none, collections: [coll],
      wallets: [{ chainId: 1, address: W, transfers: 4, here: true }, { chainId: 1, address: ADDR, transfers: 1, here: false }],
      trades: [{ chainId: 1, txHash: TX, address: ADDR, name: 'Meebits', tokenId: '14022' }],
    };
    const c = await dom({ q: 'terra', scope: `1:${ADDR}` });
    const chipIn = (href: string) => c.querySelector(`a[href="${href}"] [data-chip]`)?.textContent;
    expect(chipIn(`/c/1/${ADDR}`)).toBe('TERRA');
    expect(chipIn(`/c/1/${ADDR}/w/${W}`)).toBe('Traded here');
    expect(chipIn(`/w/1/${ADDR}`)).toBe('Never traded here');
    expect(chipIn(`/c/1/${ADDR}/tx/${TX}`)).toBeUndefined();
  });

  it('says a token has flagged trades, and says nothing of one without: it may not be judged yet', async () => {
    const token = { chainId: 1, address: ADDR, name: 'Meebits', tokenId: '1234', transfers: 14 };
    state.hits = { ...none, tokens: [{ ...token, flagged: true }, { ...token, address: '0x' + 'b'.repeat(40), flagged: false }] };
    const c = await dom({ q: '#1234' });
    expect(c.querySelector(`a[href="/c/1/${ADDR}/t/1234"] [data-chip]`)?.textContent).toBe('Has flagged trades');
    expect(c.querySelector(`a[href="/c/1/0x${'b'.repeat(40)}/t/1234"] [data-chip]`)).toBeNull();
  });

  it('gives an analysed collection its range of washed sales in place of its symbol', async () => {
    state.hits = { ...none, collections: [{ ...coll, totals: { A: t(18), AU: t(40), AC: t(25) } }] };
    const chip = (await dom({ q: 'terra' })).querySelector(`a[href="/c/1/${ADDR}"] [data-chip]`)?.textContent;
    expect(chip).toBe('18–25% of sales look washed');
    cleanup();
    // Only Round trips read: one share, not a range.
    state.hits = { ...none, collections: [{ ...coll, totals: { A: t(18), AU: t(0, false), AC: t(0, false) } }] };
    expect((await dom({ q: 'terra' })).querySelector('[data-chip]')?.textContent).toBe('18% of sales look washed');
  });

  it('offers no check for a pasted hash when no chain has an RPC', async () => {
    const c = await dom({ q: TX });
    expect(c.textContent).not.toContain('Check it on');
  });
});
