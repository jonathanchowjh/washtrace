import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@/components/sidebar';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }), usePathname: () => '/' }));

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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
