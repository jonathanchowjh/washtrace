import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addressOf } from '@/lib/params';
import { ETHERSCAN_CTA, ETHERSCAN_HREF, localTime, storedSizes } from '@/lib/format';
import { analysisWaitText } from '@/lib/coverage';
import { storedManifest } from '@/lib/store';
import { AddCollection, CollectionControls, SUGGESTED, Suggested, WatchPanel } from '@/components/watch';
import { LOCAL_ONLY } from '@/lib/auth';
import { CollectionRow } from '@/components/collection-row';
import { CollectionTabs } from '@/components/tabs';
import WorkerPage from '@/app/worker/page';

// The worker page reads its view from the store: give it one, with the request-scoped imports it awaits.
const view = vi.hoisted(() => ({ funding: null as null | { source: string; perSecond: number | null }, trailFunded: false, rpcChains: [1] as number[], jobs: [] as unknown[], backlog: [] as unknown[] }));
vi.mock('@/lib/views', () => ({
  workerView: async () => ({
    every: { ingest: 1, fund: 1, analyze: 1 }, rpcChains: view.rpcChains, funding: view.funding, followHops: null, trailFunded: view.trailFunded,
    passes: [], jobs: view.jobs, notices: [], backlog: view.backlog, collections: [],
  }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

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
    render(<Suggested writable watched={['1/0x4e1f41613c9084fdb9e34e11fae9412427480e56']} stored={[]} />);
    expect(screen.getByRole('link', { name: 'Watching →' }).getAttribute('href')).toBe('/c/1/0x4e1f41613c9084fdb9e34e11fae9412427480e56');
    expect(screen.getAllByRole('button', { name: 'Watch' })).toHaveLength(SUGGESTED.length - 1);
  });

  it('watches with one press, named, and refreshes', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ created: true }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    render(<Suggested writable watched={[]} stored={[]} />);
    const [first] = screen.getAllByRole('button', { name: 'Watch' });
    fireEvent.click(first!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ chainId: 1, address: SUGGESTED[0].address, name: SUGGESTED[0].name });
    expect(screen.getByRole('status').textContent).toBe('Dreadfulz: Watching. The worker reads it on its next pass.');
  });
});

describe('Suggested stored data', () => {
  const MEEBITS = SUGGESTED[3].address;
  const stored = [
    { chainId: 1, address: MEEBITS, name: 'Meebits', transfers: 12_300_000, trail: 3_400_000_000 },
    { chainId: 1, address: '0x1111111111111111111111111111111111111111', name: 'Extra', transfers: 5_000_000, trail: null },
  ];

  it('lists a manifest collection that is not suggested, with its size', () => {
    render(<Suggested writable watched={[]} stored={stored} />);
    expect(screen.getByText('Extra')).toBeTruthy();
    expect(screen.getByText('stored data: 5.0 MB transfers')).toBeTruthy();
    expect(screen.getByText('Its stored data is on Hugging Face.')).toBeTruthy();
    expect(screen.getByText('stored data: 12.3 MB transfers + 3.4 GB money trail')).toBeTruthy();
    // A suggested one keeps its paper line.
    expect(screen.getAllByText(/paper found/)).toHaveLength(SUGGESTED.length);
    expect(screen.getAllByRole('button', { name: 'Watch' })).toHaveLength(SUGGESTED.length + 1);
  });

  it('says the intro true for rows with and without manifest-only collections', () => {
    const paper = 'Suggested: collections from the term paper, each with a known answer to compare this reading against';
    const { container } = render(<Suggested writable watched={[]} stored={stored} />);
    expect(container.querySelector('p')!.textContent).toBe(`${paper}, and other collections whose stored data is on Hugging Face.`);
    for (const none of [[], null, [stored[0]!]]) {
      cleanup();
      const text = render(<Suggested writable watched={[]} stored={none} />).container.querySelector('p')!.textContent;
      expect(text).toBe(`${paper}.`);
    }
  });

  it('shows no size for a collection with no stored data, and says when none is checked yet', () => {
    const { container } = render(<Suggested writable watched={[]} stored={[]} />);
    expect(container.textContent).not.toContain('stored data:');
    cleanup();
    render(<Suggested writable watched={[]} stored={null} />);
    expect(screen.getAllByText('stored data: not known yet')).toHaveLength(SUGGESTED.length);
  });

  it('says not known yet, not "not checked", for a cached manifest that cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'washtrace-web-manifest-'));
    vi.stubEnv('WASHTRACE_STORED_DIR', dir);
    try {
      await writeFile(join(dir, 'manifest.json'), '{ not json');
      render(<Suggested writable watched={[]} stored={storedSizes(await storedManifest())} />);
      expect(screen.getAllByText('stored data: not known yet')).toHaveLength(SUGGESTED.length);
      expect(screen.queryByText(/not checked/)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shows the size of a typed collection that has stored data', () => {
    const { container } = render(<AddCollection writable stored={stored} />);
    const address = container.querySelector('input[name="address"]')!;
    fireEvent.change(address, { target: { value: MEEBITS.toUpperCase().replace('0X', '0x') } });
    expect(screen.getByText('stored data: 12.3 MB transfers + 3.4 GB money trail')).toBeTruthy();
    fireEvent.change(address, { target: { value: '0x2222222222222222222222222222222222222222' } });
    expect(container.textContent).not.toContain('stored data:');
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
    render(<CollectionControls writable chainId={1} address="0xabc" paused={false} priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/collections/1/0xabc/pause');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });

  it('offers no Delete while in sync', () => {
    render(<CollectionControls writable chainId={1} address="0xabc" paused={false} priority={false} />);
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Prioritize' })).toBeTruthy();
  });

  it('promises with Prioritize only what it does: checking wallets first', () => {
    render(<CollectionControls writable chainId={1} address="0xabc" paused={false} priority={false} />);
    expect(screen.getByRole('button', { name: 'Prioritize' }).getAttribute('title')).toBe("Check this collection's wallets for money before the other collections'");
  });

  it('sets priority through config', async () => {
    const fetch = ok();
    vi.stubGlobal('fetch', fetch);
    render(<CollectionControls writable chainId={1} address="0xabc" paused={false} priority />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop prioritizing' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/collections/1/0xabc/config');
    expect(JSON.parse(String(init.body))).toEqual({ priority: false });
  });

  it('resumes a paused collection', async () => {
    const fetch = ok({ paused: false });
    vi.stubGlobal('fetch', fetch);
    render(<CollectionControls writable chainId={1} address="0xabc" paused priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('/api/collections/1/0xabc/resume');
  });

  it('asks inline before deleting, and deletes on the second press only', async () => {
    const fetch = ok({ deleted: true });
    vi.stubGlobal('fetch', fetch);
    render(<CollectionControls writable chainId={1} address="0xabc" paused priority={false} />);
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
    render(<CollectionControls writable chainId={1} address="0xabc" paused priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: /Delete data/ })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says why when the service refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Pause this collection before deleting its data.' }), { status: 409 })));
    render(<CollectionControls writable chainId={1} address="0xabc" paused priority={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Pause this collection before deleting its data.'));
  });
});

describe('a refused write', () => {
  it('disables the controls with the refusal as their title', () => {
    render(<CollectionControls writable={false} chainId={1} address="0xabc" paused={false} priority={false} />);
    for (const name of ['Pause', 'Prioritize']) {
      const b = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe(LOCAL_ONLY);
    }
    cleanup();
    render(<CollectionControls writable={false} chainId={1} address="0xabc" paused priority={false} />);
    for (const name of ['Resume', 'Delete data…']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Watch on a suggestion and on the form', () => {
    render(<Suggested writable={false} watched={[]} stored={[]} />);
    for (const b of screen.getAllByRole('button', { name: 'Watch' })) expect((b as HTMLButtonElement).title).toBe(LOCAL_ONLY);
    expect(screen.getAllByRole('button', { name: 'Watch' }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    cleanup();
    render(<AddCollection writable={false} stored={[]} />);
    const submit = screen.getByRole('button', { name: 'Watch' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe(LOCAL_ONLY);
  });

  it('is passed on by a row, which does not say the sentence itself', () => {
    const { container } = render(<CollectionRow writable={false} c={{ id: 1, chainId: 1, address: '0xabc', name: 'Demo', transfers: 5, startBlock: 1, cursorBlock: 10, headBlock: 10, wallets: 0, fundedWallets: 0, latest: null, error: null, pausedAt: null, priority: false } as never} why="Waiting" rpcChains={new Set([1])} funding silent={false} now={0} />);
    expect((screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).not.toContain(LOCAL_ONLY);
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

  it('counts how many are without an RPC', () => {
    render(<CollectionTabs counts={{ ...counts, behind: 2 }} current="sync" />);
    expect(screen.getByRole('link', { name: 'In sync (3 · 2 without RPC)' })).toBeTruthy();
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
    render(<CollectionRow writable c={base} why="Waiting" rpcChains={ON} funding silent={false} now={0} />);
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

  it('says a missing RPC as No RPC, not a fault; a chain with an RPC keeps the fault line', () => {
    const err = 'No RPC is configured for chain 1.';
    const { container, unmount } = render(<CollectionRow writable c={{ ...base, error: err }} why="" rpcChains={new Set()} funding silent={false} now={0} />);
    expect(container.textContent).toContain('No RPC is set for Ethereum.');
    expect(container.textContent).not.toContain(err);
    expect(container.querySelector('.text-fault')).toBeNull();
    unmount();
    const live = render(<CollectionRow writable c={{ ...base, error: 'RPC timed out' }} why="" rpcChains={ON} funding silent={false} now={0} />).container;
    expect(live.querySelector('.text-fault')!.textContent).toContain('RPC timed out');
  });

  it('stays on the list after deleting, refreshing in place', async () => {
    vi.stubGlobal('fetch', ok({ deleted: true }));
    render(<CollectionRow writable c={{ ...base, pausedAt: 1 }} why="Paused" rpcChains={ON} funding silent={false} now={0} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });

  it('with no analysis and a download under way, a silent worker claims no progress beside its pill', () => {
    const c = { ...base, cursorBlock: null, startBlock: null, transfers: 0, downloadFile: 'transfers', downloadProgress: 0.4 } as typeof base;
    const { container } = render(<CollectionRow writable c={c} why={analysisWaitText(c, undefined, new Map(), ON, 0, 'UTC', true)} rpcChains={ON} funding silent now={0} />);
    expect(container.textContent).toContain('Not analyzed yet · the worker is silent, so nothing is read or analyzed until it reports again.');
    expect(container.textContent).not.toContain('Downloading stored data');
  });

  it('says it is loading stored data, with a bar of how far it has got', () => {
    const { container } = render(<CollectionRow writable c={{ ...base, cursorBlock: null, startBlock: null, restoreProgress: 0.42 } as typeof base} why="Waiting" rpcChains={ON} funding silent={false} now={0} />);
    expect(screen.getAllByText('Loading stored data · 42%').length).toBeGreaterThan(0);
    const bar = container.querySelector('[data-bar="restore"] i') as HTMLElement;
    expect(bar.style.width).toBe('42%');
  });

  it('shows stored data with no RPC as where it stops, never as a fault', () => {
    document.cookie = 'washtrace_tz=UTC; path=/';
    const c = { ...base, startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900, error: 'No RPC is configured for chain 1.' } as typeof base;
    const { container } = render(<CollectionRow writable c={c} why="Waiting" rpcChains={new Set()} funding silent={false} now={Date.UTC(2026, 9, 23)} />);
    // The pill stays short enough for its column; where the data stops goes on a muted line under it, drawn by Time.
    expect(screen.getByText('Stored data · 9 days unsynced')).toBeTruthy();
    expect(screen.getByText('stops').textContent).toBe(`stops ${localTime(Date.UTC(2026, 9, 14), 'date', 'UTC')}`);
    expect(container.textContent).not.toContain('No RPC');
    expect(container.querySelector('.text-fault')).toBeNull();
  });

  it('lets the Reading column shrink to its track, so the pill wraps inside it', () => {
    const { container } = render(<CollectionRow writable c={base} why="Waiting" rpcChains={ON} funding silent={false} now={0} />);
    const column = container.querySelector('li > div:last-child')!;
    expect(column.className).toContain('min-w-0');
  });

  it('says how far it was read under the pill once read past the stored data', () => {
    const c = { ...base, startBlock: 100, cursorBlock: 1_250_000, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900 } as typeof base;
    render(<CollectionRow writable c={c} why="Waiting" rpcChains={new Set()} funding silent={false} now={Date.UTC(2026, 9, 23)} />);
    expect(screen.getByText('No RPC for its chain')).toBeTruthy();
    expect(screen.getByText('read to block 1,250,000')).toBeTruthy();
  });

  it('says why stored data was not loaded as information, not a fault', () => {
    const note = 'Stored data could not be loaded: its file is missing.';
    const { container } = render(<CollectionRow writable c={{ ...base, restoreNote: note } as typeof base} why="Waiting" rpcChains={ON} funding silent={false} now={0} />);
    const line = [...container.querySelectorAll('p')].find((p) => p.textContent!.startsWith(note))!;
    expect(line.textContent).toBe(`${note} Reading from the chain instead; it is tried again when its stored file or its manifest entry changes.`);
    expect(line.className).not.toContain('text-fault');
  });

  it('never claims the chain is read when its chain has no RPC', () => {
    const note = 'Stored data could not be loaded: its file is missing.';
    const c = { ...base, cursorBlock: null, startBlock: null, headBlock: null, transfers: 0, restoreNote: note } as typeof base;
    const { container } = render(<CollectionRow writable c={c} why="Waiting" rpcChains={new Set()} funding silent={false} now={0} />);
    const line = [...container.querySelectorAll('p')].find((p) => p.textContent!.startsWith(note))!;
    expect(line.textContent).toBe(`${note} It is tried again when its stored file or its manifest entry changes.`);
  });

  const lens = (available: boolean, flaggedSales: number) => ({ available, transfers: 10, flagged: flaggedSales, sales: 10, flaggedSales, volumeWei: '10000000000000000000', flaggedVolumeWei: '1000000000000000000', wallets: 4, tokens: 2 });
  const analysed = (money: boolean) => ({ ranAt: 0, tookMs: 1, throughBlock: 10, missingData: 0, fundedWallets: 20, wallets: 80, truncatedSearches: 0, totals: { A: lens(true, 2), AU: lens(money, 3), AC: lens(money, 4) } });

  it('says money lenses are not final yet only while wallets are being checked', () => {
    const c = { ...base, wallets: 80, fundedWallets: 20, trailImportedSha: 'feed', latest: analysed(true) } as unknown as typeof base;
    const idle = render(<CollectionRow writable c={c} why="Waiting" rpcChains={ON} funding={false} silent={false} now={0} />).container;
    expect(idle.textContent).not.toContain('money lenses not final yet');
    expect(idle.textContent).not.toContain('Checking wallets');
    expect(idle.querySelector('.animate-pulse')).toBeNull();
    cleanup();
    const busy = render(<CollectionRow writable c={c} why="Waiting" rpcChains={ON} funding silent={false} now={0} />).container;
    expect(busy.textContent).toContain('money lenses not final yet');
    expect(busy.textContent).not.toMatch(/rise/);
  });

  it('says an analysed collection\'s latest analysis failed, and when it is tried again', () => {
    document.cookie = 'washtrace_tz=UTC; path=/';
    const at = 30 * 60_000;
    const c = { ...base, latest: analysed(true), stale: true, analysisError: 'out of memory', analysisRetryAt: at } as unknown as typeof base;
    const { container } = render(<CollectionRow writable c={c} why="Waiting" rpcChains={ON} funding silent={false} now={0} />);
    const line = [...container.querySelectorAll('p')].find((p) => p.textContent!.startsWith('Latest analysis failed'))!;
    expect(line.textContent).toBe(`Latest analysis failed: out of memory · tried again after ${localTime(at, 'time', 'UTC')}.`);
    expect(line.className).toContain('text-fault');
    cleanup();
    // Paused, nothing tries it: information from before the pause.
    const paused = render(<CollectionRow writable c={{ ...c, pausedAt: 1 }} why="Paused" rpcChains={ON} funding silent={false} now={0} />).container;
    const said = [...paused.querySelectorAll('p')].find((p) => p.textContent!.includes('analysis before the pause failed'))!;
    expect(said.className).not.toContain('text-fault');
  });

  it('names one lens once when it holds the only share', () => {
    const c = { ...base, latest: analysed(false) } as unknown as typeof base;
    const { container } = render(<CollectionRow writable c={c} why="Waiting" rpcChains={ON} funding silent={false} now={0} />);
    expect(container.textContent).not.toContain('Round trips → Round trips');
    expect(container.textContent).toContain('Round trips');
  });

  it('says the error of a paused collection as information, from before the pause', () => {
    const { container } = render(<CollectionRow writable c={{ ...base, pausedAt: 1, error: 'RPC timed out' } as typeof base} why="Paused" rpcChains={ON} funding silent={false} now={0} />);
    expect(container.textContent).toContain('Paused · last error before the pause: RPC timed out');
    expect(container.querySelector('.text-fault')).toBeNull();
  });

  it('a paused collection on a chain with no RPC says that, not its last error', () => {
    const { container } = render(<CollectionRow writable c={{ ...base, pausedAt: 1, error: 'No RPC is configured for chain 1.' } as typeof base} why="Paused" rpcChains={new Set()} funding silent={false} now={0} />);
    expect(container.textContent).toContain('Paused · no RPC is set for Ethereum.');
    expect(container.textContent).not.toContain('last error');
  });

  it('a silent worker makes a complete collection read silent, not up to date, and its dot is still', () => {
    const lens = { available: true, sales: 10, flaggedSales: 2, flaggedVolumeWei: '0', volumeWei: '0', tokens: 1, wallets: 1, transfers: 10, flagged: 2, owners: 10, flaggedOwners: 2 };
    const latest = { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: lens, AU: lens, AC: lens }, missingData: 0, fundedWallets: 4, wallets: 4, truncatedSearches: 0 };
    const c = { ...base, latest, wallets: 4, fundedWallets: 4 } as unknown as typeof base;
    const { container } = render(<CollectionRow writable c={c} why="" rpcChains={ON} funding silent now={0} />);
    expect(container.textContent).toContain('Worker silent · not kept current');
    expect(container.textContent).not.toContain('Up to date');
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('offers Resume and Delete data when paused', () => {
    render(<CollectionRow writable c={{ ...base, pausedAt: 1 }} why="Paused" rpcChains={ON} funding silent={false} now={0} />);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete data/ })).toBeTruthy();
  });
});

describe('the worker page\'s sources', () => {
  const funding = async (more: Partial<typeof view>) => {
    Object.assign(view, { funding: null, trailFunded: false }, more);
    return render(await WorkerPage()).container;
  };

  it('a missing Etherscan key reads as the key it needs, in the colour of the RPC line, never grey', async () => {
    for (const trailFunded of [false, true]) {
      const el = await funding({ trailFunded });
      const line = [...el.querySelectorAll('li')].find((li) => li.textContent!.includes('→ reading stage 5 (Money)'))!;
      expect(line.textContent).toContain('Needs a key:');
      expect(line.querySelector('.text-money')).not.toBeNull();
      expect(line.querySelector('.text-muted-foreground')?.textContent).toBe('→ reading stage 5 (Money)');
      const link = [...line.querySelectorAll('a')].find((a) => a.textContent === ETHERSCAN_CTA)!;
      expect(link.getAttribute('href')).toBe(ETHERSCAN_HREF);
      cleanup();
    }
  });
});

describe('the worker page\'s RPC line', () => {
  afterEach(() => { cleanup(); view.rpcChains = [1]; });

  it('says No RPC, never a key, when no chain has an RPC', async () => {
    view.rpcChains = [];
    const el = render(await WorkerPage()).container;
    const link = [...el.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/settings#rpc.1' && a.textContent!.startsWith('No RPC'))!;
    expect(link.textContent).toBe('No RPC. Add an RPC URL in Settings →');
  });
});

describe('the worker page\'s wallet count', () => {
  // Reset here, not on the test's last line, so a failure cannot leak the jobs into the next test.
  afterEach(() => { Object.assign(view, { jobs: [], backlog: [] }); });

  it('names the set it counts: every wallet on the chain', async () => {
    const job = { job: 'fund', state: 'ok', startedAt: null, finishedAt: null, tookMs: null, detail: null, outcome: null };
    Object.assign(view, { funding: null, trailFunded: false, jobs: [job], backlog: [{ chainId: 1, done: 3, pending: 2, failed: 0, stranded: 0, truncated: 0, followed: 1, etaMs: null }] });
    const text = render(await WorkerPage()).container.textContent!;
    expect(text).toContain('3 of 5 wallets on this chain checked');
  });

  it('counts depth in wallets out and says no hop, with funding on and wallets held back', async () => {
    const job = { job: 'fund', state: 'ok', startedAt: null, finishedAt: null, tookMs: null, detail: null, outcome: null };
    Object.assign(view, { funding: { source: 'etherscan', perSecond: null }, trailFunded: true, jobs: [job], backlog: [{ chainId: 1, done: 3, pending: 2, failed: 0, stranded: 4, truncated: 0, followed: 1, etaMs: 40 * 60_000 }] });
    const text = render(await WorkerPage()).container.textContent!;
    expect(text).toContain('following money 3 wallets out from traders');
    expect(text).toContain('about 40 min left');
    expect(text).not.toMatch(/\bhops?\b/i);
  });

  it('says how many wallets wait to be read again, only when some do', async () => {
    const job = { job: 'fund', state: 'ok', startedAt: null, finishedAt: null, tookMs: null, detail: null, outcome: null };
    const backlog = (stale: number) => [{ chainId: 1, done: 3, pending: 2, failed: 0, stranded: 0, stale, truncated: 0, followed: 1, etaMs: null }];
    Object.assign(view, { funding: null, trailFunded: false, jobs: [job], backlog: backlog(3) });
    expect(render(await WorkerPage()).container.textContent).toContain('1 followed from traders · 3 to read again');
    cleanup();
    Object.assign(view, { backlog: backlog(0) });
    expect(render(await WorkerPage()).container.textContent).not.toContain('to read again');
  });
});
