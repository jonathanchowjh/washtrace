import { renderToString } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addressOf } from '@/lib/api';
import { localTime } from '@/lib/format';
import { CollectionControls, SUGGESTED, Suggested, WatchPanel } from '@/components/watch';
import { CollectionRow } from '@/components/collection-row';
import { CollectionTabs } from '@/components/tabs';

const refresh = vi.fn();
const push = vi.fn();
const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, replace }),
  useSearchParams: () => new URLSearchParams(search),
}));

// Node's own localStorage global shadows jsdom's here, so give the test a plain one.
beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    clear: () => kept.clear(),
  });
});

afterEach(() => {
  cleanup();
  search = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('SUGGESTED', () => {
  it('holds addresses as the store keeps them, so a watched one is found', () => {
    for (const s of SUGGESTED) expect(addressOf(s.address)).toBe(s.address);
  });
});

describe('Suggested', () => {
  it('links a watched suggestion to its page and offers the rest', () => {
    render(<Suggested watched={['1/0x4e1f41613c9084fdb9e34e11fae9412427480e56']} />);
    expect(screen.getByRole('link', { name: 'Watching →' }).getAttribute('href')).toBe('/c/1/0x4e1f41613c9084fdb9e34e11fae9412427480e56');
    expect(screen.getAllByRole('button', { name: 'Watch' })).toHaveLength(SUGGESTED.length - 1);
  });

  it('watches with one press, named, and refreshes', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ created: true }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    render(<Suggested watched={[]} />);
    const [first] = screen.getAllByRole('button', { name: 'Watch' });
    fireEvent.click(first!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ chainId: 1, address: SUGGESTED[0].address, name: SUGGESTED[0].name });
    expect(screen.getByRole('status').textContent).toBe('Dreadfulz: Watching. The worker reads it on its next pass.');
  });
});

describe('WatchPanel', () => {
  it('stays open when the refresh after a first watch would start it shut', () => {
    const { container, rerender } = render(<WatchPanel startOpen><summary>Watch</summary></WatchPanel>);
    rerender(<WatchPanel startOpen={false}><summary>Watch</summary></WatchPanel>);
    expect(container.querySelector('details')!.open).toBe(true);
  });
});

const ok = (body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe('CollectionControls', () => {
  it('pauses with a JSON body and refreshes', async () => {
    const fetch = ok({ paused: true });
    vi.stubGlobal('fetch', fetch);
    render(<CollectionControls chainId={1} address="0xabc" paused={false} priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/collections/1/0xabc/pause');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });

  it('offers no Delete while in sync', () => {
    render(<CollectionControls chainId={1} address="0xabc" paused={false} priority={false} />);
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Prioritize' })).toBeTruthy();
  });

  it('promises with Prioritize only what it does: checking wallets first', () => {
    render(<CollectionControls chainId={1} address="0xabc" paused={false} priority={false} />);
    expect(screen.getByRole('button', { name: 'Prioritize' }).getAttribute('title')).toBe("Check this collection's wallets for money before the others'");
  });

  it('sets priority through config', async () => {
    const fetch = ok();
    vi.stubGlobal('fetch', fetch);
    render(<CollectionControls chainId={1} address="0xabc" paused={false} priority />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop prioritizing' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/collections/1/0xabc/config');
    expect(JSON.parse(String(init.body))).toEqual({ priority: false });
  });

  it('resumes a paused collection', async () => {
    const fetch = ok({ paused: false });
    vi.stubGlobal('fetch', fetch);
    render(<CollectionControls chainId={1} address="0xabc" paused priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('/api/collections/1/0xabc/resume');
  });

  it('asks inline before deleting, and deletes on the second press only', async () => {
    const fetch = ok({ deleted: true });
    vi.stubGlobal('fetch', fetch);
    render(<CollectionControls chainId={1} address="0xabc" paused priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete its transfers and analyses\? Wallet funding is kept\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/collections/1/0xabc');
    expect(init.method).toBe('DELETE');
  });

  it('Keep cancels the confirmation', () => {
    const fetch = ok();
    vi.stubGlobal('fetch', fetch);
    render(<CollectionControls chainId={1} address="0xabc" paused priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: /Delete data/ })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says why when the service refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Pause this collection before deleting its data.' }), { status: 409 })));
    render(<CollectionControls chainId={1} address="0xabc" paused priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Pause this collection before deleting its data.'));
  });
});

describe('CollectionTabs', () => {
  const counts = { sync: 3, paused: 1, all: 4, behind: 0 };

  it('shows the counts and marks the current tab', () => {
    render(<CollectionTabs counts={counts} current="sync" />);
    expect(screen.getByRole('link', { name: 'In sync (3)' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Paused (1)' }).getAttribute('href')).toBe('/?tab=paused');
    expect(screen.getByRole('link', { name: 'All (4)' }).getAttribute('href')).toBe('/?tab=all');
  });

  it('counts how many are behind', () => {
    render(<CollectionTabs counts={{ ...counts, behind: 2 }} current="sync" />);
    expect(screen.getByRole('link', { name: 'In sync (3 · 2 behind)' })).toBeTruthy();
  });

  it('opens on the remembered tab when none is in the address', () => {
    localStorage.setItem('washtrace.collections.tab', 'paused');
    render(<CollectionTabs counts={counts} current="sync" />);
    expect(replace).toHaveBeenCalledWith('/?tab=paused');
  });

  it('does not redirect when the address names a tab, or nothing is remembered', () => {
    search = 'tab=all';
    localStorage.setItem('washtrace.collections.tab', 'paused');
    const { unmount } = render(<CollectionTabs counts={counts} current="all" />);
    unmount();
    search = '';
    localStorage.clear();
    render(<CollectionTabs counts={counts} current="sync" />);
    expect(replace).not.toHaveBeenCalled();
  });

  it('survives localStorage throwing', () => {
    localStorage.getItem = () => { throw new Error('blocked'); };
    localStorage.setItem = () => { throw new Error('blocked'); };
    render(<CollectionTabs counts={counts} current="sync" />);
    fireEvent.change(screen.getByLabelText('Open on'), { target: { value: 'all' } });
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows the remembered choice in Open on after mount', () => {
    search = 'tab=sync';
    localStorage.setItem('washtrace.collections.tab', 'all');
    render(<CollectionTabs counts={counts} current="sync" />);
    expect((screen.getByLabelText('Open on') as HTMLSelectElement).value).toBe('all');
  });

  it('renders the server markup with sync selected while storage holds another', () => {
    localStorage.setItem('washtrace.collections.tab', 'all');
    expect(renderToString(<CollectionTabs counts={counts} current="sync" />)).toMatch(/<option value="sync" selected/);
  });

  it('remembers the Open on choice', () => {
    render(<CollectionTabs counts={counts} current="sync" />);
    fireEvent.change(screen.getByLabelText('Open on'), { target: { value: 'all' } });
    expect(localStorage.getItem('washtrace.collections.tab')).toBe('all');
  });
});

describe('CollectionRow', () => {
  // Ethereum has an RPC unless a test says otherwise.
  const ON = new Set([1]);
  const base = { id: 1, chainId: 1, address: '0xabc', name: 'Demo', transfers: 5, startBlock: 1, cursorBlock: 10, headBlock: 10, wallets: 0, fundedWallets: 0, latest: null, error: null, pausedAt: null, priority: false } as unknown as Parameters<typeof CollectionRow>[0]['c'];

  it('offers Pause in sync, and a press posts without leaving the list', async () => {
    const fetch = ok({ paused: true });
    vi.stubGlobal('fetch', fetch);
    render(<CollectionRow c={base} why="Waiting" rpcChains={ON} funding now={0} />);
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('/api/collections/1/0xabc/pause');
    expect(push).not.toHaveBeenCalled();
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause.closest('a')).toBeNull();
    const wrapper = pause.closest('div.relative')!;
    expect(wrapper.classList.contains('z-10')).toBe(true);
  });

  it('stays on the list after deleting, refreshing in place', async () => {
    vi.stubGlobal('fetch', ok({ deleted: true }));
    render(<CollectionRow c={{ ...base, pausedAt: 1 }} why="Paused" rpcChains={ON} funding now={0} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });

  it('says it is loading stored data, with a bar of how far it has got', () => {
    const { container } = render(<CollectionRow c={{ ...base, cursorBlock: null, startBlock: null, restoreProgress: 0.42 } as typeof base} why="Waiting" rpcChains={ON} funding now={0} />);
    expect(screen.getAllByText('Loading stored data · 42%').length).toBeGreaterThan(0);
    const bar = container.querySelector('[data-bar="restore"] i') as HTMLElement;
    expect(bar.style.width).toBe('42%');
  });

  it('shows stored data with no RPC as where it stops, never as a fault', () => {
    document.cookie = 'washtrace_tz=UTC; path=/';
    const c = { ...base, startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900, error: 'No RPC is configured for chain 1.' } as typeof base;
    const { container } = render(<CollectionRow c={c} why="Waiting" rpcChains={new Set()} funding now={Date.UTC(2026, 9, 23)} />);
    // The pill stays short enough for its column; where the data stops goes on a muted line under it, drawn by Time.
    expect(screen.getByText('Stored data · 9 days unsynced')).toBeTruthy();
    expect(screen.getByText('stops').textContent).toBe(`stops ${localTime(Date.UTC(2026, 9, 14), 'date', 'UTC')}`);
    expect(container.textContent).not.toContain('No RPC');
    expect(container.querySelector('.text-fault')).toBeNull();
  });

  it('lets the How complete column shrink to its track, so the pill wraps inside it', () => {
    const { container } = render(<CollectionRow c={base} why="Waiting" rpcChains={ON} funding now={0} />);
    const column = container.querySelector('li > div:last-child')!;
    expect(column.className).toContain('min-w-0');
  });

  it('says how far it was read under the pill once read past the stored data', () => {
    const c = { ...base, startBlock: 100, cursorBlock: 1_250_000, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900 } as typeof base;
    render(<CollectionRow c={c} why="Waiting" rpcChains={new Set()} funding now={Date.UTC(2026, 9, 23)} />);
    expect(screen.getByText('No RPC for its chain')).toBeTruthy();
    expect(screen.getByText('read to block 1,250,000')).toBeTruthy();
  });

  it('says why stored data was not loaded as information, not a fault', () => {
    const note = 'Stored data could not be loaded (checksum differs); reading from the chain instead.';
    render(<CollectionRow c={{ ...base, restoreNote: note } as typeof base} why="Waiting" rpcChains={ON} funding now={0} />);
    expect(screen.getByText(note).className).not.toContain('text-fault');
  });

  const lens = (available: boolean, flaggedSales: number) => ({ available, transfers: 10, flagged: flaggedSales, sales: 10, flaggedSales, volumeWei: '10000000000000000000', flaggedVolumeWei: '1000000000000000000', wallets: 4, tokens: 2 });
  const analysed = (money: boolean) => ({ ranAt: 0, tookMs: 1, throughBlock: 10, missingData: 0, fundedWallets: 20, wallets: 80, truncatedSearches: 0, totals: { A: lens(true, 2), AU: lens(money, 3), AC: lens(money, 4) } });

  it('says money lenses can still rise only while wallets are being checked', () => {
    const c = { ...base, wallets: 80, fundedWallets: 20, trailImportedSha: 'feed', latest: analysed(true) } as unknown as typeof base;
    const idle = render(<CollectionRow c={c} why="Waiting" rpcChains={ON} funding={false} now={0} />).container;
    expect(idle.textContent).not.toContain('money lenses can still rise');
    expect(idle.textContent).not.toContain('Checking wallets');
    expect(idle.querySelector('.animate-pulse')).toBeNull();
    cleanup();
    const busy = render(<CollectionRow c={c} why="Waiting" rpcChains={ON} funding now={0} />).container;
    expect(busy.textContent).toContain('money lenses can still rise');
  });

  it('names one lens once when it holds the only share', () => {
    const c = { ...base, latest: analysed(false) } as unknown as typeof base;
    const { container } = render(<CollectionRow c={c} why="Waiting" rpcChains={ON} funding now={0} />);
    expect(container.textContent).not.toContain('Round trips → Round trips');
    expect(container.textContent).toContain('Round trips');
  });

  it('says the error of a paused collection as information, from before the pause', () => {
    const { container } = render(<CollectionRow c={{ ...base, pausedAt: 1, error: 'RPC timed out' } as typeof base} why="Paused" rpcChains={ON} funding now={0} />);
    expect(container.textContent).toContain('Paused · last error before the pause: RPC timed out');
    expect(container.querySelector('.text-fault')).toBeNull();
  });

  it('offers Resume and Delete data when paused', () => {
    render(<CollectionRow c={{ ...base, pausedAt: 1 }} why="Paused" rpcChains={ON} funding now={0} />);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete data/ })).toBeTruthy();
  });
});
