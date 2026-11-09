import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopEdge, Method, OwnFlag } from '@washtrace/detect';
import { DEFAULT_RULE, type LensRule } from '@washtrace/detect/lens-rule';

/** Two watched collections; the transaction moves token 7 of the first and token 8 of the second. */
const A1 = '0x' + 'a1'.repeat(20), A2 = '0x' + 'a2'.repeat(20);
const TX = '0x' + 'e'.repeat(64);
const S = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), W = '0x' + '9'.repeat(40);
const ZERO_ADDRESS = '0x' + '0'.repeat(40);
const ID: Record<string, number> = { [A1]: 1, [A2]: 2 };

const edge = (kind: LoopEdge['kind'], from: string, to: string, more: Partial<LoopEdge> = {}): LoopEdge =>
  ({ from, to, kind, tx: null, time: null, amountWei: null, tokenId: null, token: null, ...more });

/** A transfer S → B of `tokenId` in `address`, in tx `hash`, flagged by `flags`: a sale on Seaport (`marketplace` null: not a sale), timed by its block. */
function transfer(address: string, tokenId: string, hash: string, logIndex: number, block: number, flags: Method[] = [], from = S, to = B, marketplace: string | null = 'Seaport') {
  return {
    txHash: hash, logIndex, blockNumber: block, blockTime: (1_700_000_000 + block * 12) as number | null, tokenId, from, to, marketplace, priceWei: null, currency: '',
    flags: Object.fromEntries(flags.map((m) => [m, { kind: 'scc', wallets: [S, B], cycles: 2 }])),
    collection: { chainId: 1, address, name: address === A1 ? 'First' : 'Second' },
  };
}

/** Lens `id` named `name`, under `rule`: its run on each collection, by collection id; one with no entry has never run there. */
function lens(id: number, name: string, runs: Record<number, { throughBlock?: number | null; truncated?: number; done?: boolean; failed?: boolean }>, rule: LensRule = DEFAULT_RULE, version = 1) {
  return { id, name, runs, rule, version };
}

const state = {
  /** The transaction's transfers. */
  tx: [] as ReturnType<typeof transfer>[],
  /** Each token's every transfer, by `address/tokenId`. */
  tokens: {} as Record<string, ReturnType<typeof transfer>[]>,
  /** Which built-ins ran in each collection's latest analysis, and through which block it read. */
  ran: { 1: ['A', 'AU', 'AC'], 2: ['A', 'AU', 'AC'] } as Record<number, string[]>,
  through: { 1: 10, 2: 10 } as Record<number, number>,
  truncatedSearches: 0,
  lenses: [] as ReturnType<typeof lens>[],
  own: [] as OwnFlag[],
};

function runOf(l: ReturnType<typeof lens>, collectionId: number) {
  const r = l.runs[collectionId];
  if (r === undefined) return null;
  const done = r.done ?? true;
  return {
    lensId: l.id, collectionId, status: done ? 'done' as const : r.failed ? 'failed' as const : 'queued' as const, progress: null, lensVersion: 1, analysisId: 1, throughBlock: r.throughBlock === undefined ? 10 : r.throughBlock,
    totals: done ? { transfers: 1, flagged: 1, sales: 1, flaggedSales: 1, volumeWei: '0', flaggedVolumeWei: '0', wallets: 2, tokens: 1, available: true, truncated: r.truncated ?? 0, untimed: 0 } : null,
    error: null, retryAt: null, finishedAt: 1, tookMs: 1,
  };
}

const flows = vi.fn(async () => [] as unknown[]);
vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async (_chain: number, address: string) => {
      const id = ID[address];
      if (id === undefined) return null;
      const totals = Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, { transfers: 1, flagged: 0, sales: 1, flaggedSales: 0, volumeWei: '0', flaggedVolumeWei: '0', wallets: 0, tokens: 0, available: state.ran[id]!.includes(m) }]));
      return { id, chainId: 1, address, name: address === A1 ? 'First' : 'Second', latest: { id: 1, throughBlock: state.through[id], truncatedSearches: state.truncatedSearches, totals } };
    },
    transaction: async () => state.tx,
    token: async (id: number, tokenId: string) => state.tokens[`${id === 1 ? A1 : A2}/${tokenId}`] ?? [],
    flowsAmong: flows,
    lensRuns: async (collectionId: number) => state.lenses.map((l) => ({
      lens: { id: l.id, key: `L${l.id}` as const, name: l.name, rule: l.rule, version: l.version, createdAt: 0, updatedAt: 0 },
      run: runOf(l, collectionId),
    })),
    lensFlagsOfTx: async () => state.own.filter((f) => f.txHash === TX),
    lensFlagsOfToken: async (id: number, tokenId: string, ids: readonly number[]) => {
      const rows = state.tokens[`${id === 1 ? A1 : A2}/${tokenId}`] ?? [];
      // The store's order: by the transfer's place in the chain, then by lens.
      const place = (f: OwnFlag) => rows.findIndex((t) => t.txHash === f.txHash && t.logIndex === f.logIndex);
      return state.own.filter((f) => f.collectionId === id && ids.includes(f.lensId) && place(f) >= 0).sort((x, y) => place(x) - place(y) || x.lensId - y.lensId);
    },
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  flows.mockClear();
  Object.assign(state, { tx: [], tokens: {}, ran: { 1: ['A', 'AU', 'AC'], 2: ['A', 'AU', 'AC'] }, through: { 1: 10, 2: 10 }, truncatedSearches: 0, lenses: [], own: [] });
});

async function txPage(): Promise<HTMLElement> {
  const { default: P } = await import('@/app/tx/[chain]/[hash]/page');
  return render(await P({ params: Promise.resolve({ chain: '1', hash: TX }) })).container;
}
async function tokenPage(address: string, tokenId: string, sp: Record<string, string>): Promise<HTMLElement> {
  const { default: P } = await import('@/app/c/[chain]/[address]/t/[tokenId]/page');
  return render(await P({ params: Promise.resolve({ chain: '1', address, tokenId }), searchParams: Promise.resolve(sp) })).container;
}

/** The lens cards of the section about `title`'s transfer, by the lens name each starts with. */
function cards(c: HTMLElement, title: string): Map<string, HTMLElement> {
  const section = [...c.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === title);
  if (!section) throw new Error(`no section ${title}`);
  return new Map([...section.querySelectorAll<HTMLElement>('li[data-lens]')].map((li) => [li.querySelector('[data-lens-name]')?.textContent ?? '', li]));
}
const lit = (el: Element) => [...el.querySelectorAll('[data-lit]')].map((e) => e.getAttribute('data-edge')).sort();

/** Token 7 of the first collection: bought back once before this trade, and caught by Round trips, then this trade (row 3). */
function roundTrip(flags: Method[] = ['A']) {
  const rows = [
    transfer(A1, '7', '0x01', 0, 3, flags),
    transfer(A1, '7', '0x02', 0, 4, flags, B, S),
    transfer(A1, '7', TX, 5, 5, flags),
  ];
  state.tokens[`${A1}/7`] = rows;
  state.tx = [rows[2]!];
}
/** Lens `id`'s catch of this trade, back from the buyer through a money middle. */
const caughtOwn = (id: number, collectionId = 1, logIndex = 5): OwnFlag => ({
  lensId: id, collectionId, txHash: TX, logIndex, wallets: [S, B, W],
  path: [edge('nft-token', S, B, { tx: TX, tokenId: '7' }), edge('eth', B, W, { amountWei: '500000000000000000' }), edge('weth', W, S)],
});

describe('the trade page: one card per lens', () => {
  it("a caught trade's card draws its loop, for a built-in and for a lens of yours", async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    // The lens catches an earlier trade of the token too, so its loop for this trade is not its first.
    state.own = [{ ...caughtOwn(7), txHash: '0x01', logIndex: 0 }, caughtOwn(7)];
    const c = await txPage();
    const card = cards(c, 'How each lens reads First #7');
    const a = card.get('Round trips')!;
    expect(a.querySelector('figure')).not.toBeNull();
    // Round trips' one pattern holds all three of the token's transfers.
    expect(lit(a)).toEqual(['t0', 't1', 't2']);
    expect(a.textContent).toContain('2 wallets pass it around in 2 cycles');
    const own = card.get('Fast flips')!;
    // Its loop for this trade (o1): the trade's arrow and the way back through the middle.
    expect(lit(own)).toEqual(['o1e1', 'o1e2', 't2']);
    expect(own.textContent).toContain('Back to the seller through 1 wallet, 2 by money');
    const open = (li: HTMLElement) => [...li.querySelectorAll('a')].find((x) => x.textContent === 'Open it in the token’s graph →')?.getAttribute('href');
    expect(open(a)).toBe(`/c/1/${A1}/t/7?loop=r0`);
    expect(open(own)).toBe(`/c/1/${A1}/t/7?loop=o1`);
  });

  it('a card’s loop key lights the same loop on the token page', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} }), lens(8, 'Slow loops', { 1: {} })];
    state.own = [{ ...caughtOwn(8), txHash: '0x01', logIndex: 0 }, caughtOwn(7), caughtOwn(8)];
    const c = await txPage();
    const keys: string[] = [];
    for (const [name, li] of cards(c, 'How each lens reads First #7')) {
      if (li.querySelector('figure') === null) continue;
      const href = [...li.querySelectorAll('a')].find((x) => x.textContent === 'Open it in the token’s graph →')!.getAttribute('href')!;
      const loop = new URL(href, 'http://x').searchParams.get('loop')!;
      keys.push(loop);
      const onTrade = lit(li);
      expect(onTrade.length, name).toBeGreaterThan(0);
      const token = await tokenPage(A1, '7', { loop });
      expect(lit(token.querySelector('figure')!), name).toEqual(onTrade);
    }
    // The built-in's pattern, Fast flips' loop (o1) and Slow loops' second (o2): o0 is Slow loops' catch of an earlier trade.
    expect(keys.sort()).toEqual(['o1', 'o2', 'r0']);
  });

  it('a card that doesn’t catch says its one line', async () => {
    const { NOT_CAUGHT, OWN_NOT_CAUGHT, CAPPED, OWN_BEHIND } = await import('@/lib/format');
    roundTrip([]);
    state.truncatedSearches = 0;
    state.lenses = [lens(7, 'Fast flips', { 1: {} }), lens(8, 'Capped', { 1: { truncated: 3 } }), lens(9, 'Behind', { 1: { throughBlock: 4 } })];
    const c = await txPage();
    const card = cards(c, 'How each lens reads First #7');
    expect(card.get('Round trips')!.textContent).toContain(NOT_CAUGHT.A);
    expect(card.get('Money loops back')!.textContent).toContain(NOT_CAUGHT.AU);
    expect(card.get('Linked wallets')!.textContent).toContain(NOT_CAUGHT.AC);
    expect(card.get('Fast flips')!.textContent).toContain(OWN_NOT_CAUGHT);
    expect(card.get('Fast flips')!.textContent).not.toContain(CAPPED.trim());
    expect(card.get('Capped')!.textContent).toContain(`${OWN_NOT_CAUGHT}${CAPPED}`);
    expect(card.get('Behind')!.textContent).toContain(OWN_BEHIND);
    expect(card.get('Behind')!.textContent).not.toContain(OWN_NOT_CAUGHT);
    // Nothing caught it, so nothing is drawn and the token was not read.
    expect(c.querySelectorAll('li[data-lens] figure')).toHaveLength(0);
    expect(flows).not.toHaveBeenCalled();
  });

  it('the copy says each built-in’s miss in its own words', async () => {
    const { NOT_CAUGHT, OWN_NOT_CAUGHT, CAPPED, OWN_BEHIND, BUILT_IN_BEHIND } = await import('@/lib/format');
    expect(NOT_CAUGHT).toEqual({
      A: 'The token never comes back to the seller after this trade, or not as often as a pattern needs.',
      AU: 'No money it reads from the buyer finds its way back to the seller within the longest path it follows. It follows none from or through an exchange, a router, a contract or a wallet whose history was too long to read.',
      AC: 'The buyer and seller paid each other nothing it reads, and share no money partner but an exchange, a router, a contract or a wallet whose history was too long to read.',
    });
    const { MINT_LINE, BURN_LINE } = await import('@/lib/format');
    expect(MINT_LINE).toBe('A mint: no lens caught it.');
    expect(BURN_LINE).toBe('A burn, not a trade: no lens judges it.');
    expect(OWN_NOT_CAUGHT).toBe('No way back to the seller under its rule.');
    expect(CAPPED).toBe(' Some searches here stopped at the cap, so this is not proof it is clean.');
    expect(OWN_BEHIND).toBe('Not judged yet: this trade is past the block its run read.');
    expect(BUILT_IN_BEHIND).toBe('Not judged yet: no analysis has read as far as this trade.');
  });

  it('a run from before your last edit says so, as its tab does, never "under its rule"', async () => {
    const { OWN_NOT_CAUGHT, OWN_BEFORE_EDIT, CAPPED } = await import('@/lib/format');
    expect(OWN_BEFORE_EDIT).toBe('Shows figures from before its latest edit: the run they came from did not catch this transfer, and the new rule’s run has not saved yet.');
    roundTrip([]);
    // Edited since its run (version 2, run at 1): the run's rule is not the one it has now.
    state.lenses = [lens(7, 'Fast flips', { 1: {} }, DEFAULT_RULE, 2), lens(8, 'Capped', { 1: { truncated: 2 } }, DEFAULT_RULE, 2)];
    const card = cards(await txPage(), 'How each lens reads First #7');
    expect(card.get('Fast flips')!.textContent).toBe(`Fast flips${OWN_BEFORE_EDIT}`);
    expect(card.get('Capped')!.textContent).toBe(`Capped${OWN_BEFORE_EDIT}${CAPPED}`);
    expect(card.get('Fast flips')!.textContent).not.toContain(OWN_NOT_CAUGHT);
  });

  it('a run from before an edit is not read by the rule it has now: a non-sale under a now sales-only rule says the run, not "judges sales only"', async () => {
    const { OWN_BEFORE_EDIT } = await import('@/lib/format');
    state.tx = [transfer(A1, '7', TX, 5, 5, [], S, B, null)];
    state.lenses = [lens(7, 'Fast flips', { 1: {} }, DEFAULT_RULE, 2)];
    const li = cards(await txPage(), 'How each lens reads First #7').get('Fast flips')!;
    expect(li.textContent).toContain(OWN_BEFORE_EDIT);
    expect(li.textContent).not.toContain('judges sales only');
  });

  it('Money loops back’s miss says a capped search is no proof', async () => {
    const { NOT_CAUGHT, CAPPED } = await import('@/lib/format');
    roundTrip([]);
    state.truncatedSearches = 2;
    const card = cards(await txPage(), 'How each lens reads First #7');
    expect(card.get('Money loops back')!.textContent).toContain(`${NOT_CAUGHT.AU}${CAPPED}`);
    expect(card.get('Linked wallets')!.textContent).not.toContain(CAPPED.trim());
  });

  it('a trade past the latest analysis is not judged yet by the built-ins, not clean', async () => {
    const { NOT_CAUGHT, BUILT_IN_BEHIND } = await import('@/lib/format');
    roundTrip([]);
    state.through = { 1: 4, 2: 10 };
    const card = cards(await txPage(), 'How each lens reads First #7');
    expect(card.get('Round trips')!.textContent).toContain(BUILT_IN_BEHIND);
    expect(card.get('Round trips')!.textContent).not.toContain(NOT_CAUGHT.A);
  });

  it('a tx moving tokens of two collections has a section per transfer, each with that collection’s lenses', async () => {
    roundTrip();
    const other = transfer(A2, '8', TX, 9, 5);
    state.tokens[`${A2}/8`] = [other];
    state.tx = [...state.tx, other];
    // Linked wallets and Money loops back did not run on the second; Fast flips ran on the first only, and caught there.
    state.ran = { 1: ['A', 'AU', 'AC'], 2: ['A'] };
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    state.own = [caughtOwn(7), caughtOwn(7, 2, 9)];
    const { NOT_CAUGHT } = await import('@/lib/format');
    const c = await txPage();
    const first = cards(c, 'How each lens reads First #7'), second = cards(c, 'How each lens reads Second #8');
    expect([...first.keys()]).toEqual(['Round trips', 'Money loops back', 'Linked wallets', 'Fast flips']);
    expect([...second.keys()]).toEqual(['Round trips', 'Money loops back', 'Linked wallets', 'Fast flips']);
    expect(first.get('Fast flips')!.querySelector('figure')).not.toBeNull();
    // A flag stored on a collection the lens never ran on is not read as a catch.
    expect(second.get('Fast flips')!.textContent).toContain('Fast flips has not run on this collection, so it flags nothing yet.');
    expect(second.get('Fast flips')!.querySelector('figure')).toBeNull();
    expect(second.get('Round trips')!.textContent).toContain(NOT_CAUGHT.A);
    expect(second.get('Linked wallets')!.textContent).toContain('Linked wallets did not run in the latest analysis, so it flags nothing.');
    // Each card's lens name opens that lens's tab on its own collection.
    const tab = (li: HTMLElement, name: string) => [...li.querySelectorAll('a')].find((x) => x.textContent === name)?.getAttribute('href');
    expect(tab(first.get('Round trips')!, 'Round trips')).toBe(`/c/1/${A1}?method=A#evidence`);
    expect(tab(second.get('Round trips')!, 'Round trips')).toBe(`/c/1/${A2}?method=A#evidence`);
  });

  it('across two collections, the answer names the one whose latest analysis missed a lens, never that a lens it names as flagging flags nothing (Ruling S17)', async () => {
    // No key: the first collection's stored trail runs Money loops back, which flags its sale; the second's analysis runs neither money lens.
    roundTrip(['A', 'AU']);
    const other = transfer(A2, '8', TX, 9, 5);
    state.tokens[`${A2}/8`] = [other];
    state.tx = [...state.tx, other];
    state.ran = { 1: ['A', 'AU', 'AC'], 2: ['A'] };
    const c = await txPage();
    const body = c.querySelector('p.text-lg')!.nextElementSibling!.textContent!;
    expect(body).toContain('The lenses on the right flag it.');
    expect(body).toContain('Money loops back and Linked wallets did not run in the latest analysis of Second, so they flag nothing there.');
    expect(body).not.toMatch(/did not run in the latest analysis, so (it|they) flag/);
  });

  it('across two collections, each lens is named with the collections that missed it', async () => {
    roundTrip();
    const other = transfer(A2, '8', TX, 9, 5);
    state.tokens[`${A2}/8`] = [other];
    state.tx = [...state.tx, other];
    state.ran = { 1: ['A', 'AU'], 2: ['A', 'AC'] };
    const body = (await txPage()).querySelector('p.text-lg')!.nextElementSibling!.textContent!;
    expect(body).toContain('Money loops back did not run in the latest analysis of Second, so it flags nothing there.');
    expect(body).toContain('Linked wallets did not run in the latest analysis of First, so it flags nothing there.');
  });

  it('in one collection, the answer keeps the one-collection sentence', async () => {
    roundTrip();
    state.ran = { 1: ['A'], 2: ['A'] };
    const body = (await txPage()).querySelector('p.text-lg')!.nextElementSibling!.textContent!;
    expect(body).toContain('Money loops back and Linked wallets did not run in the latest analysis, so they flag nothing.');
    expect(body).not.toContain(' of First');
  });

  it('a lens that did not run says so, and is not a not-caught line', async () => {
    const { NOT_CAUGHT, OWN_NOT_CAUGHT } = await import('@/lib/format');
    roundTrip([]);
    state.ran = { 1: ['A'], 2: ['A'] };
    state.lenses = [lens(9, 'Never here', {}), lens(10, 'Queued', { 1: { done: false } }), lens(11, 'Broke', { 1: { done: false, failed: true } })];
    const card = cards(await txPage(), 'How each lens reads First #7');
    // Compare's words for each case (leftOut), and a link that fits it.
    const said = { 'Never here': ['Never here has not run on this collection, so it flags nothing yet.', 'Run it from its tab →', 'L9'],
      Queued: ['Queued has no figures yet: its first run has not finished.', 'Follow it on its tab →', 'L10'],
      Broke: ['Broke has no figures: its last run failed.', 'See why on its tab →', 'L11'] };
    for (const [name, [line, link, key]] of Object.entries(said)) {
      const li = card.get(name)!;
      expect(li.textContent).toBe(`${name}${line} ${link}`);
      expect(li.textContent).not.toContain(OWN_NOT_CAUGHT);
      expect([...li.querySelectorAll('a')].find((x) => x.textContent === link)?.getAttribute('href')).toBe(`/c/1/${A1}?method=${key}`);
    }
    const why = (li: HTMLElement) => [...li.querySelectorAll('a')].find((x) => x.textContent === 'See why on its tab →')?.getAttribute('href');
    for (const [m, name] of [['AU', 'Money loops back'], ['AC', 'Linked wallets']] as const) {
      const li = card.get(name)!;
      expect(li.textContent).toContain(`${name} did not run in the latest analysis, so it flags nothing.`);
      expect(li.textContent).not.toContain(NOT_CAUGHT[m]);
      expect(why(li)).toBe(`/c/1/${A1}?method=${m}`);
    }
  });

  it('a sale only your lens caught: the verdict stays the built-ins’, and names the lens of yours that caught it (P8)', async () => {
    roundTrip([]);
    state.lenses = [lens(7, 'Fast flips', { 1: {} }), lens(8, 'Slow loops', { 1: {} })];
    state.own = [caughtOwn(7)];
    const c = await txPage();
    const title = c.querySelector('p.text-lg')!.textContent!;
    const answer = title + (c.querySelector('p.text-lg')!.nextElementSibling?.textContent ?? '');
    expect(title).toBe('Not flagged by the built-in lenses');
    expect(answer).not.toMatch(/any lens|no lens that ran/);
    expect(answer).toContain('no built-in lens that ran flags it.');
    expect(answer).toContain('Your lenses catch it: Fast flips.');
    expect(answer).not.toContain('Slow loops');
  });

  it('a sale a built-in and your lens both caught says your lens also catches it', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    state.own = [caughtOwn(7)];
    const c = await txPage();
    expect(c.querySelector('p.text-lg')!.textContent).toBe('Flagged as a wash trade');
    expect(c.querySelector('p.text-lg')!.nextElementSibling!.textContent).toContain('Your lenses also catch it: Fast flips.');
  });

  it('a row of the moved table chips a lens of yours that caught it', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    state.own = [caughtOwn(7)];
    const c = await txPage();
    const chips = [...c.querySelectorAll('tbody tr td:nth-child(5) a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(chips).toEqual([['Round trips', `/c/1/${A1}?method=A#evidence`], ['Fast flips', `/c/1/${A1}?method=L7#evidence`]]);
  });

  it('no lens code in text, aria-label or title', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} }), lens(8, 'Capped', { 1: { truncated: 3 } }), lens(9, 'Never here', {})];
    state.own = [caughtOwn(7)];
    const c = await txPage();
    const said = [
      c.textContent ?? '',
      ...[...c.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')!),
      ...[...c.querySelectorAll('[title]')].map((e) => e.getAttribute('title')!),
      ...[...c.querySelectorAll('title')].map((e) => e.textContent ?? ''),
    ];
    for (const s of said) expect(s).not.toMatch(/\b(L[789]|AU|AC)\b/);
  });

  it('each figure has its own arrow markers, and says whose loop it lights', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    state.own = [caughtOwn(7)];
    const c = await txPage();
    const ids = [...c.querySelectorAll('marker')].map((m) => m.id);
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size).toBe(ids.length);
    // Every arrowhead names a marker of its own figure.
    for (const svg of c.querySelectorAll('li[data-lens] svg')) {
      const own = new Set([...svg.querySelectorAll('marker')].map((m) => m.id));
      for (const p of svg.querySelectorAll('path[marker-end]')) expect(own.has(p.getAttribute('marker-end')!.slice(5, -1))).toBe(true);
    }
    const labels = [...c.querySelectorAll('li[data-lens] svg[aria-label]')].map((s) => s.getAttribute('aria-label'));
    expect(labels).toEqual(['The loop Round trips caught, lit in this token’s graph', 'The loop Fast flips caught, lit in this token’s graph']);
  });

  it.each([
    ['mint no lens caught', ZERO_ADDRESS, B, 'Lenses on the mint of First #7', 'A mint: no lens caught it.'],
    ['burn', S, ZERO_ADDRESS, 'Lenses on the burn of First #7', 'A burn, not a trade: no lens judges it.'],
  ])('a %s gets one line in place of the cards, under a heading that fits it', async (_kind, from, to, title, line) => {
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    state.tx = [transfer(A1, '7', TX, 5, 5, [], from, to)];
    const c = await txPage();
    expect([...c.querySelectorAll('h2')].map((h) => h.textContent)).not.toContain('How each lens reads First #7');
    const section = [...c.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === title)!;
    expect(section.textContent).toContain(line);
    expect(section.querySelectorAll('li[data-lens]')).toHaveLength(0);
  });
});

/**
 * Each built-in's miss line, held against the trade the engine misses: the
 * flags here are analyze()'s own, not written by hand.
 */
describe('a built-in’s miss line is true of the trade it misses', () => {
  const M = '0x' + '5'.repeat(40);
  /** Runs the built-ins on `rows` and writes their flags onto them, with `pays` as payments and `truncated` as wallets whose history was too long to read. Row `at` is the transaction's (the last by default). */
  async function judge(rows: ReturnType<typeof transfer>[], pays: [string, string][] = [], truncated: string[] = [], at = rows.length - 1) {
    const { analyze, Payments } = await import('@washtrace/detect');
    const paid = pays.map(([from, to], i) => ({ txHash: `0xf${i}`, kind: 'eth', from, to, valueWei: '1' })) as never[];
    const r = analyze({
      transfers: rows, payments: Payments.from(paid, rows), fundingAvailable: true, funded: new Set([S, B, M]), truncated: new Set(truncated),
      custodians: new Set(), contracts: new Set(), money: new Set(['']),
    });
    for (const t of rows) t.flags = Object.fromEntries(r.flags.filter((f) => f.txHash === t.txHash && f.logIndex === t.logIndex).map((f) => [f.method, f.witness])) as never;
    state.tokens[`${A1}/7`] = rows;
    state.tx = [rows[at]!];
  }
  const line = async (name: string) => cards(await txPage(), 'How each lens reads First #7').get(name)!.textContent ?? '';

  it('a re-mint after a burn is a step of the token, judged like any trade: one a lens caught gets its cards and its loop', async () => {
    // S mints, sells to B, B burns it, and it is minted to S again (custody through the zero address), twice; the transaction is the first re-mint.
    const Z = ZERO_ADDRESS;
    const step = (i: number, from: string, to: string) => transfer(A1, '7', i === 3 ? TX : `0x0${i}`, i === 3 ? 5 : 0, i + 1, [], from, to);
    const rows = [step(0, Z, S), step(1, S, B), step(2, B, Z), step(3, Z, S), step(4, S, B), step(5, B, Z), step(6, Z, S)];
    await judge(rows, [], [], 3);
    // The engine's own reading: the sales and the re-mints are the round trips, the first mint and the burns no step at all.
    expect(rows.map((t) => 'A' in t.flags)).toEqual([false, true, false, true, true, false, true]);
    const c = await txPage();
    const a = cards(c, 'How each lens reads First #7').get('Round trips')!;
    expect(a.querySelector('figure')).not.toBeNull();
    expect(lit(a).length).toBeGreaterThan(0);
    expect(c.textContent).not.toContain('A mint: no lens caught it.');
  });

  it('Round trips: the exit sale after a pattern, though the token came back to the seller twice before it', async () => {
    const X = '0x' + '6'.repeat(40), Y = '0x' + '7'.repeat(40);
    const rows = [transfer(A1, '7', '0x01', 0, 1, [], S, X), transfer(A1, '7', '0x02', 0, 2, [], X, S), transfer(A1, '7', '0x03', 0, 3, [], S, Y), transfer(A1, '7', '0x04', 0, 4, [], Y, S), transfer(A1, '7', TX, 5, 5)];
    await judge(rows);
    expect(rows.map((t) => 'A' in t.flags)).toEqual([true, true, true, true, false]);
    expect(await line('Round trips')).toContain('The token never comes back to the seller after this trade, or not as often as a pattern needs.');
  });

  it('Money loops back: a buyer whose history was too long to read pays the seller back directly', async () => {
    await judge([transfer(A1, '7', TX, 5, 5)], [[B, S]], [B]);
    expect('AU' in state.tx[0]!.flags).toBe(false);
    expect(await line('Money loops back')).toContain('It follows none from or through an exchange, a router, a contract or a wallet whose history was too long to read.');
  });

  it('Linked wallets: the only wallet both are joined to by money had too long a history to read', async () => {
    await judge([transfer(A1, '7', TX, 5, 5)], [[S, M], [M, B]], [M]);
    expect('AC' in state.tx[0]!.flags).toBe(false);
    expect(await line('Linked wallets')).toContain('share no money partner but an exchange, a router, a contract or a wallet whose history was too long to read.');
  });
});

/**
 * Ruling S10: a transfer a lens does not judge never gets that lens's "not
 * caught" line. Which transfers each lens judges is the engine's call, so
 * the flags here are analyze()'s and runLens's own: the built-ins judge every
 * step of the token's graph, where graph.ts folds custody away; a lens of
 * yours judges the same steps, less the non-sales under a sales-only rule and
 * the untimed ones under a window or loop order.
 */
describe('a transfer a lens does not judge says so, never that it was not caught', () => {
  const BLEND = '0x29469395eaf6f95920e59f858042f0e28d98a20b';
  /** DEFAULT_RULE judging every change of owner, and closing on a way straight back: the lens that catches a non-sale round trip. */
  const OWNERS: LensRule = { ...DEFAULT_RULE, judges: 'owners', hops: { min: 0, max: 3 } };
  /** DEFAULT_RULE with no window and no loop order: nothing in it needs a trade's time. */
  const ANY_TIME: LensRule = { ...DEFAULT_RULE, window: null, order: 'any' };

  /**
   * The engine on `rows`, with `custodians` as escrows: the built-ins' flags
   * written onto the rows, and each lens's flags (by id) as the store keeps
   * them. Row `at` is the transaction's.
   */
  async function engine(rows: ReturnType<typeof transfer>[], at: number, lenses: [number, LensRule][], custodians: string[] = []) {
    const { analyze, runLens, Moves, Payments } = await import('@washtrace/detect');
    const r = analyze({
      transfers: rows, payments: Payments.from([], rows), fundingAvailable: true, funded: new Set([S, B]), truncated: new Set(),
      custodians: new Set(custodians), contracts: new Set(), money: new Set(['']),
    });
    for (const t of rows) t.flags = Object.fromEntries(r.flags.filter((f) => f.txHash === t.txHash && f.logIndex === t.logIndex).map((f) => [f.method, f.witness])) as never;
    const moves = new Moves();
    moves.seal();
    const runs = lenses.map(([id, rule]) => ({ id, ...runLens(rule, {
      transfers: rows, through: null, moves, contracts: new Set(), custodians: new Set(custodians), money: new Set(['']), truncated: new Set(), tradeTxs: [...new Set(rows.map((t) => t.txHash))], tokensRead: null,
    }) }));
    state.own = runs.flatMap(({ id, flags }) => flags.map((f): OwnFlag => ({ ...f, lensId: id, collectionId: 1 })));
    state.tokens[`${A1}/7`] = rows;
    state.tx = [rows[at]!];
    return { uncounted: r.uncounted, runs };
  }
  const section = (c: HTMLElement, title: string) => [...c.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === title);
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  it('a lens of yours that judges sales only, on a transfer that is not a sale: not judged, while one judging every owner catches it', async () => {
    const { OWN_NOT_CAUGHT } = await import('@/lib/format');
    // S hands token 7 to B outside any market, and B hands it straight back.
    const rows = [transfer(A1, '7', TX, 5, 5, [], S, B, null), transfer(A1, '7', '0x03', 0, 6, [], B, S, null)];
    state.lenses = [lens(7, 'Fast flips', { 1: {} }), lens(8, 'Every owner', { 1: {} }, OWNERS)];
    const { runs } = await engine(rows, 0, [[7, DEFAULT_RULE], [8, OWNERS]]);
    // The engine's own reading: the sales-only lens never looked at it, and the one judging owners caught it.
    expect(runs.map((r) => r.flags.map((f) => f.txHash))).toEqual([[], [TX, '0x03']]);
    const card = cards(await txPage(), 'How each lens reads First #7');
    expect(card.get('Fast flips')!.textContent).toContain('Not judged: Fast flips judges sales only, and this transfer is not a sale.');
    expect(card.get('Fast flips')!.textContent).not.toContain(OWN_NOT_CAUGHT);
    expect(card.get('Every owner')!.querySelector('figure')).not.toBeNull();
  });

  it('a sale with no block time, under a rule that times its window from the trade: not judged; with no window it is judged', async () => {
    const { OWN_NOT_CAUGHT } = await import('@/lib/format');
    const rows = [transfer(A1, '7', TX, 5, 5)];
    rows[0]!.blockTime = null;
    const inOrder: LensRule = { ...ANY_TIME, order: 'loop' };
    state.lenses = [lens(7, 'Fast flips', { 1: {} }), lens(8, 'Any time', { 1: {} }, ANY_TIME), lens(9, 'In order', { 1: {} }, inOrder)];
    const { runs } = await engine(rows, 0, [[7, DEFAULT_RULE], [8, ANY_TIME], [9, inOrder]]);
    expect(runs.map((r) => r.totals.untimed)).toEqual([1, 0, 1]);
    const card = cards(await txPage(), 'How each lens reads First #7');
    expect(card.get('Fast flips')!.textContent).toContain('Not judged: this transfer has no block time, and Fast flips measures its window from it.');
    expect(card.get('In order')!.textContent).toContain('Not judged: this transfer has no block time, and In order measures its loop order from it.');
    expect(card.get('Any time')!.textContent).toContain(OWN_NOT_CAUGHT);
    for (const name of ['Fast flips', 'In order']) expect(card.get(name)!.textContent).not.toContain(OWN_NOT_CAUGHT);
  });

  it.each([
    ['into custody, the loan taken', 0, 'Lenses on First #7 going into custody', 'Into custody, not a trade: no lens judges it, since the escrow holds the token without owning it.'],
    ['out of custody, the loan repaid', 1, 'Lenses on First #7 coming out of custody', 'Out of custody, back to the wallet that put it in: not a trade, so no lens judges it.'],
  ])('a Blur Blend loan, %s: one line, no lens card', async (_leg, at, title, line) => {
    const { NOT_CAUGHT, OWN_NOT_CAUGHT } = await import('@/lib/format');
    // S borrows against token 7 and repays: S → Blend → S.
    const rows = [transfer(A1, '7', at === 0 ? TX : '0x01', at === 0 ? 5 : 0, 3, [], S, BLEND, null), transfer(A1, '7', at === 1 ? TX : '0x02', at === 1 ? 5 : 0, 4, [], BLEND, S, null)];
    state.lenses = [lens(7, 'Fast flips', { 1: {} }), lens(8, 'Every owner', { 1: {} }, OWNERS)];
    const { uncounted, runs } = await engine(rows, at, [[7, DEFAULT_RULE], [8, OWNERS]], [BLEND]);
    // The engine's own reading: neither leg is a step of the token, so nothing judged either one.
    expect(uncounted).toHaveLength(2);
    expect(rows.every((t) => Object.keys(t.flags).length === 0) && runs.every((r) => r.flags.length === 0)).toBe(true);
    const c = await txPage();
    const s = section(c, title)!;
    expect(s.textContent).toContain(line);
    expect(s.querySelectorAll('li[data-lens]')).toHaveLength(0);
    expect(c.textContent).not.toContain(NOT_CAUGHT.A);
    expect(c.textContent).not.toContain(OWN_NOT_CAUGHT);
  });

  it('a move out of custody with no move into it read before: no seller, so no lens judges it', async () => {
    const rows = [transfer(A1, '7', TX, 5, 4, [], BLEND, S, null)];
    state.lenses = [lens(8, 'Every owner', { 1: {} }, OWNERS)];
    const { uncounted } = await engine(rows, 0, [[8, OWNERS]], [BLEND]);
    expect(uncounted).toHaveLength(1);
    const s = section(await txPage(), 'Lenses on First #7 coming out of custody')!;
    expect(s.textContent).toContain('Out of custody, with no move of it into custody read before: there is no seller, so no lens judges it.');
  });

  it('a move out of custody to another wallet is a trade from the one that put it in: judged, and its lead names that seller', async () => {
    const { NOT_CAUGHT } = await import('@/lib/format');
    // S borrows against token 7 and the lender B takes it: S → Blend → B is one trade S → B.
    const rows = [transfer(A1, '7', '0x01', 0, 3, [], S, BLEND, null), transfer(A1, '7', TX, 5, 4, [], BLEND, B, null)];
    state.lenses = [lens(8, 'Every owner', { 1: {} }, OWNERS)];
    const { uncounted } = await engine(rows, 1, [[8, OWNERS]], [BLEND]);
    expect(uncounted.map((u) => u.txHash)).toEqual(['0x01']);
    const c = await txPage();
    const s = section(c, 'How each lens reads First #7')!;
    expect(s.textContent).toContain(`${short(S)} → ${short(B)}, through custody: ${short(BLEND)} held the token for ${short(S)}, so each lens reads this as a trade from ${short(S)}.`);
    expect(cards(c, 'How each lens reads First #7').get('Round trips')!.textContent).toContain(NOT_CAUGHT.A);
  });

  it('tells an escrow by one helper, so the page keeps no list of custodians beside views.ts', async () => {
    const { inEscrow } = await import('@/lib/views');
    expect([BLEND, S, ZERO_ADDRESS].map(inEscrow)).toEqual([true, false, false]);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('apps/web/app/tx/[chain]/[hash]/page.tsx', 'utf8')).not.toMatch(/CUSTODIANS|ESCROWS/);
  });

  it('a custody leg a lens did flag keeps its cards and its loop', async () => {
    // S → Blend → B is the trade S → B; then B and S trade it back and forth, so the trade sits in Round trips' pattern.
    const rows = [
      transfer(A1, '7', '0x01', 0, 3, [], S, BLEND, null), transfer(A1, '7', TX, 5, 4, [], BLEND, B, null),
      transfer(A1, '7', '0x03', 0, 5, [], B, S), transfer(A1, '7', '0x04', 0, 6, [], S, B), transfer(A1, '7', '0x05', 0, 7, [], B, S),
    ];
    state.lenses = [lens(8, 'Every owner', { 1: {} }, OWNERS)];
    const { runs } = await engine(rows, 1, [[8, OWNERS]], [BLEND]);
    expect('A' in rows[1]!.flags).toBe(true);
    expect(runs[0]!.flags.map((f) => f.txHash)).toContain(TX);
    const c = await txPage();
    const card = cards(c, 'How each lens reads First #7');
    expect(card.get('Round trips')!.querySelector('figure')).not.toBeNull();
    expect(card.get('Every owner')!.querySelector('figure')).not.toBeNull();
    expect(c.textContent).not.toContain('custody, not a trade');
  });
});
