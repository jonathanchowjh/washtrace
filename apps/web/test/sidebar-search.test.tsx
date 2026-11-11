import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@/components/sidebar';
import type { Watched } from '@/lib/search';

const push = vi.fn();
const nav = { path: '/', search: '' };
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }), usePathname: () => nav.path, useSearchParams: () => new URLSearchParams(nav.search) }));

const ADDR = '0x' + 'a'.repeat(40);
const more = { collections: false, tokens: false, wallets: false, trades: false };
const hits = (over: Record<string, unknown>) => ({ collections: [], tokens: [], wallets: [], trades: [], more, ...over });
const terra = { chainId: 1, address: ADDR, name: 'Terraforms', symbol: 'TERRA', totals: null };
const watched: Watched = { chainId: 1, address: ADDR, name: 'Terraforms', range: null };

const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  fetchMock.mockReset();
  push.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); nav.path = '/'; nav.search = ''; });

const reply = (body: unknown) => ({ ok: true, json: async () => body });
const box = () => screen.getAllByRole('combobox')[0]!;
async function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
}

describe('the search box type-ahead', () => {
  it('is in both forms of the sidebar, each a combobox', () => {
    render(<Sidebar watched={[]} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(box().getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a collection 200 ms after the last key, under its kind', async () => {
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra] })));
    render(<Sidebar watched={[]} />);
    fireEvent.change(box(), { target: { value: 'te' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(199); });
    expect(fetchMock).not.toHaveBeenCalled();
    await type('ter');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/search?q=ter');
    expect(screen.getAllByRole('option')[0]!.textContent).toBe('TerraformsCollection on Ethereum · 0xaaaa…aaaa');
    expect(box().getAttribute('aria-expanded')).toBe('true');
  });

  it('leads a hit with what was searched for, in mono for an address, its kind and chain under it', async () => {
    fetchMock.mockResolvedValue(reply(hits({ wallets: [{ chainId: 1, address: ADDR, transfers: 3 }] })));
    render(<Sidebar watched={[]} />);
    await type('0xaaaa');
    const [lead, detail] = [...screen.getAllByRole('option')[0]!.children];
    expect([lead!.textContent, lead!.className.includes('font-mono')]).toEqual(['0xaaaa…aaaa', true]);
    expect(detail!.textContent).toBe('Wallet on Ethereum · in 3 transfers of watched collections');
  });

  it('does not fetch for what parseSearch calls empty', async () => {
    render(<Sidebar watched={[]} />);
    await type('t');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('moves with the arrows and opens the highlighted hit on Enter', async () => {
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra] })));
    render(<Sidebar watched={[]} />);
    await type('ter');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]!.id);
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false);
    expect(push).toHaveBeenCalledWith(`/c/1/${ADDR}`);
  });

  it('leaves Enter to the form when nothing is highlighted', async () => {
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra] })));
    render(<Sidebar watched={[]} />);
    await type('ter');
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it('drops the highlight on every change to the text, so Enter before the new reply cannot open a stale hit', async () => {
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra] })));
    render(<Sidebar watched={[]} />);
    await type('ter');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.change(box(), { target: { value: 'terx' } });
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra] })));
    render(<Sidebar watched={[]} />);
    await type('ter');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(box().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a hit on click', async () => {
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra] })));
    render(<Sidebar watched={[]} />);
    await type('ter');
    fireEvent.click(screen.getAllByRole('option')[0]!);
    expect(push).toHaveBeenCalledWith(`/c/1/${ADDR}`);
  });

  it('keeps the reply to the latest request when an older one answers late', async () => {
    let slow!: (v: unknown) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise((r) => { slow = r; }))
      .mockResolvedValueOnce(reply(hits({ collections: [terra] })));
    render(<Sidebar watched={[]} />);
    await type('te');
    await type('ter');
    await act(async () => { slow(reply(hits({ collections: [{ ...terra, name: 'Teddies' }] }))); });
    expect(screen.queryByText(/Teddies/)).toBeNull();
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('Terraforms');
  });

  it('shows 5 of a kind with 6 hits and says there is more', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ ...terra, address: '0x' + String(i).repeat(40), name: `Coll ${i}` }));
    fetchMock.mockResolvedValue(reply(hits({ collections: six })));
    render(<Sidebar watched={[]} />);
    await type('col');
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(screen.getByText('and more · press Enter to see all')).toBeTruthy();
  });

  it('says when nothing matches', async () => {
    fetchMock.mockResolvedValue(reply(hits({})));
    render(<Sidebar watched={[]} />);
    await type('zzz');
    expect(screen.getByText('No match. Press Enter to search everything.')).toBeTruthy();
  });

  it('says a query too short to be read as a token or the start of an address is too short, not a miss', async () => {
    fetchMock.mockResolvedValue(reply(hits({})));
    render(<Sidebar watched={[]} />);
    await type('0x18');
    expect(screen.getByText('Too short to search wallets and transactions: type at least 4 characters after 0x.')).toBeTruthy();
    await type('10');
    expect(screen.getByText('Too short for a token number: type 3 digits, or #10.')).toBeTruthy();
    expect(screen.queryByText(/No match/)).toBeNull();
  });
});

describe('the search box on the results page', () => {
  it('holds the search the page is for, follows it to the next, and asks nothing until it is used', async () => {
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra] })));
    nav.path = '/search';
    nav.search = 'q=terra&kind=collections';
    const { rerender } = render(<Sidebar watched={[]} />);
    expect(screen.getAllByRole('combobox').map((b) => (b as HTMLInputElement).value)).toEqual(['terra', 'terra']);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(fetchMock).not.toHaveBeenCalled();
    nav.search = 'q=0x1ee2';
    rerender(<Sidebar watched={[]} />);
    expect((box() as HTMLInputElement).value).toBe('0x1ee2');
    fireEvent.focus(box());
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/search?q=0x1ee2');
  });

  it('keeps what was typed on any other page', async () => {
    nav.search = 'q=terra';
    render(<Sidebar watched={[]} />);
    expect((box() as HTMLInputElement).value).toBe('');
  });
});

describe('the search box under a collection', () => {
  const under = () => { nav.path = `/c/1/${ADDR}/t/7`; render(<Sidebar watched={[watched]} />); };

  it('searches that collection: says so, and asks with its scope', async () => {
    fetchMock.mockResolvedValue(reply(hits({})));
    under();
    expect(box().getAttribute('placeholder')).toBe('Search Terraforms…  /');
    await type('#7');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/search?q=%237&scope=1:${ADDR}`);
    expect((document.querySelector('input[name=scope]') as HTMLInputElement).value).toBe(`1:${ADDR}`);
  });

  it('says a miss is in that collection, and that its chip, not Enter, widens the search', async () => {
    fetchMock.mockResolvedValue(reply(hits({})));
    under();
    await type('zzz');
    expect(screen.getByText('No match in Terraforms. Drop it with ✕ to search everything.')).toBeTruthy();
  });

  it('drops the scope from its chip, so the next search is of everything', async () => {
    fetchMock.mockResolvedValue(reply(hits({})));
    under();
    fireEvent.click(screen.getAllByRole('button', { name: /In Terraforms/ })[0]!);
    expect(box().getAttribute('placeholder')).toBe('Search everything…  /');
    await type('#7');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/search?q=%237');
  });

  it('opens a wallet it finds under the collection\'s tabs, and lists tokens first for a token number', async () => {
    const W = '0x' + 'b'.repeat(40);
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra], tokens: [{ chainId: 1, address: ADDR, name: 'Terraforms', tokenId: '777', transfers: 2 }], wallets: [{ chainId: 1, address: W, transfers: 3 }] })));
    under();
    await type('#777');
    const options = screen.getAllByRole('option');
    expect(options[0]!.textContent).toContain('Terraforms #777');
    fireEvent.click(options.find((o) => o.textContent?.includes('Wallet on'))!);
    expect(push).toHaveBeenCalledWith(`/c/1/${ADDR}/w/${W}`);
  });

  it('lists what its best match, a wallet, is connected to right under it, each opening there', async () => {
    const W = '0x' + 'b'.repeat(40), V = '0x' + 'b'.repeat(39) + 'c', RING = '0x' + '1'.repeat(40);
    fetchMock.mockResolvedValue(reply({
      ...hits({ wallets: [{ chainId: 1, address: W, transfers: 3 }, { chainId: 1, address: V, transfers: 1 }] }),
      connected: { wallet: W, rings: [{ anchor: RING, rank: 2 }], tokens: ['101'] },
    }));
    under();
    await type('0xbbbb');
    const lines = screen.getAllByRole('option').map((o) => o.textContent);
    expect(lines.slice(1, 3)).toEqual(['↳ Part of Ring 2', '↳ Traded token #101']);
    expect(lines[3]).toContain('Wallet');
    fireEvent.click(screen.getAllByRole('option')[1]!);
    expect(push).toHaveBeenCalledWith(`/c/1/${ADDR}/r/${RING}`);
  });
});

describe('the search box on a collection nobody watches', () => {
  it('searches everything: no scope in the placeholder, on a chip, or in the request', async () => {
    fetchMock.mockResolvedValue(reply(hits({})));
    const missing = '0x' + '0'.repeat(39) + '1';
    nav.path = `/c/1/${missing}`;
    render(<Sidebar watched={[watched]} />);
    expect(box().getAttribute('placeholder')).not.toContain('0x0000');
    expect(screen.queryByRole('button', { name: /^In / })).toBeNull();
    expect(document.querySelector('input[name=scope]')).toBeNull();
    await type('#7');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/search?q=%237');
  });
});

describe('the sidebar on a phone', () => {
  it('reads in order: the name first, then the search box, then the links, wrapping so none is past the edge', () => {
    render(<Sidebar watched={[watched]} />);
    const top = document.querySelector('a[href="/"]')!;
    expect(top.textContent).toBe('washtrace');
    expect(top.compareDocumentPosition(document.getElementById('q-top')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The phone's row of links wraps rather than scrolling, so Settings and the theme are never hidden off-screen.
    const row = document.querySelector('aside')!;
    expect(row.className).toContain('flex-wrap');
    expect(row.className.split(' ').filter((c) => c.includes('overflow-x'))).toEqual([]);
    for (const nav of row.querySelectorAll('nav')) expect(nav.className).toContain('flex-wrap');
    expect(document.querySelector('[data-more]')).toBeNull();
  });

  it('keeps the placeholder outside a collection short enough for the desktop box', () => {
    render(<Sidebar watched={[]} />);
    expect(box().getAttribute('placeholder')!.length).toBeLessThanOrEqual(24);
  });
});

describe('the / shortcut', () => {
  it('focuses the box on show, and leaves a key typed into a field alone', () => {
    render(<><input aria-label="other" /><Sidebar watched={[]} /></>);
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(box());
    const other = screen.getByLabelText('other');
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    expect(document.activeElement).toBe(other);
  });
});

describe('the sidebar\'s collections', () => {
  // A range's marks say its ends after the name.
  const link = () => screen.getByRole('link', { name: /^Terraforms/ });

  it('wear the marks of their range, floor then ceiling, and one mark when both ends are one lens', () => {
    const { rerender } = render(<Sidebar watched={[{ ...watched, range: { low: 'A', high: 'AC' } }]} />);
    expect([...link().querySelectorAll('i')].map((m) => m.className)).toEqual([expect.stringContaining('bg-cycle'), expect.stringContaining('repeating-linear-gradient')]);
    expect(link().querySelector('[title]')!.getAttribute('title')).toBe('Round trips → Linked wallets');
    // A screen reader hears the range once, as words, after the name: no trailing colon, no floor tied to the ceiling's name.
    expect(screen.getByRole('link', { name: 'Terraforms, Round trips to Linked wallets' })).toBe(link());
    rerender(<Sidebar watched={[{ ...watched, range: { low: 'A', high: 'A' } }]} />);
    expect(link().querySelectorAll('i')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Terraforms, Round trips' })).toBe(link());
    // Not read yet: no mark, which is never shown as clean.
    rerender(<Sidebar watched={[watched]} />);
    expect(link().querySelectorAll('i')).toHaveLength(0);
  });

  it('start with the collection symbol, and the name is still all the link says', () => {
    render(<Sidebar watched={[watched]} />);
    expect(link().querySelector('svg')).not.toBeNull();
    expect(link().textContent).toBe('Terraforms');
  });
});

describe('a wallet hit in a scope', () => {
  it('carries its tier\'s mark, said in words too, and no ring: ranking rings is not asked per keystroke', async () => {
    nav.path = `/c/1/${ADDR}`;
    fetchMock.mockResolvedValue(reply(hits({ wallets: [{ chainId: 1, address: ADDR, transfers: 3, here: true, tier: 'ceiling' }] })));
    render(<Sidebar watched={[watched]} />);
    await type('0xaaaa');
    const option = screen.getByRole('option');
    expect(option.querySelector('i')!.className).toContain('repeating-linear-gradient');
    expect(option.textContent).toContain('Linked wallets · the ceiling: ');
    expect(option.textContent).not.toContain('Ring');
  });
});
