import { cleanup, fireEvent, render } from '@testing-library/react';
import { Suspense, cloneElement, isValidElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopEdge, Method, OwnFlag } from '@washtrace/detect';
import { short } from '@/lib/format';
import { EvidenceLine } from '@/components/coverage';
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
  /** Whether the collections have no analysis yet. */
  noAnalysis: false,
  /** Whether the read of a payment's uses never answers. */
  pending: false,
  lenses: [] as ReturnType<typeof lens>[],
  own: [] as OwnFlag[],
  /** The store's read of the payment with this page's hash: null when none is stored. */
  payment: null as { flows: unknown[]; usedBy: { collection: { id?: number } }[] } | null,
  /** The collections, by id, whose latest analysis was saved before witnesses were (its `loops` null). */
  preWitnesses: [] as number[],
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

function collectionRow(address: string) {
  const id = ID[address];
  if (id === undefined) return null;
  const totals = Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, { transfers: 1, flagged: 0, sales: 1, flaggedSales: 0, volumeWei: '0', flaggedVolumeWei: '0', wallets: 0, tokens: 0, available: state.ran[id]!.includes(m) }]));
  const pre = state.preWitnesses.includes(id) ? { loops: null } : {};
  return { id, chainId: 1, address, name: address === A1 ? 'First' : 'Second', latest: state.noAnalysis ? null : { id: 1, ranAt: 1_700_000_000_000, throughBlock: state.through[id], truncatedSearches: state.truncatedSearches, totals, ...pre } };
}

const flows = vi.fn(async () => [] as unknown[]);
const usedBy = vi.fn();
vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async (_chain: number, address: string) => collectionRow(address),
    collections: async () => Object.keys(ID).map(collectionRow),
    transaction: async () => state.tx,
    payment: async () => state.payment?.flows ?? null,
    paymentUsedBy: async (...args: [number, unknown[], number | null]) => { usedBy(...args); if (state.pending) await new Promise(() => {}); return (state.payment?.usedBy ?? []).filter((u) => args[2] === null || u.collection.id === args[2]); },
    ringLines: async (_id: number, anchors: string[]) => anchors.map((anchor) => ({ anchor, rank: 3, floorSales: 0 })),
    lenses: async () => state.lenses.map((l) => ({ id: l.id, key: `L${l.id}` as const, name: l.name, rule: l.rule, version: l.version, createdAt: 0, updatedAt: 0 })),
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
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'localhost:8080' }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, redirect: (to: string) => { throw new Error(`redirect:${to}`); }, useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  flows.mockClear();
  usedBy.mockClear();
  Object.assign(state, { tx: [], tokens: {}, ran: { 1: ['A', 'AU', 'AC'], 2: ['A', 'AU', 'AC'] }, through: { 1: 10, 2: 10 }, truncatedSearches: 0, noAnalysis: false, pending: false, lenses: [], own: [], payment: null, preWitnesses: [] });
});

/**
 * The tree as the test renderer can draw it, which cannot draw a server component inside Suspense: the payment view's
 * two streamed parts (PaymentUses, GlobalUses) are either read, and replaced by what they return, or, with `read`
 * false, left pending, as the browser first gets the page: their Suspense is replaced by its fallback.
 */
async function settled(node: unknown, read = true): Promise<ReactNode> {
  const { PaymentUses, GlobalUses } = await import('@/app/c/[chain]/[address]/tx/[hash]/payment');
  const go = async (n: unknown): Promise<ReactNode> => {
    if (Array.isArray(n)) return Promise.all(n.map(go));
    if (!isValidElement(n)) return n as ReactNode;
    const props = n.props as { children?: unknown; fallback?: ReactNode };
    const only = isValidElement(props.children) ? props.children.type : null;
    if (n.type === Suspense && (only === PaymentUses || only === GlobalUses)) {
      return read ? go(await (only as (p: unknown) => Promise<unknown>)((props.children as { props: unknown }).props)) : props.fallback;
    }
    return props.children === undefined ? n : cloneElement(n, undefined, await go(props.children));
  };
  return go(node);
}

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
/**
 * The one graph of `title`'s token, lit for lens `name`: its switch pressed when it has one. Null when
 * that lens lights no loop there. The cards are words only; the token's graph is drawn once a transfer.
 */
function graph(c: HTMLElement, title: string, name: string): HTMLElement | null {
  const section = [...c.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === title);
  const root = section?.querySelector<HTMLElement>('[data-lens-graph]') ?? null;
  if (root === null) return null;
  const press = [...root.querySelectorAll('button')].find((b) => b.textContent === name);
  if (press !== undefined) fireEvent.click(press);
  return root.querySelector(`svg[aria-label="The loop ${name} caught, lit in this token’s graph"]`) === null ? null : root;
}
const openHref = (el: HTMLElement) => [...el.querySelectorAll('a')].find((x) => x.textContent === 'Open it in the token’s graph →')?.getAttribute('href');

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
  it('draws the evidence of each built-in that caught the trade, in its card, and nothing in the card of one that did not or of a lens of yours', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    state.own = [caughtOwn(7)];
    const card = cards(await txPage(), 'How each lens reads First #7');
    // Round trips caught it as a loop of two wallets; the others' cards, and yours, hold no witness to draw.
    expect(card.get('Round trips')!.querySelector('svg[role=img]')!.getAttribute('aria-label')).toBe('The token went round 2 wallets, 2 cycles');
    expect(card.get('Linked wallets')!.querySelector('svg[role=img]')).toBeNull();
    expect(card.get('Fast flips')!.querySelector('svg[role=img]')).toBeNull();
  });

  it("a caught trade's loop is lit in the token's one graph, for a built-in and for a lens of yours", async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    // The lens catches an earlier trade of the token too, so its loop for this trade is not its first.
    state.own = [{ ...caughtOwn(7), txHash: '0x01', logIndex: 0 }, caughtOwn(7)];
    const c = await txPage();
    const card = cards(c, 'How each lens reads First #7');
    const title = 'How each lens reads First #7';
    // A lens caught it, so the graph is drawn and the lead points to it.
    expect(c.textContent).toContain('the token’s graph below lights the loop of each that caught it.');
    // One graph for the token, not one a card.
    expect([...c.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === title)!.querySelectorAll('figure')).toHaveLength(1);
    expect(c.querySelectorAll('li[data-lens] figure')).toHaveLength(0);
    expect(card.get('Round trips')!.textContent).toContain('2 wallets pass it round in 2 cycles');
    expect(card.get('Fast flips')!.textContent).toContain('Back to the seller through 1 wallet, 2 by money');
    // Round trips' one pattern holds all three of the token's transfers; it is lit first.
    const a = graph(c, title, 'Round trips')!;
    expect(lit(a)).toEqual(['t0', 't1', 't2']);
    expect(openHref(a)).toBe(`/c/1/${A1}/t/7?loop=r0`);
    // Fast flips' loop for this trade (o1): the trade's arrow and the way back through the middle.
    const own = graph(c, title, 'Fast flips')!;
    expect(lit(own)).toEqual(['o1e1', 'o1e2', 't2']);
    expect(openHref(own)).toBe(`/c/1/${A1}/t/7?loop=o1`);
  });

  it('each lens’s loop key lights the same loop on the token page', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} }), lens(8, 'Slow loops', { 1: {} })];
    state.own = [{ ...caughtOwn(8), txHash: '0x01', logIndex: 0 }, caughtOwn(7), caughtOwn(8)];
    const c = await txPage();
    const keys: string[] = [];
    for (const name of cards(c, 'How each lens reads First #7').keys()) {
      const g = graph(c, 'How each lens reads First #7', name);
      if (g === null) continue;
      const loop = new URL(openHref(g)!, 'http://x').searchParams.get('loop')!;
      keys.push(loop);
      const onTrade = lit(g);
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
    // And the lead says no graph is below.
    expect(c.textContent).toContain('why it caught this transfer or why not.');
    expect(c.textContent).not.toContain('graph below');
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
    const { OWN_NOT_CAUGHT, CAPPED } = await import('@/lib/format');
    const { OWN_BEFORE_EDIT } = await import('@/lib/lens-state');
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
    const { OWN_BEFORE_EDIT } = await import('@/lib/lens-state');
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

  it('an unread transaction, or one not judged, says "Not judged yet" once: the answer\'s title, no chip over it', async () => {
    const text = (await txPage()).textContent ?? '';
    expect(text.split('Not judged yet').length - 1).toBe(1);
    roundTrip([]);
    state.through = { 1: 4, 2: 4 };
    const c = await txPage();
    expect(c.querySelector('header .chip')).toBeNull();
    expect(c.querySelector('p.text-lg')!.textContent).toBe('Not judged yet');
  });

  it('a trade flagged only by the lens not counted names it, and no place on the screen', async () => {
    roundTrip(['AU']);
    const body = (await txPage()).querySelector('p.text-lg')!.nextElementSibling!.textContent!;
    expect(body).toContain('Only Money loops back flags it:');
    expect(body).not.toContain('on the right');
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
    expect([...first.keys()]).toEqual(['Round trips', 'Linked wallets', 'Money loops back', 'Fast flips']);
    expect([...second.keys()]).toEqual(['Round trips', 'Linked wallets', 'Money loops back', 'Fast flips']);
    expect(graph(c, 'How each lens reads First #7', 'Fast flips')).not.toBeNull();
    // A flag stored on a collection the lens never ran on is not read as a catch.
    expect(second.get('Fast flips')!.textContent).toContain('Fast flips has not run on this collection, so it flags nothing yet.');
    expect(graph(c, 'How each lens reads Second #8', 'Fast flips')).toBeNull();
    expect(second.get('Round trips')!.textContent).toContain(NOT_CAUGHT.A);
    expect(second.get('Linked wallets')!.textContent).toContain('Linked wallets did not run in the latest analysis, so it flags nothing.');
    // Each card's lens name opens that lens's tab on its own collection.
    const tab = (li: HTMLElement, name: string) => [...li.querySelectorAll('a')].find((x) => x.textContent === name)?.getAttribute('href');
    expect(tab(first.get('Round trips')!, 'Round trips')).toBe(`/c/1/${A1}/methods?method=A#evidence`);
    expect(tab(second.get('Round trips')!, 'Round trips')).toBe(`/c/1/${A2}/methods?method=A#evidence`);
  });

  it('across two collections, the answer names the one whose latest analysis missed a lens, never that a lens it names as flagging flags nothing', async () => {
    // No key: the first collection's stored trail runs Money loops back, which flags its sale; the second's analysis runs neither money lens.
    roundTrip(['A', 'AU']);
    const other = transfer(A2, '8', TX, 9, 5);
    state.tokens[`${A2}/8`] = [other];
    state.tx = [...state.tx, other];
    state.ran = { 1: ['A', 'AU', 'AC'], 2: ['A'] };
    const c = await txPage();
    const body = c.querySelector('p.text-lg')!.nextElementSibling!.textContent!;
    // The flagging lenses by name, not by where they sit: beside the answer on a wide screen, under it on a phone.
    expect(body).toContain('Round trips flags it.');
    expect(body).not.toMatch(/on the right|below it|beside it/);
    // Floor, ceiling, then the one not counted, as every page lists lenses; the API keeps A, AU, AC.
    expect(body).toContain('Linked wallets and Money loops back did not run in the latest analysis of Second, so they flag nothing there.');
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
    expect(body).toContain('Linked wallets and Money loops back did not run in the latest analysis, so they flag nothing.');
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
      expect([...li.querySelectorAll('a')].find((x) => x.textContent === link)?.getAttribute('href')).toBe(`/c/1/${A1}/methods?method=${key}`);
    }
    const why = (li: HTMLElement) => [...li.querySelectorAll('a')].find((x) => x.textContent === 'See why on its tab →')?.getAttribute('href');
    for (const [m, name] of [['AU', 'Money loops back'], ['AC', 'Linked wallets']] as const) {
      const li = card.get(name)!;
      expect(li.textContent).toContain(`${name} did not run in the latest analysis, so it flags nothing.`);
      expect(li.textContent).not.toContain(NOT_CAUGHT[m]);
      expect(why(li)).toBe(`/c/1/${A1}/methods?method=${m}`);
    }
  });

  it('a sale only your lens caught: the verdict stays the built-ins’, and names the lens of yours that caught it', async () => {
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

  it('lists the counted lenses that flag it first, each with its tier, and sets Money loops back apart under them as not counted', async () => {
    roundTrip(['A', 'AU', 'AC']);
    const c = await txPage();
    const aside = c.querySelector('p.text-lg')!.closest('div')!.parentElement!.lastElementChild!;
    expect([...aside.children].map((x) => x.textContent)).toEqual(['Round trips · the floor', 'Linked wallets · the ceiling', 'Money loops back · not counted']);
  });

  it('gives every built-in\'s card its tier, and a lens of yours none', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    const c = await txPage();
    const tiers = [...cards(c, 'How each lens reads First #7')].map(([name, li]) => [name, li.querySelector('[data-tier]')?.textContent ?? null]);
    expect(tiers).toEqual([['Round trips', '· the floor'], ['Linked wallets', '· the ceiling'], ['Money loops back', '· not counted'], ['Fast flips', null]]);
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
    expect(chips).toEqual([['Round trips', `/c/1/${A1}/methods?method=A#evidence`], ['Fast flips', `/c/1/${A1}/methods?method=L7#evidence`]]);
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

  it('the graph has its own arrow markers, and says whose loop it lights', async () => {
    roundTrip();
    state.lenses = [lens(7, 'Fast flips', { 1: {} })];
    state.own = [caughtOwn(7)];
    const c = await txPage();
    const ids = [...c.querySelectorAll('marker')].map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    // Every arrowhead names a marker of its own figure.
    for (const svg of c.querySelectorAll('figure svg')) {
      const own = new Set([...svg.querySelectorAll('marker')].map((m) => m.id));
      for (const p of svg.querySelectorAll('path[marker-end]')) expect(own.has(p.getAttribute('marker-end')!.slice(5, -1))).toBe(true);
    }
    const labels = () => [...c.querySelectorAll('[data-lens-graph] svg[aria-label]')].map((s) => s.getAttribute('aria-label'));
    expect(labels()).toEqual(['The loop Round trips caught, lit in this token’s graph']);
    expect(graph(c, 'How each lens reads First #7', 'Fast flips')).not.toBeNull();
    expect(labels()).toEqual(['The loop Fast flips caught, lit in this token’s graph']);
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
    const a = graph(c, 'How each lens reads First #7', 'Round trips')!;
    expect(a).not.toBeNull();
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
 * A transfer a lens does not judge never gets that lens's "not
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
    const { analyze, Payments } = await import('@washtrace/detect');
    const { Moves } = await import('../../../packages/detect/src/moves');
    const { runLens } = await import('../../../packages/detect/src/lens');
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
    const c = await txPage();
    const card = cards(c, 'How each lens reads First #7');
    expect(card.get('Fast flips')!.textContent).toContain('Not judged: Fast flips judges sales only, and this transfer is not a sale.');
    expect(card.get('Fast flips')!.textContent).not.toContain(OWN_NOT_CAUGHT);
    expect(graph(c, 'How each lens reads First #7', 'Every owner')).not.toBeNull();
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
    expect(card.get('Round trips')).toBeDefined();
    expect(graph(c, 'How each lens reads First #7', 'Round trips')).not.toBeNull();
    expect(graph(c, 'How each lens reads First #7', 'Every owner')).not.toBeNull();
    expect(c.textContent).not.toContain('custody, not a trade');
  });
});

describe('the trade page: the payments behind each lens card', () => {
  const M = '0x' + '7'.repeat(40);
  const PAY = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(32);
  const pay = (n: number, from: string, to: string, more: object = {}) => ({ txHash: PAY(n), kind: 'native', from, to, valueWei: '1000000000000000000', token: '', blockNumber: n, blockTime: 1_700_000_000 + n, ...more });
  const pair = { kind: 'pair', pair: [S, B], middle: M, flowTx: PAY(2), shape: 'funder' };
  const loop = { kind: 'scc+flow', wallets: [S, B], cycles: 1, via: [[B, S]], paths: [{ wallets: [B, W, S], txs: [PAY(5), PAY(6)] }] };
  /** Token 7, its one sale caught by `flags`, whose drawing holds `paid`. */
  async function caught(flags: Record<string, unknown>, paid: object[]) {
    const row = Object.assign(transfer(A1, '7', TX, 5, 5), { flags });
    state.tokens[`${A1}/7`] = [row];
    state.tx = [row];
    flows.mockImplementation(async () => paid);
    const c = await txPage();
    flows.mockImplementation(async () => []);
    return cards(c, 'How each lens reads First #7');
  }
  const rows = (li: HTMLElement) => [...li.querySelectorAll('[data-payment]')];

  it('Linked wallets lists its legs with the named one marked, and links each to the payment view carrying the lens', async () => {
    // A pair no lens uses, and a zero value on a real leg, are not evidence.
    const card = await caught({ AC: pair }, [pay(1, M, S), pay(2, M, B), pay(3, S, W), pay(4, S, M, { valueWei: '0' })]);
    const li = card.get('Linked wallets')!;
    expect(rows(li).map((r) => r.querySelector('a[href*="/tx/"]')?.textContent)).toEqual([`payment ${short(PAY(1))}`, `payment ${short(PAY(2))}`]);
    expect(rows(li)[0]!.textContent).toContain('(funder) → ');
    expect(rows(li)[0]!.textContent).toContain('(seller)');
    expect(rows(li)[0]!.textContent).not.toContain('the one the lens names');
    expect(rows(li)[1]!.textContent).toContain('the one the lens names');
    expect(rows(li)[1]!.querySelector('a[href*="/tx/"]')!.getAttribute('href')).toBe(`/c/1/${A1}/tx/${PAY(2)}?method=AC`);
    expect(li.querySelector('h3')!.textContent).toBe('The payments it used');
    // The lens section already moves up below lg; within it the cards keep the lens order.
    expect(li.className).not.toContain('order-first');
    // jsdom applies no media query, so the order classes carry the phone layout: the lens section is ordered before the rail and the table, in one flex column.
    const orderOf = (el: Element | null) => [...(el?.closest('[class*="max-lg:order-"]')?.classList ?? [])].find((c) => c.startsWith('max-lg:order-'));
    const lens = li.closest('section')!;
    const moved = [...document.querySelectorAll('section')].find((x) => x.querySelector('h2')?.textContent === 'What it moved')!;
    expect(orderOf(lens)).toBe('max-lg:order-1');
    expect(orderOf(moved)).toBe('max-lg:order-2');
    expect(lens.closest('[class*="max-lg:order-"]')!.parentElement).toBe(moved.closest('[class*="max-lg:order-"]')!.parentElement);
    expect(lens.closest('[class*="max-lg:order-"]')!.parentElement!.className).toContain('max-lg:flex-col');
    expect(card.get('Round trips')!.querySelector('[data-payment]')).toBeNull();
    expect(card.get('Money loops back')!.querySelector('[data-payment]')).toBeNull();
  });

  it('Money loops back lists its direct payment back and its path steps, never numbered or as a step’s payment', async () => {
    const card = await caught({ AU: loop }, [pay(1, B, S), pay(5, B, W), pay(6, W, S), pay(7, S, B)]);
    const li = card.get('Money loops back')!;
    expect(rows(li)).toHaveLength(3);
    expect(li.textContent).not.toMatch(/\b1\. |the payment of|the one the lens names/);
    // Each row carries its own card's lens, whatever lens the page was opened with.
    expect(rows(li).map((r) => r.querySelector('a[href*="/tx/"]')!.getAttribute('href'))).toEqual([PAY(1), PAY(5), PAY(6)].map((h) => `/c/1/${A1}/tx/${h}?method=AU`));
    expect(li.className).not.toContain('order-first');
    expect(card.get('Linked wallets')!.querySelector('[data-payment]')).toBeNull();
  });

  it('lists at most four, then how many more with a link to the wallet page’s between section', async () => {
    const card = await caught({ AC: pair }, [1, 2, 3, 4, 5, 6].map((n) => pay(n, M, S)));
    const li = card.get('Linked wallets')!;
    expect(rows(li)).toHaveLength(4);
    expect(li.textContent).toContain('and 2 more.');
    const more = [...li.querySelectorAll('a')].find((a) => a.textContent?.startsWith('Payments between'))!;
    expect(more.getAttribute('href')).toBe(`/c/1/${A1}/w/${M}?with=${S}&method=AC#between`);
    expect(more.getAttribute('href')).not.toContain('from=');
  });

  it('"and n more" counts only the pair it opens, and says how many are not listed', async () => {
    const card = await caught({ AC: pair }, [1, 2, 3, 4].map((n) => pay(n, M, S)).concat([pay(5, M, B), pay(6, S, M), pay(7, B, M)]));
    const li = card.get('Linked wallets')!;
    expect(rows(li)).toHaveLength(4);
    expect(li.textContent).toContain('and 3 more.');
    const more = [...li.querySelectorAll('a')].find((a) => a.textContent?.includes('of them are between'))!;
    expect(more.textContent).toBe(`2 of them are between ${short(M)} and ${short(B)} →`);
    expect(more.getAttribute('href')).toBe(`/c/1/${A1}/w/${M}?with=${B}&method=AC#between`);
    expect(li.textContent).toContain('and 1 more not listed here.');
  });

  it('Money loops back with none of its payments drawn says they are not drawn here, and names no place for them', async () => {
    const card = await caught({ AU: loop }, []);
    const li = card.get('Money loops back')!;
    expect(li.textContent).toContain('Its payments are not drawn here.');
    expect(li.textContent).not.toContain('Who did it move money with');
  });

  it('a payment both lenses use is listed in both cards; an old loop with no paths lists its via legs only; a pair with no shape lists its legs', async () => {
    const old = { kind: 'scc+flow', wallets: [S, B], cycles: 1, via: [[M, S]] };
    const unshaped = { kind: 'pair', pair: [S, B], middle: M, flowTx: PAY(1) };
    const card = await caught({ AC: unshaped, AU: old }, [pay(1, M, S), pay(2, B, W)]);
    for (const name of ['Linked wallets', 'Money loops back']) {
      expect(rows(card.get(name)!).map((r) => r.querySelector('a[href*="/tx/"]')!.textContent)).toEqual([`payment ${short(PAY(1))}`]);
    }
    expect(rows(card.get('Linked wallets')!)[0]!.textContent).toContain('(in between) → ');
  });

  it('a payment row never wears gold or magenta, and a caught card with none read says where they are', async () => {
    const full = await caught({ AC: pair }, [pay(1, M, S)]);
    expect(rows(full.get('Linked wallets')!)[0]!.outerHTML).not.toMatch(/ceiling|fault|gold|magenta/);
    cleanup();
    const none = await caught({ AC: pair }, []);
    expect(none.get('Linked wallets')!.textContent).toContain('They are not drawn here.');
    expect(none.get('Linked wallets')!.textContent).toContain('Who did it move money with');
  });
});

describe('the trade page: a spot check', () => {
  it('an unread transaction offers the check; a judged one does not', async () => {
    const unread = await txPage();
    expect(unread.querySelector('#spot-check')?.textContent).toBe('Check this transaction');
    cleanup();
    roundTrip();
    const judged = await txPage();
    expect(judged.querySelector('#spot-check')).toBeNull();
  });

  it('sets the check in a card of its own, and the parent line above the head, as a collection page has it', async () => {
    const c = await txPage();
    expect(c.querySelector('#spot-check')!.closest('section')!.className).toMatch(/\brounded-lg border bg-card\b/);
    const up = [...c.querySelectorAll('a')].find((a) => a.textContent === 'Collections')!;
    expect(up.getAttribute('href')).toBe('/');
    expect(up.closest('header')).toBeNull();
    expect(up.parentElement!.nextElementSibling?.tagName).toBe('HEADER');
  });
});

/** Every element of `type` in a page's tree, through every prop: the panels read in their own Suspense, so the tree is where they show. */
function elementsOf(node: unknown, type: unknown): { props: Record<string, unknown> }[] {
  const out: { props: Record<string, unknown> }[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!isValidElement(n)) return;
    if (n.type === type) out.push(n as { props: Record<string, unknown> });
    Object.values(n.props as Record<string, unknown>).forEach(walk);
  };
  walk(node);
  return out;
}

describe('the trade page outside a collection\'s tabs', () => {
  async function tree() {
    const { default: P } = await import('@/app/tx/[chain]/[hash]/page');
    return P({ params: Promise.resolve({ chain: '1', hash: TX }) });
  }

  it('in one collection: its ring chips, strip and Connected to are that collection\'s, and it opens under its tabs', async () => {
    roundTrip();
    const t = await tree();
    const { RingChips } = await import('@/components/rings');
    const { WhereItSits } = await import('@/components/sales-strip');
    const { ConnectedRail } = await import('@/components/connected-rail');
    for (const type of [RingChips, WhereItSits]) expect(elementsOf(t, type).map((e) => [e.props.address, e.props.of])).toEqual([[A1, { tx: TX }]]);
    expect(elementsOf(t, ConnectedRail).map((e) => [e.props.address, e.props.token, e.props.wallets]))
      .toEqual([[A1, '7', [{ address: S, role: 'seller' }, { address: B, role: 'buyer' }]]]);
    const link = [...render(t).container.querySelectorAll('a')].find((a) => a.textContent === 'Open in First →');
    expect(link?.getAttribute('href')).toBe(`/c/1/${A1}/tx/${TX}`);
  });

  it('ends its answer with the evidence line over its seller and buyer, as of its latest block; across several collections it has none', async () => {
    roundTrip();
    const one = elementsOf(await tree(), EvidenceLine);
    expect(one.map((e) => [e.props.chainId, e.props.home, e.props.wallets, e.props.block])).toEqual([[1, A1, [S, B], 5]]);
    state.tx = [transfer(A1, '7', TX, 5, 5), transfer(A2, '8', TX, 9, 5)];
    expect(elementsOf(await tree(), EvidenceLine)).toEqual([]);
  });

  it('names no one on Connected to for a payment no lens used', async () => {
    roundTrip();
    const F = '0x' + '3'.repeat(40);
    flows.mockResolvedValueOnce([{ txHash: '0xf1', kind: 'native', from: F, to: S, valueWei: '1', token: '', blockNumber: 2, blockTime: null }]);
    const t = await tree();
    const { ConnectedRail } = await import('@/components/connected-rail');
    expect(elementsOf(t, ConnectedRail).map((e) => e.props.wallets))
      .toEqual([[{ address: S, role: 'seller' }, { address: B, role: 'buyer' }]]);
  });

  it('in several collections: no one collection\'s panels, and each collection a link', async () => {
    state.tx = [transfer(A1, '7', TX, 5, 5), transfer(A2, '8', TX, 9, 5)];
    const t = await tree();
    const { ConnectedRail } = await import('@/components/connected-rail');
    const { WhereItSits } = await import('@/components/sales-strip');
    expect([...elementsOf(t, ConnectedRail), ...elementsOf(t, WhereItSits)]).toEqual([]);
    const nav = render(t).container.querySelector('nav[aria-label="Its collections"]')!;
    expect([...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['First', `/c/1/${A1}`], ['Second', `/c/1/${A2}`]]);
  });

  it('unread: no panels and no way in', async () => {
    const t = await tree();
    const { ConnectedRail } = await import('@/components/connected-rail');
    expect(elementsOf(t, ConnectedRail)).toEqual([]);
    expect(render(t).container.textContent).not.toContain('Open in');
  });
});

describe('the trade page\'s parent line', () => {
  it('names its one collection after "/", above the head', async () => {
    roundTrip();
    const c = await txPage();
    const line = [...c.querySelectorAll('a')].find((a) => a.textContent === 'Collections')!.parentElement!;
    // The page itself ends the line, as plain text.
    expect(line.textContent).toMatch(/^Collections\/First\/0x/);
    expect([...line.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/', `/c/1/${A1}`]);
    expect(c.querySelector('header nav[aria-label="Trail"]')).toBeNull();
  });
});

describe('a transaction under a collection\'s tabs', () => {
  const under = async (address: string) => {
    const { default: P } = await import('@/app/c/[chain]/[address]/tx/[hash]/page');
    return render(await P({ params: Promise.resolve({ chain: '1', address, hash: TX }) })).container;
  };

  it('sits there when every transfer it moved is in that collection, its links kept inside', async () => {
    state.tx = [transfer(A1, '5', TX, 0, 5)];
    const hrefs = [...(await under(A1)).querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`/c/1/${A1}/w/${S}`);
    expect(hrefs).toContain(`/c/1/${A1}/tx/${TX}`);
  });

  it('is sent to its own page when it is another collection\'s, or more than one\'s, or unread', async () => {
    state.tx = [transfer(A2, '5', TX, 0, 5)];
    await expect(under(A1)).rejects.toThrow(`redirect:/tx/1/${TX}`);
    state.tx = [transfer(A1, '5', TX, 0, 5), transfer(A2, '6', TX, 1, 5)];
    await expect(under(A1)).rejects.toThrow(`redirect:/tx/1/${TX}`);
    state.tx = [];
    await expect(under(A1)).rejects.toThrow(`redirect:/tx/1/${TX}`);
  });
});

describe('a payment a lens cites', () => {
  const M = '0x' + '7'.repeat(40);
  const flow = (more: object = {}) => ({ txHash: TX, kind: 'native', from: M, to: S, valueWei: '1000000000000000000', token: '', blockNumber: 12, blockTime: 1_700_000_000, ...more });
  const pair = { kind: 'pair', pair: [S, B], middle: M, flowTx: TX, shape: 'funder' };
  const loop = { kind: 'scc+flow', wallets: [S, B], cycles: 1, via: [[M, S]], paths: [{ wallets: [M, W, S], txs: [TX, '0x2'] }] };
  const used = (use: object, witness: object, more: object = {}, address = A1) => ({
    collection: { id: ID[address], address, name: address === A1 ? 'First' : 'Second' }, use, witness, ring: null, more: false,
    sales: [{ txHash: '0x' + 'a'.repeat(64), logIndex: 0, tokenId: '114' }], ...more,
  });
  const under = async (address = A1) => {
    const { default: P } = await import('@/app/c/[chain]/[address]/tx/[hash]/page');
    return render(await settled(await P({ params: Promise.resolve({ chain: '1', address, hash: TX }), searchParams: Promise.resolve({ method: 'AC' }) }))).container;
  };
  /** The global page, its streamed part read. */
  const global = async () => {
    const { default: P } = await import('@/app/tx/[chain]/[hash]/page');
    return render(await settled(await P({ params: Promise.resolve({ chain: '1', hash: TX }) }))).container;
  };
  /** The same page as the browser first gets it: the streamed part still pending. */
  const first = async (address = A1) => {
    const { default: P } = await import('@/app/c/[chain]/[address]/tx/[hash]/page');
    return render(await settled(await P({ params: Promise.resolve({ chain: '1', address, hash: TX }) }), false)).container;
  };
  const hrefs = (c: HTMLElement) => [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));

  it('opens a view of itself under the collection’s tabs, and says which lenses use it, in the console’s order, Money loops back not counted', async () => {
    state.payment = {
      flows: [flow()],
      usedBy: [used({ method: 'AU', back: [M, S] }, loop), used({ method: 'AC', named: true }, pair, { ring: 'r0', more: true })],
    };
    const c = await under();
    expect(c.querySelector('h1')?.textContent).toBe(short(TX));
    expect(c.textContent).toContain('1 ETH from 0x7777…7777 to 0x1111…1111');
    expect(c.textContent).not.toContain('has not read it');
    expect(c.querySelector('#spot-check')).toBeNull();
    const lines = [...c.querySelectorAll('section li')].map((li) => li.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Used by Linked wallets to flag the sales of #114 and others, in .*Ring 3: .*both funded by .*It is the one the lens names\.$/);
    expect(lines[1]).toMatch(/^Used by Money loops back \(not counted\) to flag the sale of #114: It is a payment back from 0x7777…7777 to 0x1111…1111\.$/);
    // Every link stays under the collection's tabs and keeps the lens it came with; no word of time order is said.
    expect(hrefs(c)).toContain(`/c/1/${A1}/methods?method=AC#evidence`);
    expect(hrefs(c)).toContain(`/c/1/${A1}/tx/0x${'a'.repeat(64)}?method=AC`);
    expect(hrefs(c)).toContain(`/c/1/${A1}/w/${M}?method=AC`);
    expect(hrefs(c)).toContain(`/c/1/${A1}/r/r0?method=AC`);
    expect(hrefs(c).filter((h) => h?.startsWith('/tx/'))).toEqual([]);
    expect(c.textContent).not.toMatch(/\b(before|after|first|then)\b/i);
  });

  it('says a Money loops back payment on a path is on the money back, never that it is the payment of a step', async () => {
    state.payment = { flows: [flow({ from: M, to: W })], usedBy: [used({ method: 'AU', back: [M, S] }, loop)] };
    const c = await under();
    expect(c.querySelector('section li')?.textContent).toMatch(/It is on a money path back from 0x7777…7777 to 0x1111…1111\.$/);
  });

  it('shows several transfers as a table, and a payment no lens uses as money none cites', async () => {
    state.payment = { flows: [flow(), flow({ kind: 'internal', valueWei: '5' })], usedBy: [] };
    const c = await under();
    expect(c.querySelector('p.text-lg')?.textContent).toBe('A payment of 2 transfers between 2 wallets');
    expect(c.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(c.textContent).toContain('Round trips, Linked wallets and Money loops back don’t use this payment in First’s latest analysis (');
    expect(c.textContent).not.toContain('No lens');
    expect(c.textContent).not.toContain('has not read it');
  });

  it('says an analysis saved before witnesses cannot tell which lenses use it, never that none does', async () => {
    state.payment = { flows: [flow()], usedBy: [] };
    state.preWitnesses = [1];
    const c = await under();
    expect(c.textContent).toContain('The latest analysis predates this view; the next analysis will say which lenses use it.');
    expect(c.textContent).not.toContain('don’t use this payment');
  });

  it('names only this collection’s lenses on the page under its tabs', async () => {
    state.payment = { flows: [flow()], usedBy: [used({ method: 'AC', named: false }, pair, {}, A2)] };
    const c = await under();
    expect(c.textContent).toContain('Round trips, Linked wallets and Money loops back don’t use this payment in First’s latest analysis');
  });

  it('says a collection with no analysis has not been analyzed, never that its latest analysis misses the payment', async () => {
    state.payment = { flows: [flow()], usedBy: [] };
    state.noAnalysis = true;
    const c = await under();
    expect(c.textContent).toContain('First has not been analyzed yet.');
    expect(c.textContent).not.toContain('latest analysis');
  });

  it('is a sale’s page, never the payment view, when the hash moves a token of this collection, even with another collection’s in the same transaction', async () => {
    state.payment = { flows: [flow()], usedBy: [] };
    state.tx = [transfer(A1, '5', TX, 0, 5), transfer(A2, '6', TX, 1, 5)];
    await expect(under()).rejects.toThrow(`redirect:/tx/1/${TX}`);
    state.tx = [transfer(A1, '5', TX, 0, 5)];
    expect((await under()).textContent).not.toContain('Payment on');
    // A sale page reads no payment's uses, and its tab title reads only the probe.
    expect(usedBy).not.toHaveBeenCalled();
    const { generateMetadata } = await import('@/app/c/[chain]/[address]/tx/[hash]/page');
    expect((await generateMetadata({ params: Promise.resolve({ chain: '1', address: A1, hash: TX }) })).alternates?.canonical).toBe(`/tx/1/${TX}`);
    expect(usedBy).not.toHaveBeenCalled();
  });

  it('names the other collection whose sale the hash is, and links its page', async () => {
    state.payment = { flows: [flow()], usedBy: [] };
    state.tx = [transfer(A2, '6', TX, 1, 5)];
    const c = await under();
    expect(c.textContent).toContain('Payment on');
    const open = [...c.querySelectorAll('a')].find((a) => a.textContent?.startsWith('Open in'));
    expect([open?.textContent, open?.getAttribute('href')]).toEqual(['Open in Second →', `/c/1/${A2}/tx/${TX}`]);
  });

  it('shows the payment at once, the lenses that use it still being looked for', async () => {
    state.payment = { flows: [flow()], usedBy: [] };
    state.pending = true;
    try {
      const { default: Global } = await import('@/app/tx/[chain]/[hash]/page');
      const pages = [() => first(), async () => render(await settled(await Global({ params: Promise.resolve({ chain: '1', hash: TX }) }), false)).container];
      for (const open of pages) {
        const c = await open();
        expect(c.textContent).toContain('0x7777…7777');
        expect(c.textContent).toContain('1 ETH');
        expect(c.textContent).toContain('Looking for the lenses that use it…');
        expect(c.textContent).not.toContain('latest analysis');
        cleanup();
      }
    } finally { state.pending = false; }
  });

  it('is sent to its own page only when no payment is stored with its hash', async () => {
    state.payment = null;
    await expect(under()).rejects.toThrow(`redirect:/tx/1/${TX}`);
  });

  it('is its own canonical page, where a sale’s is the transaction’s', async () => {
    const { generateMetadata } = await import('@/app/c/[chain]/[address]/tx/[hash]/page');
    const meta = () => generateMetadata({ params: Promise.resolve({ chain: '1', address: A1, hash: TX }) });
    state.payment = { flows: [flow()], usedBy: [] };
    expect((await meta()).alternates?.canonical).toBe(`/c/1/${A1}/tx/${TX}`);
    state.tx = [transfer(A1, '5', TX, 0, 5)];
    expect((await meta()).alternates?.canonical).toBe(`/tx/1/${TX}`);
    state.payment = null;
    state.tx = [];
    expect((await meta()).alternates?.canonical).toBe(`/tx/1/${TX}`);
  });

  it('reads as a payment washtrace read as money on the global page: the collections that use it, and no spot check', async () => {
    state.payment = { flows: [flow()], usedBy: [used({ method: 'AC', named: true }, pair), used({ method: 'AU', back: [M, S] }, loop, {}, A2)] };
    const c = await global();
    expect(c.querySelector('p.text-lg')?.textContent).toBe('A payment washtrace read as money');
    expect(c.textContent).toContain('It is not a token transfer.');
    expect(c.textContent).toContain('2 watched collections have a lens that uses it: First and Second.');
    expect(c.textContent).not.toContain('has not read it');
    expect(c.querySelector('#spot-check')).toBeNull();
    const open = [...c.querySelectorAll('nav[aria-label="Its collections"] a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(open).toEqual([['First', `/c/1/${A1}/tx/${TX}`], ['Second', `/c/1/${A2}/tx/${TX}`]]);
  });

  it('says on the global page which collections’ latest analysis predates the view, never that no watched lens uses it', async () => {
    state.payment = { flows: [flow()], usedBy: [] };
    state.preWitnesses = [2];
    const c = await global();
    expect(c.textContent).toContain('The latest analysis of Second predates this view; the next analysis will say which lenses use it.');
    expect(c.textContent).not.toContain('don’t use this payment');
  });

  it('says on the global page that no watched lens uses a payment nobody cites', async () => {
    state.payment = { flows: [flow()], usedBy: [] };
    const c = await global();
    expect(c.textContent).toContain('Round trips, Linked wallets and Money loops back don’t use this payment in any watched collection’s latest analysis.');
    expect(c.textContent).not.toContain('No lens');
    expect(c.querySelector('#spot-check')).toBeNull();
  });
});
