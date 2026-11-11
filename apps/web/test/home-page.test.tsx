import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_ONLY } from '@/lib/auth';
import { tradesHref } from '@/lib/trades-url';

// One collection with no analysis, its stored data 40% downloaded, and no pass ever reported: the worker is silent.
const demo = {
  id: 1, chainId: 1, address: '0x' + 'a'.repeat(40), name: 'Demo', transfers: 0, startBlock: null, cursorBlock: null, headBlock: null,
  wallets: 0, fundedWallets: 0, latest: null, error: null, pausedAt: null, priority: false, downloadFile: 'transfers', downloadProgress: 0.4,
};
const state = { host: 'example.com', rows: [demo] as Record<string, unknown>[] };
vi.mock('@/lib/store', () => ({
  store: () => ({
    collections: async () => state.rows,
    passes: async () => [],
    sources: async () => ({ 'rpc.1': { value: 'set', from: 'env' } }),
    settings: async () => new Map(),
  }),
  storedManifest: async () => null,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ host: state.host }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

afterEach(() => { cleanup(); state.host = 'example.com'; state.rows = [demo]; });

async function draw(params: Record<string, string> = {}) {
  const { default: Collections } = await import('@/app/page');
  return render(await Collections({ searchParams: Promise.resolve(params) })).container;
}
async function page(): Promise<string> {
  return (await draw()).textContent ?? '';
}

const totals = (sales: number, flagged: number, wei: string, flaggedWei: string, available = true) => ({
  transfers: sales, flagged, sales, flaggedSales: flagged, volumeWei: wei, flaggedVolumeWei: flaggedWei, wallets: 0, tokens: 0, available,
});
/** A collection whose Round trips flag `low` of 100 sales and whose Linked wallets flag `high`. */
function analysed(id: number, name: string, low: number, high: number, extra: Record<string, unknown> = {}) {
  const e = (n: number) => String(n * 10 ** 18);
  return {
    ...demo, id, name, address: '0x' + String(id).repeat(40), downloadProgress: null, transfers: 100, ...extra,
    latest: { ranAt: id * 1000, tookMs: 1, throughBlock: 1, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0, totals: {
      A: totals(100, low, e(100), e(low)), AU: totals(100, 0, e(100), '0'), AC: totals(100, high, e(100), e(high)),
    } },
  };
}
const hrefs = (c: Element) => [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));
const names = (c: Element) => [...c.querySelectorAll('li a.font-semibold')].map((a) => a.textContent);

describe('the collections page', () => {
  it('says once, above the Watch panel, that changes are only accepted from this machine', async () => {
    const text = await page();
    expect(text.split(LOCAL_ONLY).length - 1).toBe(1);
    expect(text.indexOf(LOCAL_ONLY)).toBeLessThan(text.indexOf('Watch a collection'));
  });

  it('says nothing of it to a request that may write', async () => {
    state.host = 'localhost:3000';
    expect(await page()).not.toContain(LOCAL_ONLY);
  });

  it('a collection with no analysis waits on the silent worker, not on its download', async () => {
    const text = await page();
    expect(text).toContain('Not analyzed yet · the worker is silent, so nothing is read or analyzed until it reports again.');
    expect(text).not.toContain('Downloading stored data');
  });

  it('find=ape keeps only the ape collection and counts it within the tab', async () => {
    state.rows = [analysed(1, 'Bored Ape Yacht Club', 10, 20), analysed(2, 'Doodles', 5, 6)];
    const c = await draw({ find: 'APE' });
    expect(names(c)).toEqual(['Bored Ape Yacht Club']);
    expect(c.textContent).toContain('1 of 2 collections in this tab matches “APE”');
    expect(c.querySelector('a[href="/"]')?.textContent).toBe('Clear');
  });

  it('find matches an address, and Clear keeps the tab, sort and direction', async () => {
    state.rows = [analysed(1, 'Bored Ape', 10, 20), analysed(2, 'Doodles', 5, 6)];
    const c = await draw({ find: '2222', tab: 'all', sort: 'name', dir: 'desc' });
    expect(names(c)).toEqual(['Doodles']);
    const clear = [...c.querySelectorAll('a')].find((a) => a.textContent === 'Clear');
    expect(clear?.getAttribute('href')).toBe('/?tab=all&sort=name&dir=desc');
  });

  it('sort=washed puts the higher share first, and the unanalysed one last in both directions', async () => {
    state.rows = [analysed(1, 'Low', 5, 10), { ...demo, id: 3, name: 'None', address: '0x' + '3'.repeat(40) }, analysed(2, 'High', 30, 40)];
    expect(names(await draw({ sort: 'washed' }))).toEqual(['High', 'Low', 'None']);
    cleanup();
    expect(names(await draw({ sort: 'washed', dir: 'asc' }))).toEqual(['Low', 'High', 'None']);
  });

  it('sort=volume orders by the flagged volume at the high end, as a BigInt', async () => {
    const big = analysed(1, 'Big', 1, 2);
    big.latest.totals.AC.flaggedVolumeWei = '1000000000000000000001';
    const small = analysed(2, 'Small', 1, 2);
    small.latest.totals.AC.flaggedVolumeWei = '1000000000000000000000';
    state.rows = [small, big];
    expect(names(await draw({ sort: 'volume' }))).toEqual(['Big', 'Small']);
  });

  it('with no sort the rows keep their order', async () => {
    state.rows = [analysed(1, 'Low', 5, 10), analysed(2, 'High', 30, 40)];
    expect(names(await draw())).toEqual(['Low', 'High']);
  });

  it('the low end of the sales range links to its lens evidence, and the high end to the other', async () => {
    state.rows = [analysed(1, 'Ape', 18, 25)];
    const c = await draw();
    const links = [...c.querySelectorAll('li a[href*="#evidence"]')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')]).slice(0, 2)).toEqual([
      ['18', `/c/1/0x${'1'.repeat(40)}/methods?method=A#evidence`],
      ['25%', `/c/1/0x${'1'.repeat(40)}/methods?method=AC#evidence`],
    ]);
    expect(links[0]!.className).toContain('relative z-10');
  });

  it('a range whose ends agree is one link', async () => {
    state.rows = [analysed(1, 'Ape', 20, 20)];
    const c = await draw();
    expect([...c.querySelectorAll('li a[href*="#evidence"]')].slice(0, 1).map((a) => a.textContent)).toEqual(['20%']);
    expect(c.querySelectorAll('li a[href*="#evidence"]').length).toBe(2); // one per measure
  });

  it('the row’s sales count opens the sales, above the row link; its transfer count is plain, as no list holds every transfer', async () => {
    state.rows = [analysed(1, 'Ape', 18, 25)];
    const c = await draw();
    const base = `/c/1/0x${'1'.repeat(40)}`;
    const sales = [...c.querySelectorAll('li a')].find((a) => a.textContent === '100 sales')!;
    expect(sales.getAttribute('href')).toBe(tradesHref(base, {}));
    expect(sales.className).toContain('relative z-10');
    expect(sales.parentElement!.textContent).toBe('100 sales among 100 transfers');
    expect([...c.querySelectorAll('li a')].some((a) => a.textContent === '100 transfers')).toBe(false);
    expect(c.querySelectorAll('a a').length).toBe(0);
  });

  it('opens the Watch panel for a not-watched collection\'s Watch it, and keeps it shut otherwise', async () => {
    state.rows = [analysed(1, 'Ape', 10, 20)];
    const panel = (c: Element) => [...c.querySelectorAll('details')].find((d) => d.textContent?.includes('Watch a collection'))!;
    expect(panel(await draw()).open).toBe(false);
    cleanup();
    expect(panel(await draw({ watch: `1:0x${'0'.repeat(39)}1` })).open).toBe(true);
    // And fills the form in for it; a bad value fills nothing.
    const field = (c: Element) => c.querySelector<HTMLInputElement>('input[name=address]')!;
    expect(field(document.body).value).toBe(`0x${'0'.repeat(39)}1`);
    cleanup();
    expect(field(await draw({ watch: '1:nope' })).value).toBe('');
  });

  it('a tab link keeps find, sort and dir', async () => {
    state.rows = [analysed(1, 'Ape', 10, 20)];
    const c = await draw({ find: 'ape', sort: 'name', dir: 'asc' });
    expect(hrefs(c)).toContain('/?tab=paused&find=ape&sort=name&dir=asc');
    expect(hrefs(c)).toContain('/?tab=all&find=ape&sort=name&dir=asc');
  });

  it('shows the current sort with an arrow, and the Find box keeps tab, sort and dir as hidden inputs', async () => {
    state.rows = [analysed(1, 'Ape', 10, 20)];
    const c = await draw({ sort: 'washed', tab: 'all' });
    expect(c.textContent).toContain('Sort by');
    // The arrow is the link's ::after, so the sort in force is read from aria-current and the arrow's class.
    const on = [...c.querySelectorAll('a[aria-current="true"]')];
    expect(on.map((a) => a.textContent)).toEqual(['washed', 'Sales that look washed']);
    expect(on.every((a) => a.className.includes("after:content-['▼']"))).toBe(true);
    const form = c.querySelector('form[method="get"]')!;
    expect([...form.querySelectorAll('input[type=hidden]')].map((i) => `${i.getAttribute('name')}=${i.getAttribute('value')}`)).toEqual(['tab=all', 'sort=washed']);
  });
});
