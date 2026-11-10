import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@/components/sidebar';

const push = vi.fn();
const nav = { path: '/' };
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }), usePathname: () => nav.path }));

const ADDR = '0x' + 'a'.repeat(40);
const more = { collections: false, tokens: false, wallets: false, trades: false };
const hits = (over: Record<string, unknown>) => ({ collections: [], tokens: [], wallets: [], trades: [], more, ...over });
const terra = { chainId: 1, address: ADDR, name: 'Terraforms', symbol: 'TERRA' };

const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  fetchMock.mockReset();
  push.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); nav.path = '/'; });

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
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('Collection on Ethereum · Terraforms');
    expect(box().getAttribute('aria-expanded')).toBe('true');
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
});

describe('the search box under a collection', () => {
  const under = () => { nav.path = `/c/1/${ADDR}/t/7`; render(<Sidebar watched={[terra]} />); };

  it('searches that collection: says so, and asks with its scope', async () => {
    fetchMock.mockResolvedValue(reply(hits({})));
    under();
    expect(box().getAttribute('placeholder')).toBe('Search Terraforms…  /');
    await type('#7');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/search?q=%237&scope=1:${ADDR}`);
    expect((document.querySelector('input[name=scope]') as HTMLInputElement).value).toBe(`1:${ADDR}`);
  });

  it('drops the scope from its chip, so the next search is of everything', async () => {
    fetchMock.mockResolvedValue(reply(hits({})));
    under();
    fireEvent.click(screen.getAllByRole('button', { name: /In Terraforms/ })[0]!);
    expect(box().getAttribute('placeholder')).toBe('Search name, #token, address or tx  /');
    await type('#7');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/search?q=%237');
  });

  it('opens a wallet it finds under the collection\'s tabs, and lists tokens first for a token number', async () => {
    const W = '0x' + 'b'.repeat(40);
    fetchMock.mockResolvedValue(reply(hits({ collections: [terra], tokens: [{ chainId: 1, address: ADDR, name: 'Terraforms', tokenId: '777', transfers: 2 }], wallets: [{ chainId: 1, address: W, transfers: 3 }] })));
    under();
    await type('#777');
    const options = screen.getAllByRole('option');
    expect(options[0]!.textContent).toContain('Token #777');
    fireEvent.click(options.find((o) => o.textContent?.startsWith('Wallet'))!);
    expect(push).toHaveBeenCalledWith(`/c/1/${ADDR}/w/${W}`);
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
