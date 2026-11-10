import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';
import { LOCAL_ONLY } from '@/lib/auth';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;

/** DEFAULT_RULE, needing money read this many hops out from the traders (depthNeeded). */
const needing = (depth: number) => { const r = structuredClone(DEFAULT_RULE); r.hops = { min: 1, max: depth + 1 }; return r; };

const refresh = vi.fn();

const FLAGGED = { A: 41, AU: 98, AC: 172 } as const;
const totals = (flaggedSales: number, over: Record<string, unknown> = {}) => ({
  transfers: 5000, flagged: 400, sales: 1000, flaggedSales, volumeWei: String(19_032n * 10n ** 18n),
  flaggedVolumeWei: String(BigInt(flaggedSales) * 20n * 10n ** 18n), wallets: 1207, tokens: 644, available: true, truncated: 0, untimed: 0, ...over,
});

type Status = 'queued' | 'running' | 'done' | 'failed';
/** A saved lens of yours (Blur 3-hop, L7, version 2) and its run on this collection, from that version on the latest analysis (1); null: it has none here. */
const run = (status: Status | null, over: Record<string, unknown> = {}, lens: Record<string, unknown> = {}) => ({
  lens: { id: 7, key: 'L7', name: 'Blur 3-hop', rule: DEFAULT_RULE, version: 2, createdAt: 0, updatedAt: 0, ...lens },
  run: status === null ? null : {
    lensId: 7, collectionId: 1, status, progress: null, lensVersion: 2, analysisId: 1, throughBlock: 10,
    totals: status === 'done' ? totals(126) : null, error: null, retryAt: null, finishedAt: 1, tookMs: 1, ...over,
  },
});

/** What is read of the collection's money (Store.moneyRead): the global limit is 3, the default follow.hops. */
const READ = { traders: { checked: 37, of: 37 }, limit: 3, ownLimit: null as number | null, pendingByDepth: {} as Record<number, number>, estimate: null, seeding: false };
/** What is read of the collection's other tokens (Store.tokenCounts), and whether Start reading was pressed. */
const COUNTED = { wallets: 40, read: 40, truncated: 0, failed: 0, moneyFailed: 0, settled: true, payees: false, at: '2026-11-09T00:00:00.000Z' };
const state = { keyed: false, checked: 37, started: false, counts: null as typeof COUNTED | null, payees: false, money: { ...READ }, runs: [] as ReturnType<typeof run>[], analysed: true, remote: false, notFunded: false, paused: false, points: [] as object[], off: [] as string[] };

const TX = '0x' + 'e'.repeat(64);
const WHO = '0x' + '1'.repeat(40);
/** A sale of token 7 in this collection, for the trade page's render. */
const sale = {
  txHash: TX, logIndex: 0, blockNumber: 5, blockTime: 1_700_000_060, tokenId: '7', from: WHO, to: '0x' + '2'.repeat(40), marketplace: 'Seaport', priceWei: null, currency: '', flags: {},
  collection: { chainId: 1, address: ADDR, name: 'Coll' },
};

const collection = () => ({
  id: 1, chainId: 1, address: ADDR, name: 'Coll', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 5000, wallets: 37, fundedWallets: state.checked,
  error: null, stale: false, pausedAt: state.paused ? 1_700_000_000_000 : null, priority: false, trailProgress: null, analysisError: null, storedThroughTime: null, storedThroughBlock: null,
  downloadFile: null, downloadProgress: null, downloadNote: null, restoreProgress: null, restoreNote: null, trailNote: null, trailImportedSha: state.notFunded ? null : 'feed',
  rules: {}, readTokens: state.started, contract: null, addedAt: 0, ingestedAt: 0, servedAt: 0, readRate: null,
  latest: state.analysed ? {
    id: 1, ranAt: 1_700_000_000_000, tookMs: 5, throughBlock: 10, missingData: 0, fundedWallets: 37, wallets: 37, truncatedSearches: 0, loops: null,
    totals: Object.fromEntries((['A', 'AU', 'AC'] as const).map((m) => [m, totals(FLAGGED[m], { available: !state.off.includes(m) })])),
  } : null,
});

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => collection(),
    lensRuns: async () => state.runs,
    moneyRead: async () => state.money,
    tokenCounts: async () => state.counts,
    history: async () => [],
    timeline: async () => ({ bucket: 'day', untimed: 0, readThrough: null, points: state.points }),
    compare: async () => ({ both: {}, not: {} }),
    transaction: async () => [sale],
    token: async () => [sale],
    flowsAmong: async () => [],
    lensFlagsOfTx: async () => [],
    lensFlagsOfToken: async () => [],
    profile: async () => ({ supply: 644, holders: 300, firstMint: null, firstSale: null, lastSale: null, marketplaces: [] }),
    passes: async () => [],
    collections: async () => [],
    sources: async () => ({ ...(state.keyed ? { 'etherscan.key': { source: 'env', value: null } } : {}), ...(state.payees ? { 'tokens.payees': { source: 'env', value: 'on' } } : {}) }),
    settings: async () => new Map(),
    importedMoney: async () => !state.notFunded,
    lensTokens: async () => ({ rows: [], total: 0 }),
    lensWallets: async () => ({ rows: [], total: 0 }),
  }),
  storedEntry: async () => null,
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ host: state.remote ? 'example.com' : 'localhost:3000' }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ push: vi.fn(), refresh }) }));

afterEach(() => {
  cleanup(); refresh.mockClear(); vi.unstubAllGlobals();
  Object.assign(state, { keyed: false, checked: 37, started: false, counts: null, payees: false, money: { ...READ }, runs: [], analysed: true, remote: false, notFunded: false, paused: false, points: [], off: [] });
});

async function draw(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: Page } = await import('@/app/c/[chain]/[address]/methods/page');
  return render(await Page({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
const strip = (c: Element) => c.querySelector('nav[aria-label="Lens"]')!;
const tabs = (c: Element) => [...strip(c).children].map((t) => t.textContent!.replace(/\s+/g, ' ').trim());
const panel = (c: Element) => c.querySelector('[data-lens-panel]')!;
const button = (c: Element, text: string) => [...c.querySelectorAll('button')].find((b) => b.textContent === text);
const anchor = (c: Element, text: string) => [...c.querySelectorAll('a')].find((a) => a.textContent === text);
/** Every text, aria-label and title on the page: no lens key may show in any of them. */
const reads = (c: Element) => [c.textContent, ...[...c.querySelectorAll('[aria-label],[title]')].flatMap((e) => [e.getAttribute('aria-label'), e.getAttribute('title')])].join('\n');

describe('the tab strip', () => {
  it('lists the built-ins and yours by name with their shares, and then + New lens and Compare', async () => {
    state.runs = [run('done')];
    expect(tabs(await draw())).toEqual(['Round trips 4.1% the floor', 'Linked wallets 17.2% the ceiling', 'Money loops back 9.8% not counted', 'Blur 3-hop 12.6%', '+ New lens', 'Compare']);
  });

  it('says each built-in\'s standing under its name, why not counted on hover, and nothing under yours', async () => {
    state.runs = [run('done')];
    const nav = strip(await draw());
    const under = (name: string) => [...nav.querySelectorAll('a')].find((a) => a.textContent!.startsWith(name))!.querySelector('span.block');
    expect(under('Round trips')?.textContent).toBe('the floor');
    expect(under('Linked wallets')?.textContent).toBe('the ceiling');
    expect(under('Money loops back')?.textContent).toBe('not counted');
    expect(under('Money loops back')?.getAttribute('title')).toMatch(/^On real data it flags/);
    expect(under('Blur 3-hop')).toBeNull();
  });

  it('marks the chosen tab and opens yours by its key', async () => {
    state.runs = [run('done')];
    const c = await draw({ method: 'L7' });
    const on = strip(c).querySelector('[aria-current="page"]')!;
    expect(on.textContent).toContain('Blur 3-hop');
    expect(on.getAttribute('href')).toBe(`${BASE}/methods?method=L7`);
  });

  it('draws yours as a diamond in the own hue and Money loops back as a dashed grey ring', async () => {
    state.runs = [run('done')];
    const dots = [...strip(await draw()).querySelectorAll('i')].map((i) => i.className);
    expect(dots.some((d) => d.includes('bg-flow') && d.includes('rotate-45'))).toBe(true);
    expect(dots.some((d) => d.includes('border-dashed') && d.includes('border-muted-foreground'))).toBe(true);
  });

  it('falls back to Linked wallets for an unknown or deleted lens', async () => {
    state.runs = [run('done')];
    const on = strip(await draw({ method: 'L99' })).querySelector('[aria-current="page"]')!;
    expect(on.textContent).toContain('Linked wallets');
  });

  it('says where each run stands on its tab, in short labels from the same states as every page\'s sentences', async () => {
    const tab = async (r: ReturnType<typeof run>) => { state.runs = [r]; const t = tabs(await draw())[3]!; cleanup(); return t; };
    expect(await tab(run(null))).toBe('Blur 3-hop not run');
    expect(await tab(run('queued'))).toBe('Blur 3-hop first run queued');
    expect(await tab(run('failed', { error: 'out of memory' }))).toBe('Blur 3-hop last run failed');
  });

  it('shows a running first run\'s progress on its tab, as before', async () => {
    state.runs = [run('running', { progress: 0.4 })];
    expect(tabs(await draw())[3]).toBe('Blur 3-hop first run 40%');
  });

  it('says a run with figures that is queued, running, failed or from before the latest edit, and says nothing of a current one', async () => {
    const withFigures = (status: Status, over: Record<string, unknown> = {}) => ({ ...run('done', { status, ...over }) });
    const tab = async (r: ReturnType<typeof run>) => { state.runs = [r]; const t = tabs(await draw())[3]!; cleanup(); return t; };
    expect(await tab(withFigures('done'))).toBe('Blur 3-hop 12.6%');
    expect(await tab(withFigures('queued'))).toBe('Blur 3-hop 12.6% newer run queued');
    expect(await tab(withFigures('running', { progress: 0.4 }))).toBe('Blur 3-hop 12.6% newer run 40%');
    expect(await tab(withFigures('failed'))).toBe('Blur 3-hop 12.6% last run failed');
    expect(await tab(withFigures('done', { lensVersion: 1 }))).toBe('Blur 3-hop 12.6% before edit');
    expect(await tab(withFigures('queued', { lensVersion: 1 }))).toBe('Blur 3-hop 12.6% before edit · queued');
  });

  it('a built-in the latest analysis did not run reads as not run, in the same words', async () => {
    state.off = ['AU'];
    expect(tabs(await draw())[2]).toBe('Money loops back not run not counted');
  });

  it('shows the tabs before the first analysis, with yours waiting on it', async () => {
    state.analysed = false;
    state.runs = [run('queued', { analysisId: null })];
    const c = await draw({ method: 'L7' });
    expect(tabs(c)).toContain('Blur 3-hop first run queued');
    expect(panel(c).textContent).toContain("Blur 3-hop has no figures yet: its first run has not finished. It waits for this collection's first analysis.");
  });
});

describe("a built-in's panel", () => {
  it('says it is built in and read-only, what it means, and offers a copy', async () => {
    const p = panel(await draw({ method: 'A' }));
    expect(p.textContent).toContain('built in · read-only');
    expect(p.textContent).toContain('The token keeps coming back to wallets that already held it.');
    expect(anchor(p, 'Copy to new lens')?.getAttribute('href')).toBe(`${BASE}/methods?method=A&lens=copy-A`);
    expect(anchor(p, 'Edit')).toBeUndefined();
    expect(button(p, 'Delete')).toBeUndefined();
    expect(button(p, 'Run here')).toBeUndefined();
  });

  it('holds its rule read-only, every control disabled', async () => {
    const d = panel(await draw({ method: 'A' })).querySelector('details')!;
    expect(d.querySelector('summary')!.textContent).toBe('Its rule, read-only: NFT only, follows arrows, same token, any length, repeats count each');
    // Advanced only shows or hides, so it stays usable; the rule's controls are all disabled.
    const controls = [...d.querySelectorAll('input,select,button,textarea')].filter((x) => x.getAttribute('aria-expanded') === null);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((x) => (x as HTMLInputElement).disabled)).toBe(true);
    expect(d.textContent).toContain('NFT: same token');
    expect(d.textContent).not.toContain('Not in this version');
    // Built-in A differs from the default in fields Advanced hides, so it shows them open.
    expect(within(d).getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(d).getByText('Order in time')).toBeTruthy();
  });

  it('keeps Money loops back not counted in its stat line', async () => {
    expect((await draw({ method: 'AU' })).querySelector('[aria-label="Money loops back in numbers"]')!.textContent).toContain('(not counted)');
  });

  it('copies the built-in being shown', async () => {
    expect(anchor(panel(await draw({ method: 'AU' })), 'Copy to new lens')?.getAttribute('href')).toBe(`${BASE}/methods?method=AU&lens=copy-AU`);
  });
});

describe("your lens's panel", () => {
  it('says it is yours, with Edit and Delete, the stat line without loops, and no copy link', async () => {
    state.runs = [run('done')];
    const c = await draw({ method: 'L7' });
    const p = panel(c);
    expect(p.textContent).toContain('yours');
    expect(p.textContent).not.toContain('built in');
    expect(anchor(p, 'Edit')?.getAttribute('href')).toBe(`${BASE}/methods?method=L7&lens=edit-L7`);
    expect(button(p, 'Delete')).toBeDefined();
    expect(anchor(p, 'Copy to new lens')).toBeUndefined();
    const stats = c.querySelector('[aria-label="Blur 3-hop in numbers"]')!;
    expect(stats.textContent).toContain('12.6% of sales');
    expect(stats.textContent).not.toContain('loop');
    expect(stats.textContent).not.toContain('not counted');
    expect(c.querySelector('[aria-label="Tokens Blur 3-hop flagged"]')).not.toBeNull();
    expect(c.querySelector('[aria-label="Wallets Blur 3-hop flagged"]')).not.toBeNull();
  });

  it('reads at least when a money row is on and the money data is not final', async () => {
    state.runs = [run('done')];
    state.notFunded = true;
    const c = await draw({ method: 'L7' });
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).toContain('at least 12.6% of sales');
    expect(tabs(c)[3]).toBe('Blur 3-hop at least 12.6%');
    // Its panel says why, in the words the chart's (at least) title uses (shareCauses).
    expect(panel(c).textContent).toContain('Its share is at least this, because no funding source is set, so money is not fully read.');
  });

  it('reads at least on a stored trail with no key, as nothing reads the wallets it left unchecked; so far with a key', async () => {
    state.runs = [run('done')];
    state.checked = 30;
    const c = await draw({ method: 'L7' });
    expect(tabs(c).slice(0, 4)).toEqual(['Round trips 4.1% the floor', 'Linked wallets at least 17.2% the ceiling', 'Money loops back at least 9.8% not counted', 'Blur 3-hop at least 12.6%']);
    expect(panel(c).textContent).toContain('Its share is at least this, because money past the stored trail is not read without an Etherscan key.');
    cleanup();
    state.keyed = true;
    const keyed = await draw({ method: 'L7' });
    expect(tabs(keyed).slice(0, 4)).toEqual(['Round trips 4.1% the floor', 'Linked wallets 17.2% so far the ceiling', 'Money loops back 9.8% so far not counted', 'Blur 3-hop 12.6% so far']);
    expect(panel(keyed).textContent).toContain('Its share can still rise while reads finish: money is not fully read yet.');
  });

  it('does not say at least for an NFT-only lens whose money data is not final', async () => {
    const rule = structuredClone(DEFAULT_RULE);
    for (const k of ['eth', 'internal', 'weth'] as const) rule.edges[k].use = false;
    state.runs = [run('done', {}, { rule })];
    state.notFunded = true;
    expect((await draw({ method: 'L7' })).querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).not.toContain('at least');
  });

  it('says how many searches stopped at the cap, and that the share is at least this, in shareCauses\'s words', async () => {
    state.runs = [run('done', { totals: totals(126, { truncated: 3 }) })];
    const c = await draw({ method: 'L7' });
    expect(panel(c).textContent).toContain('Its share is at least this, because some of its searches stopped at the cap before finding a loop (3 searches).');
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).toContain('at least 12.6%');
  });

  it('leads its lists with the same share as its tab, at least included and to a tenth', async () => {
    state.runs = [run('done')];
    expect(panel(await draw({ method: 'L7' })).textContent).toContain('What Blur 3-hop flags most: its 12.6% of sales, token by token and wallet by wallet.');
    cleanup();
    state.runs = [run('done', { totals: totals(126, { truncated: 3 }) })];
    expect(panel(await draw({ method: 'L7' })).textContent).toContain('What Blur 3-hop flags most: at least 12.6% of sales, token by token and wallet by wallet.');
    cleanup();
    // A built-in's lead is as it was: pct, which drops the decimal at 10% and above.
    expect(panel(await draw({ method: 'AC' })).textContent).toContain('What Linked wallets flags most: its 17% of sales, token by token and wallet by wallet.');
  });

  it("promises a lens of yours what a built-in's panel does, with its own name", async () => {
    state.runs = [run('done')];
    const yours = panel(await draw({ method: 'L7' })).textContent;
    expect(yours).toContain('token by token and wallet by wallet. Open a token to see why each trade was flagged.');
    expect(yours).not.toContain('the trades this lens flagged there');
    cleanup();
    expect(panel(await draw({ method: 'AC' })).textContent).toContain('token by token and wallet by wallet. Open a token to see why each trade was flagged.');
  });

  it('reads at least when some trades had no block time for its window, and says how many', async () => {
    state.runs = [run('done', { totals: totals(126, { untimed: 2 }) })];
    const c = await draw({ method: 'L7' });
    expect(panel(c).textContent).toContain('Its share is at least this, because some trades have no block time to judge them by (2 trades).');
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).toContain('at least 12.6% of sales');
    expect(tabs(c)[3]).toBe('Blur 3-hop at least 12.6%');
    cleanup();
    state.runs = [run('done', { totals: totals(126, { truncated: 3, untimed: 1 }) })];
    expect(panel(await draw({ method: 'L7' })).textContent).toContain('Its share is at least this, because some of its searches stopped at the cap before finding a loop (3 searches); some trades have no block time to judge them by (1 trade).');
  });

  it('says its rule in words under its name', async () => {
    state.runs = [run('done')];
    expect(panel(await draw({ method: 'L7' })).textContent).toContain('NFT and money');
  });
});

describe('every state of your lens', () => {
  const lineOf = async (status: Status | null, over: Record<string, unknown> = {}) => {
    state.runs = [run(status, over)];
    return draw({ method: 'L7' });
  };

  it('not run here: says so in the one sentence every page uses, and offers Run here', async () => {
    const c = await lineOf(null);
    expect(panel(c).textContent).toContain('Blur 3-hop has not run on this collection, so it flags nothing yet.');
    expect(button(panel(c), 'Run here')).toBeDefined();
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')).toBeNull();
    expect(c.querySelector('[aria-label="Tokens Blur 3-hop flagged"]')).toBeNull();
  });

  const FIRST = 'Blur 3-hop has no figures yet: its first run has not finished.';

  it('queued: says its first run has not finished, then that the worker runs it next, with no Run here', async () => {
    const c = await lineOf('queued');
    expect(panel(c).textContent).toContain(`${FIRST} The worker runs it next.`);
    expect(button(panel(c), 'Run here')).toBeUndefined();
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')).toBeNull();
  });

  it('queued on a paused collection: says it waits for the collection to be resumed', async () => {
    state.paused = true;
    const c = await lineOf('queued');
    expect(panel(c).textContent).toContain(`${FIRST} It waits for this collection to be resumed.`);
    expect(panel(c).textContent).not.toContain('The worker runs it next');
  });

  it('queued before any analysis: waits for the first analysis', async () => {
    state.analysed = false;
    const c = await lineOf('queued', { analysisId: null });
    expect(panel(c).textContent).toContain(`${FIRST} It waits for this collection's first analysis.`);
    expect(panel(c).textContent).not.toContain('The worker runs it next');
  });

  it('running: shows its progress, and never offers Run here (it would queue the run again)', async () => {
    const c = await lineOf('running', { progress: 0.4 });
    expect(panel(c).textContent).toContain(`${FIRST} It is 40% done.`);
    expect(button(panel(c), 'Run here')).toBeUndefined();
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')).toBeNull();
  });

  it('running with no progress yet says only that its first run has not finished', async () => {
    const t = panel(await lineOf('running')).textContent!;
    expect(t).toContain(FIRST);
    expect(t).not.toContain('done.');
  });

  it('failed: says the error and when it is tried again, and offers Run here to try now', async () => {
    const c = await lineOf('failed', { error: 'out of memory', retryAt: 1_700_000_000 });
    expect(panel(c).textContent).toMatch(/Blur 3-hop has no figures: its last run failed\. The error: out of memory\. It is tried again .+\./);
    expect(panel(c).querySelector('time')).not.toBeNull();
    expect(button(panel(c), 'Run here')).toBeDefined();
  });

  it('failed with no retry planned says it waits for Run here or an edit, and offers Run here', async () => {
    const c = await lineOf('failed', { error: 'out of memory' });
    const t = panel(c).textContent!;
    expect(t).toContain('Blur 3-hop has no figures: its last run failed. The error: out of memory. It is not tried again until you run it here or edit it.');
    expect(t).not.toContain('It is tried again');
    expect(button(panel(c), 'Run here')).toBeDefined();
  });

  it('done: shows its figures and no state line', async () => {
    const c = await lineOf('done');
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')).not.toBeNull();
    expect(panel(c).textContent).not.toContain('Blur 3-hop shows');
    expect(panel(c).textContent).not.toContain('newer run');
    expect(button(panel(c), 'Run here')).toBeUndefined();
  });

  it('stale after an edit: keeps the last run on show, says it is from before the edit, and that a newer run is queued', async () => {
    const c = await lineOf('queued', { totals: totals(126), lensVersion: 1 });
    expect(panel(c).textContent).toContain('Blur 3-hop shows figures from before its latest edit, and a newer run is queued.');
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).toContain('12.6% of sales');
    expect(button(panel(c), 'Run here')).toBeUndefined();
    expect(tabs(c)[3]).toBe('Blur 3-hop 12.6% before edit · queued');
  });

  it('stale after an edit, on a paused collection: the newer run waits for it to be resumed', async () => {
    state.paused = true;
    expect(panel(await lineOf('queued', { totals: totals(126), lensVersion: 1 })).textContent)
      .toContain('Blur 3-hop shows figures from before its latest edit, and a newer run is queued. It waits for this collection to be resumed.');
  });

  it('queued again with figures from its current rule on the latest analysis: says only that a newer run is queued', async () => {
    const t = panel(await lineOf('queued', { totals: totals(126) })).textContent!;
    expect(t).toContain('Blur 3-hop has a newer run queued.');
    expect(t).not.toContain('shows figures');
  });

  it('a re-run of a lens that ran says so while it runs, and whether what is shown is from before the edit', async () => {
    const now = panel(await lineOf('running', { totals: totals(126), progress: 0.5 })).textContent!;
    expect(now).toContain('Blur 3-hop has a newer run in progress. It is 50% done.');
    expect(now).not.toContain('shows figures');
    cleanup();
    expect(panel(await lineOf('running', { totals: totals(126), progress: 0.5, lensVersion: 1 })).textContent)
      .toContain('Blur 3-hop shows figures from before its latest edit, and a newer run is in progress. It is 50% done.');
  });

  it('done but behind the latest analysis: keeps its figures and says they are from the run before it', async () => {
    const c = await lineOf('done', { analysisId: 0 });
    expect(panel(c).textContent).toContain('Blur 3-hop shows figures from the run before the latest analysis. It runs again on the latest analysis soon.');
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).toContain('12.6% of sales');
    expect(tabs(c)[3]).toBe('Blur 3-hop 12.6% before analysis');
    cleanup();
    state.paused = true;
    expect(panel(await lineOf('done', { analysisId: 0 })).textContent).toContain('Blur 3-hop shows figures from the run before the latest analysis. It runs again once this collection is resumed.');
  });

  it('failed, keeping figures from before the edit or the latest analysis, says which', async () => {
    expect(panel(await lineOf('failed', { error: 'boom', totals: totals(126), lensVersion: 1 })).textContent)
      .toContain('Blur 3-hop has figures from before its latest edit: its last run failed. The error: boom. It is not tried again until you run it here or edit it.');
    cleanup();
    expect(panel(await lineOf('failed', { error: 'boom', totals: totals(126), analysisId: 0 })).textContent)
      .toContain('Blur 3-hop has figures from the run before the latest analysis: its last run failed. The error: boom.');
    cleanup();
    // Figures from its current rule on the latest analysis are not behind: nothing more is said of them.
    expect(panel(await lineOf('failed', { error: 'boom', totals: totals(126) })).textContent).toContain('Blur 3-hop has figures from an earlier run: its last run failed.');
  });

  it('says in its panel the same sentence Compare, the chart and the trade page say (a state with figures too)', async () => {
    for (const [r, words] of [
      [run('queued', { totals: totals(126) }), 'has a newer run queued.'],
      [run('done', { lensVersion: 1 }), 'shows figures from before its latest edit.'],
      [run('failed', { totals: totals(126), error: 'x' }), 'has figures from an earlier run: its last run failed.'],
    ] as const) {
      state.runs = [r];
      expect(panel(await draw({ method: 'L7' })).textContent).toContain(`Blur 3-hop ${words}`);
      cleanup();
    }
  });

  it('never says a lens of yours "did not run, so it flags nothing" beside its panel sentence', async () => {
    for (const r of [run(null), run('queued'), run('failed', { error: 'x' })]) {
      state.runs = [r];
      expect((await draw({ method: 'L7' })).textContent).not.toContain('did not run, so it flags nothing');
      cleanup();
    }
  });

  it('a built-in the latest analysis did not run is said of the latest analysis, in the words every page uses', async () => {
    state.off = ['AU'];
    const c = await draw({ method: 'AU' });
    expect(c.textContent).toContain('Money loops back did not run in the latest analysis, so it flags nothing. Choose another lens above.');
    expect(c.textContent).not.toContain('did not run, so it flags nothing');
  });
});

describe('without permission to write', () => {
  it('disables Copy to new lens, Edit, Delete, Run here and + New lens, each with the reason', async () => {
    state.remote = true;
    state.runs = [run(null)];
    const own = await draw({ method: 'L7' });
    for (const text of ['Delete', 'Run here', 'Edit', '+ New lens']) {
      const b = button(own, text) as HTMLButtonElement | undefined;
      expect(b, text).toBeDefined();
      expect(b!.disabled).toBe(true);
      expect(b!.title).toBe(LOCAL_ONLY);
    }
    expect(anchor(own, 'Edit')).toBeUndefined();
    cleanup();
    const built = await draw({ method: 'A' });
    const copy = button(built, 'Copy to new lens') as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(copy.title).toBe(LOCAL_ONLY);
    expect(anchor(built, 'Copy to new lens')).toBeUndefined();
  });

  it('offers + New lens as a link when writing is allowed', async () => {
    expect(anchor(await draw(), '+ New lens')?.getAttribute('href')).toBe(`${BASE}/methods?method=AC&lens=new`);
  });
});

describe('the copy rule', () => {
  it('shows no lens key and no code in text, aria-labels or titles, for any state', async () => {
    for (const status of [null, 'queued', 'running', 'failed', 'done'] as const) {
      state.runs = [run(status, status === 'failed' ? { error: 'boom' } : {})];
      for (const method of ['A', 'AU', 'AC', 'L7']) {
        const c = await draw({ method });
        expect(reads(c), `${status} ${method}`).not.toMatch(/\b(AU|AC|L7)\b/);
        cleanup();
      }
    }
  });
});

describe('Run here and Delete', () => {
  it('Run here posts the collection to the lens run route, then refreshes', async () => {
    state.runs = [run(null)];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ queued: true }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const c = await draw({ method: 'L7' });
    fireEvent.click(button(c, 'Run here')!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/lenses/7/runs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ chainId: 1, address: ADDR });
  });

  it('Run here shows the error the route gave and does not refresh', async () => {
    state.runs = [run(null)];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No such lens.' }), { status: 404 })));
    const c = await draw({ method: 'L7' });
    fireEvent.click(button(c, 'Run here')!);
    expect((await within(panel(c) as HTMLElement).findByRole('alert')).textContent).toBe('No such lens.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Delete asks inline first, by name, and calls nothing until confirmed', async () => {
    state.runs = [run('done')];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const c = await draw({ method: 'L7' });
    fireEvent.click(button(c, 'Delete')!);
    expect(panel(c).textContent).toContain('Delete Blur 3-hop and its results? This cannot be undone.');
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(button(c, 'Keep it')!);
    expect(panel(c).textContent).not.toContain('This cannot be undone.');
    fireEvent.click(button(c, 'Delete')!);
    fireEvent.click(button(c, 'Delete')!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/lenses/7');
    expect(init.method).toBe('DELETE');
    // writeBody wants a JSON body even from a delete.
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});

describe('when the service refuses or fails', () => {
  const cases: [string, () => Promise<Response>, string][] = [
    ['a 403', async () => new Response(JSON.stringify({ error: LOCAL_ONLY }), { status: 403 }), LOCAL_ONLY],
    ['a 409', async () => new Response(JSON.stringify({ error: 'Another lens is already called "X".' }), { status: 409 }), 'Another lens is already called "X".'],
    ['a non-JSON 500', async () => new Response('<html>oops</html>', { status: 500 }), 'The service answered 500.'],
    ['a network error', async () => { throw new TypeError('failed to fetch'); }, 'The service did not answer.'],
  ];

  it.each(cases)('Delete keeps its question open and says why on %s', async (_n, reply, said) => {
    state.runs = [run('done')];
    vi.stubGlobal('fetch', vi.fn(reply));
    const c = await draw({ method: 'L7' });
    fireEvent.click(button(c, 'Delete')!);
    fireEvent.click(button(c, 'Delete')!);
    expect((await within(panel(c) as HTMLElement).findByRole('alert')).textContent).toBe(said);
    expect(panel(c).textContent).toContain('This cannot be undone.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(cases)('Run here says why on %s', async (_n, reply, said) => {
    state.runs = [run(null)];
    vi.stubGlobal('fetch', vi.fn(reply));
    const c = await draw({ method: 'L7' });
    fireEvent.click(button(c, 'Run here')!);
    expect((await within(panel(c) as HTMLElement).findByRole('alert')).textContent).toBe(said);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the rule table, editable', () => {
  it('hands the editor a changed copy and leaves the rule it was given alone', async () => {
    const { RuleTable } = await import('@/components/rule-table');
    const rule = structuredClone(DEFAULT_RULE);
    const seen: (typeof rule)[] = [];
    const t = within(render(<RuleTable rule={rule} onChange={(r) => seen.push(r)} />).container);
    fireEvent.click(t.getByLabelText('Follow NFT: other tokens in this collection'));
    const days = t.getByLabelText('Days from the trade within which an edge counts');
    fireEvent.change(days, { target: { value: '7' } });
    fireEvent.blur(days);
    expect(seen[0]!.edges['nft-collection'].use).toBe(false);
    expect(seen[1]!.window).toEqual({ days: 7, side: 'either' });
    expect(rule).toEqual(DEFAULT_RULE);
  });

  it('keeps a half-typed amount until it is done, then stores it in wei', async () => {
    const { RuleTable } = await import('@/components/rule-table');
    const seen: (typeof DEFAULT_RULE)[] = [];
    const t = within(render(<RuleTable rule={structuredClone(DEFAULT_RULE)} onChange={(r) => seen.push(r)} />).container);
    fireEvent.click(t.getByRole('button', { name: 'Advanced' }));
    const eth = t.getByLabelText('ETH payment: smallest payment counted, in ETH');
    fireEvent.change(eth, { target: { value: '0.5' } });
    expect(seen).toHaveLength(0);
    fireEvent.blur(eth);
    expect(seen[0]!.edges.eth.minWei).toBe('500000000000000000');
  });

  it('draws no row for an unavailable edge type, so it can never be switched on', async () => {
    const { RuleTable } = await import('@/components/rule-table');
    const t = within(render(<RuleTable rule={structuredClone(DEFAULT_RULE)} onChange={() => {}} />).container);
    expect(t.queryByLabelText('Follow NFT: other watched collections')).toBeNull();
  });
});

describe('a lens\'s share is at least while the money it needs is not read that far', () => {
  const MORE = 'money is not read as far as this lens needs';
  const POINT = { at: 1_700_000_000_000, sales: 10, transfers: 10, flaggedSales: { A: 1, AU: 2, AC: 3 }, lens: { L7: { sales: 10, flaggedSales: 2, untimed: 0 } } };
  const mine = (depth: number) => run('done', {}, { rule: needing(depth) });

  it('shows at least on its tab, panel and chart for a lens needing depth 4 on a collection read to 3', async () => {
    state.runs = [mine(4)];
    state.points = [POINT];
    const c = await draw({ method: 'L7' });
    expect(tabs(c)[3]).toBe('Blur 3-hop at least 12.6%');
    expect(panel(c).textContent).toContain(`Its share is at least this, because ${MORE}.`);
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).toContain('at least 12.6% of sales');
    expect(c.querySelector(`span[title*="${MORE}"]`)?.textContent).toBe('(at least)');
  });

  it('reads exact when the collection is read as far as the lens needs', async () => {
    state.runs = [mine(3)];
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6%');
  });

  it('after the money is followed further, reads so far while reach wallets at depth 4 or nearer are pending, and exact once they are read', async () => {
    state.money = { ...READ, limit: 5, ownLimit: 5, pendingByDepth: { 4: 2, 5: 1 } };
    state.runs = [mine(4)];
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6% so far');
    cleanup();
    // Wallets pending only past the depth it needs do not hold it back.
    state.money = { ...READ, limit: 5, ownLimit: 5, pendingByDepth: { 5: 1 } };
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6%');
    cleanup();
    state.money = { ...READ, limit: 5, ownLimit: 5, pendingByDepth: {} };
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6%');
  });

  it('leads its lists with "so far" after the figure\'s noun, as the stat line does', async () => {
    state.money = { ...READ, limit: 5, ownLimit: 5, pendingByDepth: { 4: 2, 5: 1 } };
    state.runs = [mine(4)];
    expect(panel(await draw({ method: 'L7' })).textContent).toContain('What Blur 3-hop flags most: its 12.6% of sales so far, token by token and wallet by wallet.');
  });

  it('reads so far while seeding finds the wallets past the global limit, only for a lens that reaches past it', async () => {
    state.money = { ...READ, limit: 5, ownLimit: 5, seeding: true };
    state.runs = [mine(4)];
    state.points = [POINT];
    const c = await draw({ method: 'L7' });
    expect(tabs(c)[3]).toBe('Blur 3-hop 12.6% so far');
    expect(panel(c).textContent).toContain(`Its share can still rise while reads finish: ${MORE}.`);
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).toContain('12.6% of sales so far');
    expect(c.querySelector(`span[title*="${MORE}"]`)?.textContent).toBe('(so far)');
    cleanup();
    state.runs = [mine(3)];
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6%');
  });

  it('never reads at least for money on a lens with no money edge, and leaves the built-ins\' shares as they were', async () => {
    const nft = needing(4);
    for (const k of ['eth', 'internal', 'weth'] as const) nft.edges[k].use = false;
    state.runs = [run('done', {}, { rule: nft })];
    expect(tabs(await draw({ method: 'L7' })).slice(0, 4)).toEqual(['Round trips 4.1% the floor', 'Linked wallets 17.2% the ceiling', 'Money loops back 9.8% not counted', 'Blur 3-hop 12.6%']);
  });

  it('reads at least, listing both causes in order, when a cap and unread money apply together', async () => {
    state.money = { ...READ, limit: 5, ownLimit: 5, pendingByDepth: { 4: 2 } };
    state.runs = [run('done', { totals: totals(126, { truncated: 3 }) }, { rule: needing(4) })];
    const c = await draw({ method: 'L7' });
    expect(tabs(c)[3]).toBe('Blur 3-hop at least 12.6%');
    expect(panel(c).textContent).toContain(`Its share is at least this, because some of its searches stopped at the cap before finding a loop (3 searches); ${MORE}.`);
  });

  it('says a lens that follows money either way is a floor, in its own words', async () => {
    const either = structuredClone(DEFAULT_RULE);
    either.edges.eth.direction = 'either';
    state.runs = [run('done', {}, { rule: either })];
    const c = await draw({ method: 'L7' });
    expect(tabs(c)[3]).toBe('Blur 3-hop at least 12.6%');
    expect(panel(c).textContent).toContain('Its share is at least this, because money is followed only the way it was sent, so a loop against it can be missed.');
  });
});

describe("a lens's share is at least until its other tokens are read", () => {
  const OFF = 'other tokens are not read for this collection';
  const NOT_ALL = 'other tokens are not all read yet for this collection';
  const UNREACHED = 'other tokens are read only for wallets reached by ETH or WETH, so a loop through tokens can be missed';
  const POINT = { at: 1_700_000_000_000, sales: 10, transfers: 10, flaggedSales: { A: 1, AU: 2, AC: 3 }, lens: { L7: { sales: 10, flaggedSales: 2, untimed: 0 } } };
  /** A lens that follows other tokens only, with this many middle wallets at most. */
  const tokenLens = (max: number, on = true) => {
    const r = structuredClone(DEFAULT_RULE);
    for (const k of ['eth', 'internal', 'weth'] as const) r.edges[k].use = false;
    r.edges['other-tokens'].use = on;
    r.hops = { min: 0, max };
    return r;
  };
  const mineWith = (rule: ReturnType<typeof tokenLens>, tokensRead: number | null = null) => run('done', { tokensRead }, { rule });

  it('never started: at least on its tab, panel, stat line and chart, with the cause in the lens\'s words', async () => {
    state.runs = [mineWith(tokenLens(2))];
    state.points = [POINT];
    const c = await draw({ method: 'L7' });
    expect(tabs(c)[3]).toBe('Blur 3-hop at least 12.6%');
    expect(panel(c).textContent).toContain(`Its share is at least this, because ${OFF}.`);
    expect(c.querySelector('[aria-label="Blur 3-hop in numbers"]')!.textContent).toContain('at least 12.6% of sales');
    expect(c.querySelector(`span[title*="${OFF}"]`)?.textContent).toBe('(at least)');
  });

  it('a lens not using other tokens never gets a token cause, started or not', async () => {
    state.runs = [mineWith(tokenLens(2, false))];
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6%');
    cleanup();
    Object.assign(state, { started: true, counts: { ...COUNTED, read: 3 } });
    const c = await draw({ method: 'L7' });
    expect(tabs(c)[3]).toBe('Blur 3-hop 12.6%');
    expect(panel(c).textContent).not.toContain('other tokens');
  });

  it('started and still being read: not all read yet', async () => {
    state.runs = [mineWith(tokenLens(2), 10)];
    Object.assign(state, { started: true, counts: { ...COUNTED, read: 10 } });
    expect(panel(await draw({ method: 'L7' })).textContent).toContain(`${NOT_ALL}.`);
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6% so far');
    cleanup();
    // No count yet: seeding, the same words.
    state.counts = null;
    expect(panel(await draw({ method: 'L7' })).textContent).toContain(`${NOT_ALL}.`);
  });

  it('all read but the run took in another count: not all read yet, until the run catches up', async () => {
    Object.assign(state, { started: true, counts: COUNTED });
    state.runs = [mineWith(tokenLens(2), 12)];
    expect(panel(await draw({ method: 'L7' })).textContent).toContain(`Its share can still rise while reads finish: ${NOT_ALL}.`);
  });

  it('payees off: all read and current still reads at least with one middle wallet or more, not with none', async () => {
    Object.assign(state, { started: true, counts: COUNTED });
    state.runs = [mineWith(tokenLens(1), 40)];
    const c = await draw({ method: 'L7' });
    expect(tabs(c)[3]).toBe('Blur 3-hop at least 12.6%');
    expect(panel(c).textContent).toContain(`because ${UNREACHED}.`);
    cleanup();
    state.runs = [mineWith(tokenLens(0), 40)];
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6%');
  });

  it('payees on: the floor starts at two middle wallets, with the setting\'s wording', async () => {
    Object.assign(state, { started: true, payees: true, counts: { ...COUNTED, payees: true } });
    state.runs = [mineWith(tokenLens(1), 40)];
    expect(tabs(await draw({ method: 'L7' }))[3]).toBe('Blur 3-hop 12.6%');
    cleanup();
    state.runs = [mineWith(tokenLens(2), 40)];
    expect(panel(await draw({ method: 'L7' })).textContent).toContain(
      'because other tokens are read only for wallets reached by ETH, WETH or one token payment, so a loop through tokens can be missed.');
  });

  it("a tokens-only lens's strip has no money line, and its one line is the tokens one", async () => {
    state.keyed = true;
    state.runs = [mineWith(tokenLens(3))];
    const c = await draw({ method: 'L7', lens: 'edit-L7' });
    const needs = within(c.querySelector('section[aria-labelledby="data-needs"]') as HTMLElement);
    // Money is not used, so it has no line: the strip is the tokens one only.
    expect(needs.getAllByRole('listitem').map((li) => li.textContent)).toHaveLength(1);
    expect(needs.getByText(/Other tokens .* are not read/)).toBeTruthy();
    expect(needs.getByRole('button', { name: 'Read other tokens' })).toBeTruthy();
  });
});

describe('one set of words for a lens\'s run state, on every page', () => {
  const POINT = { at: 1_700_000_000_000, sales: 10, transfers: 10, flaggedSales: { A: 1, AU: 2, AC: 3 } };
  const STATES: [string, ReturnType<typeof run>, string, string][] = [
    ['not run', run(null), 'not run', 'has not run on this collection, so it flags nothing yet.'],
    ['first run unfinished', run('running', { progress: 0.4 }), 'first run 40%', 'has no figures yet: its first run has not finished.'],
    ['last run failed', run('failed', { error: 'out of memory' }), 'last run failed', 'has no figures: its last run failed.'],
  ];

  for (const [name, r, short, words] of STATES) {
    it(`${name} reads in one sentence on Compare, the chart and the trade page, and as its short label on the tab strip`, async () => {
      state.runs = [r];
      state.points = [POINT];
      const want = `Blur 3-hop ${words}`;
      const tab = tabs(await draw())[3];
      const chart = (await draw()).querySelector('[data-own-left]')!.textContent;
      const compare = [...(await draw({ method: 'compare' })).querySelectorAll('li')].find((li) => li.textContent?.startsWith('Blur 3-hop'))!.textContent;
      const { default: Tx } = await import('@/app/tx/[chain]/[hash]/page');
      const trade = [...render(await Tx({ params: Promise.resolve({ chain: '1', hash: TX }) })).container.querySelectorAll('li[data-lens]')].find((li) => li.textContent?.startsWith('Blur 3-hop'))!.textContent;
      expect(tab).toBe(`Blur 3-hop ${short}`);
      expect(chart).toBe(`No line for these lenses of yours: ${want}`);
      expect(compare).toBe(want);
      expect(trade).toContain(want);
    });
  }
});
