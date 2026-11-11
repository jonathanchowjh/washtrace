import { CUSTODIANS, EVERY, FOLLOW_FANOUT, TOKENS, WRAPPED, ZERO, entryFor, parkedOf, type AnalysisRow, type CollectionRow, type FlaggedTransfer, type Flow, type Lens, type LensRun, type OwnFlag, type Store } from '@washtrace/detect';
import { lensIdOf } from '@washtrace/detect/trades';
import type { LensRule } from '@washtrace/detect/lens-rule';
import { moneyReason, tokensReason } from '@washtrace/detect/lens-reads';
import type { Lenses } from './format';
import { pages as pagesOf, type WalletOpts } from './params';
import { authConfigured, mayWrite } from './auth';
import { analyzingOn, storedOnly, unread, type Coverage } from './coverage';
import { shareCauses, shareQualifier, staleSinceLastWrite, runStateWords, type TokensFloor } from './lens-state';
import { lensContext, ownLenses, ranFlags, verdict, type Verdict } from './metrics';
import { callsPerSecond, configFromSources, fieldViews, hopsFollowed, type SourcesConfig } from './settings';
import { pipeline } from './pipeline';
import { status, workerSilent } from './status';
import { store, storedManifest } from './store';

/**
 * Reads a page and its API route both serve, in one place, so the console
 * never shows what the API would not say; and the shaping only a page needs
 * (txView, collectionView), so its component renders what comes back.
 */

/**
 * What a token's graph is drawn from: its transfers with the flags of the
 * built-ins that ran, and your lenses' flags of it, of the lenses that ran
 * there (lensContext's `ran`). The token page and the trade page both read it
 * through drawingInputs, so layout() over it gives both the same loop keys, and
 * a trade's card opens the token page with its loop lit by ?loop=.
 */
export interface TokenDrawing {
  transfers: FlaggedTransfer[];
  /** Wallets that joined two holders by money without holding the token: AC's middles. */
  middles: string[];
  flows: Flow[];
  /** In chain order, then by lens: each one loop, drawn and said beside the built-ins'. */
  own: OwnFlag[];
}

type TokenView = {
  collection: { id: number; chainId: number; address: string; name: string | null };
  tokenId: string;
  /** Your lenses' names, for their chips and lines. */
  ownLenses: Lenses;
} & TokenDrawing & Verdict;

/** Tokens or wallets to a page in a collection's Tokens and Wallets lists, as many as a screen shows without scrolling far. */
export const LIST_PAGE = 20;

/** A collection's rings to a page, in its list and the API's, so a page number means the same rings in both. */
export const RINGS_PAGE = 20;

/** A page of each of the wallet page's lists: its trades, its money partners, and the payments between it and one of them. */
export const TRADES = 20;
export const COUNTERPARTIES = 20;
export const FLOWS = 20;

/** Each collection's latest analysis, by address, for the collections these transfers are in (null: none yet). */
async function latestByAddress(s: Store, chainId: number, transfers: readonly FlaggedTransfer[]): Promise<Map<string, AnalysisRow | null>> {
  const addresses = [...new Set(transfers.map((t) => t.collection?.address ?? ''))];
  return new Map(await Promise.all(addresses.map(async (a) => [a, (await s.collection(chainId, a))?.latest ?? null] as const)));
}

/** A token's graph from its transfers as read (`all`), keeping the built-ins that ran in `c.latest` and your lenses in `ran` (lens ids). */
async function drawingInputs(s: Store, chainId: number, c: Pick<CollectionRow, 'id' | 'latest'>, tokenId: string, all: readonly FlaggedTransfer[], ran: readonly number[]): Promise<TokenDrawing> {
  // Only the lenses that ran: the verdict, the middles and the rows all read these.
  const transfers = all.map((t) => ranFlags(t, c.latest));
  const middles = [...new Set(transfers.flatMap((t) => {
    const w = t.flags.AC;
    return w?.kind === 'pair' && w.middle !== null ? [w.middle] : [];
  }))];
  const holders = [...new Set(transfers.flatMap((t) => [t.from, t.to]))].filter((a) => a !== ZERO);
  const [flows, own] = await Promise.all([
    holders.length === 0 ? [] : s.flowsAmong(chainId, [...holders, ...middles]),
    s.lensFlagsOfToken(c.id, tokenId, ran),
  ]);
  return { transfers, middles, flows, own };
}

/** Past this many wallets a ring's loops are a tangle: its page draws who is in it instead. */
const RING_DRAWN = 25;

/**
 * A ring's loops as a token's graph draws them (layout()): each of its tokens
 * changing hands between two of its wallets, with the flags of the lenses that
 * ran, and the money among its wallets; those on none of its flagged trades
 * sit inside as middles, in between. Null past RING_DRAWN wallets, or for one with no such transfer.
 */
export async function ringDrawing(s: Store, chainId: number, c: Pick<CollectionRow, 'id' | 'latest'>, ring: { wallets: readonly { address: string; traded: boolean }[]; tokens: readonly { tokenId: string }[] }): Promise<Pick<TokenDrawing, 'transfers' | 'middles' | 'flows'> | null> {
  if (ring.wallets.length === 0 || ring.wallets.length > RING_DRAWN) return null;
  const inRing = new Set(ring.wallets.map((w) => w.address));
  // Each transfer keeps its place in its token's history (the mint is 1), so an arrow's number is the one its token page gives it.
  const all = (await Promise.all(ring.tokens.map((t) => s.token(c.id, t.tokenId)))).flatMap((h) => h.map((t, i) => ({ ...t, n: i + 1 })));
  const transfers = all.filter((t) => inRing.has(t.from) && inRing.has(t.to)).map((t) => ranFlags(t, c.latest))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  if (transfers.length === 0) return null;
  const flows = await s.flowsAmong(chainId, [...inRing]);
  return { transfers, middles: ring.wallets.filter((w) => !w.traded).map((w) => w.address), flows };
}

/** Your lenses that ran on a collection, by id: a lens of yours with no finished run there has flagged nothing on it yet. */
function ownRanIds(latest: AnalysisRow | null, runs: readonly { lens: Lens; run: LensRun | null }[]): number[] {
  return lensContext(latest, runs).ran.flatMap((k) => lensIdOf(k) ?? []);
}

/** A watched collection with no read transfer of the token: it is not there, or the history that holds it is not read yet. */
export type EmptyToken = { empty: true; c: CollectionRow };

/** One token's view, or why there is none: the collection is not watched, or none of the token's transfers is read. */
export async function tokenView(chainId: number, address: string, tokenId: string): Promise<TokenView | EmptyToken | 'not-watched'> {
  const s = store();
  const c = await s.collection(chainId, address);
  if (!c) return 'not-watched';
  const [all, runs] = await Promise.all([s.token(c.id, tokenId), s.lensRuns(c.id)]);
  if (all.length === 0) return { empty: true, c };
  const graph = await drawingInputs(s, chainId, c, tokenId, all, ownRanIds(c.latest, runs));
  return {
    collection: { id: c.id, chainId, address, name: c.name }, tokenId, ...graph, ownLenses: ownLenses(runs),
    ...verdict(graph.transfers.map((t) => ({ t, latest: c.latest }))),
  };
}

/** What GET /api/transfers answers, and the trade page's verdict: a transaction's transfers, each with the flags of the built-ins that ran on its collection. */
export type TxVerdict = {
  transfers: FlaggedTransfer[];
  /** By address: each watched collection its transfers are in, with its latest analysis (null: none yet). */
  watched: Record<string, Pick<CollectionRow, 'id' | 'name' | 'latest'>>;
} & Verdict;

/**
 * A transaction's transfers and the one verdict the page and the route both
 * give, from each collection's latest analysis. Nothing else: the route
 * returns this, so it reads nothing the page alone draws (txView).
 */
export async function txVerdict(chainId: number, tx: string): Promise<TxVerdict> {
  const s = store();
  const moved = await s.transaction(chainId, tx);
  const watched: TxVerdict['watched'] = {};
  await Promise.all([...new Set(moved.map((t) => t.collection?.address ?? ''))].map(async (address) => {
    const c = await s.collection(chainId, address);
    if (c) watched[address] = c;
  }));
  const rows = moved.map((t) => ({ t, latest: watched[t.collection?.address ?? '']?.latest ?? null }));
  // Rows carry only the lenses that ran, so the API and the page never name one that did not.
  return { ...verdict(rows), transfers: rows.map((r) => ranFlags(r.t, r.latest)), watched };
}

/** A watched collection a transaction moved tokens of, with what its lens cards read. */
export interface TxCollection {
  id: number; chainId: number; address: string; name: string | null;
  /** Its latest analysis (null: none yet): which built-ins ran, and through which block they judged. */
  latest: AnalysisRow | null;
  /** Each lens of yours, with its run here or none. */
  runs: { lens: Lens; run: LensRun | null }[];
}

export type TxView = {
  /** Your lenses' catches in it, of the lenses that ran on each one's collection (lensContext's `ran`). */
  own: OwnFlag[];
  /** By address: each collection its transfers are in. */
  collections: Record<string, TxCollection>;
  /** Beside `transfers`: its token's graph when some lens caught it, else null, since a card that does not catch draws nothing. */
  graphs: (TokenDrawing | null)[];
  /**
   * Beside `transfers`: for a move out of custody to a wallet (outOfCustody),
   * the wallet the engine holds the token for, the one that put it in (null:
   * no move of it into custody is read before); null for any other transfer.
   */
  custody: ({ parked: string | null } | null)[];
  /** Your lenses' names, for their cards and chips. */
  ownLenses: Lenses;
} & Omit<TxVerdict, 'watched'>;

/**
 * The trade page's read: the route's verdict (txVerdict), and for its lens
 * cards what each collection ran, your lenses' catches, each caught
 * transfer's token graph and who a move out of custody is a trade from.
 */
export async function txView(chainId: number, tx: string): Promise<TxView> {
  const s = store();
  const [{ watched, ...v }, stored] = await Promise.all([txVerdict(chainId, tx), s.lensFlagsOfTx(chainId, tx)]);
  const collections: Record<string, TxCollection> = {};
  await Promise.all(Object.entries(watched).map(async ([address, c]) => {
    collections[address] = { id: c.id, chainId, address, name: c.name, latest: c.latest, runs: await s.lensRuns(c.id) };
  }));
  const collectionOf = (t: FlaggedTransfer): TxCollection | undefined => collections[t.collection?.address ?? ''];
  const ran = new Map(Object.values(collections).map((c) => [c.id, ownRanIds(c.latest, c.runs)]));
  const own = stored.filter((f) => ran.get(f.collectionId)?.includes(f.lensId) === true);
  // A token is read only when some lens caught a transfer of it here or it came out of custody, and once however many of its transfers the transaction moved.
  const history = new Map<string, Promise<FlaggedTransfer[]>>();
  const historyOf = (c: TxCollection, tokenId: string) => {
    const key = `${c.address}/${tokenId}`;
    if (!history.has(key)) history.set(key, s.token(c.id, tokenId));
    return history.get(key)!;
  };
  const read = new Map<string, Promise<TokenDrawing>>();
  const graphs = await Promise.all(v.transfers.map((t) => {
    const c = collectionOf(t);
    if (c === undefined) return null;
    const caught = Object.keys(t.flags).length > 0 || own.some((f) => f.collectionId === c.id && f.logIndex === t.logIndex);
    if (!caught) return null;
    const key = `${c.address}/${t.tokenId}`;
    if (!read.has(key)) read.set(key, historyOf(c, t.tokenId).then((all) => drawingInputs(s, chainId, c, t.tokenId, all, ran.get(c.id)!)));
    return read.get(key)!;
  }));
  const custody = await Promise.all(v.transfers.map(async (t) => {
    const c = collectionOf(t);
    return c === undefined || !outOfCustody(t) ? null : { parked: parkedFor(t, await historyOf(c, t.tokenId)) };
  }));
  // Your lenses are the install's, not a collection's: any collection's runs name them all.
  const any = Object.values(collections)[0];
  return { ...v, own, collections, graphs, custody, ownLenses: any === undefined ? {} : ownLenses(any.runs) };
}

/** The escrows the engine folds custody through, as the worker and a lens run pass them (graph.ts adds the zero address itself). */
const ESCROWS: ReadonlySet<string> = new Set(CUSTODIANS);

/** Whether `address` is an escrow: the one test of it the trade page and this file make, over the list the engine is given. */
export function inEscrow(address: string): boolean {
  return ESCROWS.has(address);
}

/** A move out of an escrow to a wallet: of the custody moves, the only one the engine may read as a trade. */
function outOfCustody(t: Pick<FlaggedTransfer, 'from' | 'to'>): boolean {
  return inEscrow(t.from) && t.to !== ZERO && !inEscrow(t.to);
}

/**
 * The wallet the engine holds a token for as move `t` takes it out of
 * custody: graph.ts reads A → escrow → B as one trade A → B, and
 * A → escrow → A as none. Asked of graph.ts (parkedOf over the token's
 * transfers), not worked out again here. Null when no move of the token into
 * custody is read before it.
 */
function parkedFor(t: FlaggedTransfer, all: readonly FlaggedTransfer[]): string | null {
  const at = all.findIndex((x) => x.txHash === t.txHash && x.logIndex === t.logIndex);
  return at < 0 ? null : parkedOf(all, ESCROWS)[at] ?? null;
}

/** Page `asked` of a list, or its last when `asked` is past the end: the first read's count says where the end is. */
export async function clampedPage<T>(asked: number, size: number, read: (offset: number) => Promise<{ rows: T[]; total: number }>): Promise<{ rows: T[]; total: number; page: number }> {
  const first = await read((asked - 1) * size);
  if (first.rows.length > 0 || first.total === 0) return { ...first, page: asked };
  const page = pagesOf(first.total, size);
  return { ...(await read((page - 1) * size)), page };
}

/** Page `asked` of `total` rows, clamped to the last there is, before any offset is read from it. */
function paged(asked: number, total: number, size: number): { page: number; pages: number; total: number } {
  const pages = pagesOf(total, size);
  return { page: Math.min(asked, pages), pages, total };
}

/**
 * A wallet: its funding, a page of its money partners, a page of its trades
 * under the filter, with the one verdict of the trades shown, and with
 * `filter.with` what passed between it and that wallet. Its counts are over
 * every trade: the title's flagged count is the flagged-only list's. With
 * `home`, a collection's address, every trade count and list is of its trades
 * in that collection alone, and `collections` (the picker's) is empty; its
 * money is the wallet's, wherever it went.
 */
export async function walletView(chainId: number, address: string, opts: WalletOpts, home?: string) {
  const s = store();
  const inHome = home === undefined ? {} : { collection: home };
  const { with: other, ...asked } = opts.filter;
  const narrowed = Object.keys(asked).length > 0;
  const narrow = { ...asked, ...inHome };
  const [funding, collections, all, flagged, matched, counterpartiesTotal, flowsTotal, betweenTotal] = await Promise.all([
    s.wallet(chainId, address), home === undefined ? s.walletCollections(chainId, address) : [],
    s.walletTradeCount(chainId, address, inHome), s.walletTradeCount(chainId, address, { flaggedOnly: true, ...inHome }),
    narrowed ? s.walletTradeCount(chainId, address, narrow) : null, s.counterpartyCount(chainId, address),
    other === undefined ? 0 : s.flowsBetweenCount(chainId, address, other, opts.dir),
    other === undefined ? 0 : s.walletTradeCount(chainId, address, { with: other, ...inHome }),
  ]);
  const pages = { trades: paged(opts.trades, matched ?? all, TRADES), partners: paged(opts.partners, counterpartiesTotal, COUNTERPARTIES), flows: paged(opts.flows, flowsTotal, FLOWS) };
  const offset = (p: { page: number }, size: number) => (p.page - 1) * size;
  const [shown, counterparties, betweenShown, flows] = await Promise.all([
    s.walletTransfers(chainId, address, TRADES, offset(pages.trades, TRADES), narrow),
    s.counterparties(chainId, address, COUNTERPARTIES, offset(pages.partners, COUNTERPARTIES), opts.psort),
    other === undefined ? [] : s.walletTransfers(chainId, address, TRADES, 0, { with: other, ...inHome }),
    other === undefined ? [] : s.flowsBetween(chainId, address, other, opts.dir, FLOWS, offset(pages.flows, FLOWS)),
  ]);
  const latest = await latestByAddress(s, chainId, [...shown, ...betweenShown]);
  // The API's `cut`: which list has more than one page.
  const hasMore = { trades: pages.trades.pages > 1, counterparties: pages.partners.pages > 1 };
  const withLatest = (ts: readonly FlaggedTransfer[]) => ts.map((t) => ({ t, latest: latest.get(t.collection?.address ?? '') ?? null }));
  const rows = withLatest(shown);
  return {
    funding,
    collections,
    counterparties,
    transfers: rows.map((r) => ranFlags(r.t, r.latest)),
    /** Every trade it has, and those counted flagged, whatever the filter. */
    counts: { trades: all, flagged },
    pages,
    cut: hasMore,
    // The trades between the two are the first TRADES; past that the page opens the rest as a Find on the other wallet.
    between: other === undefined ? null : { trades: withLatest(betweenShown).map((r) => ranFlags(r.t, r.latest)), tradesTotal: betweenTotal, flows, flowsTotal },
    ...verdict(rows),
  };
}

type LensRuns = { lens: Lens; run: LensRun | null }[];

/**
 * What the collection page shapes from the store before it renders: whether
 * money is funded, the lens editor's "Data this lens needs" figures (`needs`,
 * only while the editor is open), and, for each of your lenses, whether its
 * share reads "so far" or "at least" and why. One read of how far money is read, and one
 * count of other tokens, serve the editor's rows and every lens's floor.
 */
export async function collectionView(s: Store, c: CollectionRow, runs: LensRuns, o: {
  config: SourcesConfig; cov: Coverage; editing: { lensId?: number } | null; watched: number;
  /** The chosen lens when it is yours; `chart`: chartLenses of the runs, the lenses of yours the over-time chart draws, leaves out, or has no figures for. */
  yours: LensRuns[number] | null; chart: { drawn: LensRuns; left: LensRuns; notRun: LensRuns };
}) {
  const { config, cov, editing, yours } = o;
  // What the editor's "Data this lens needs" compares its rule with, and the depth moneyRead and each lens's share qualifier (moneyReason) are counted to.
  const followHops = hopsFollowed(config);
  const funded = config.funding || (c.trailImportedSha !== null && await s.importedMoney(c.id));
  // One read of how far its money is read serves the editor's rows and every lens's share qualifier (moneyReason).
  const money = editing || runs.length > 0 ? await s.moneyRead(c.id, followHops) : null;
  // A run behind the collection's version has not read what was fetched since.
  const runBehind = (run: LensRun | null) => staleSinceLastWrite(run, c.latest, c.stale);
  const moneyOf = ({ lens, run }: { lens: { rule: LensRule }; run: LensRun | null }) => money === null ? null : moneyReason(lens.rule, money, followHops, runBehind(run));
  // The same for other tokens: one count, the worker's, serves the editor's row and every lens's qualifier (tokensReason). Each lens compares it with the count its own run took in.
  const tokenCounts = c.readTokens && (editing || runs.length > 0) ? await s.tokenCounts(c.id) : null;
  const tokensFloorOf = ({ lens, run }: { lens: { rule: LensRule }; run: LensRun | null }): TokensFloor =>
    ({ reason: tokensReason(lens.rule, c.readTokens, tokenCounts, run?.tokensRead ?? null), payees: tokenCounts?.payees ?? config.tokensPayees });
  const editedRun = editing ? runs.find((r) => r.lens.id === editing.lensId)?.run ?? null : null;
  const needs = editing && money ? {
    transfers: c.transfers, transfersRead: !unread(cov), money, funding: config.funding, perSecond: callsPerSecond(config),
    watched: o.watched, followHops, fanout: FOLLOW_FANOUT, callsPerWallet: 2 + (WRAPPED[c.chainId]?.length ?? 0),
    behind: runBehind(editedRun),
    paused: c.pausedAt !== null,
    tokens: {
      started: c.readTokens, counts: tokenCounts, payees: config.tokensPayees,
      runTokensRead: editedRun?.tokensRead ?? null,
      symbols: (TOKENS[c.chainId] ?? []).map((x) => x.symbol).join(', '),
    },
  } : null;
  // A share of yours reads "so far" or "at least" while what it needs is only partly read; its tab, its stat line and the lead below all say so alike.
  const causesOf = (r: LensRuns[number]) => shareCauses(r.lens.rule, r.run!.totals!, cov.notFinal, funded, config.funding, moneyOf(r), tokensFloorOf(r));
  const qualifier = yours !== null && yours.run?.totals != null ? shareQualifier(causesOf(yours)) : null;
  return {
    funded, needs, qualifier,
    moneyReasons: Object.fromEntries(runs.map((r) => [r.lens.key, moneyOf(r)])),
    tokens: Object.fromEntries(runs.map((r) => [r.lens.key, tokensFloorOf(r)])),
    chartOwn: o.chart.drawn.map((r) => ({
      key: r.lens.key, name: r.lens.name,
      qualifier: shareQualifier(causesOf(r)),
      floorWhy: causesOf(r).map((c) => c.text).join('; '),
    })),
    chartLeft: o.chart.left.map((r) => ({ key: r.lens.key, name: r.lens.name })),
    chartNotRun: o.chart.notRun.map((r) => ({ key: r.lens.key, name: r.lens.name, why: runStateWords(r.run)!.full })),
  };
}

/**
 * Whether some collection's loaded money trail feeds its money lenses (see
 * Store.importedMoney), so having no Etherscan key does not turn them off.
 * The one answer the worker page, Settings and /api/status all give.
 */
export async function trailFunded(s: Store, collections: readonly CollectionRow[]): Promise<boolean> {
  const trailed = collections.filter((c) => c.trailImportedSha !== null);
  return (await Promise.all(trailed.map((c) => s.importedMoney(c.id)))).some(Boolean);
}

/**
 * /api/settings and the Settings page: every field, where its value came
 * from, whether this console may change them, and whether a loaded money
 * trail feeds the money lenses without a key.
 */
export async function settingsView(headers: Headers) {
  const s = store();
  const writable = mayWrite(process.env, headers);
  const [settings, sources, collections] = await Promise.all([s.settings(), s.sources(), s.collections()]);
  return { writable, open: writable && !authConfigured(process.env), fields: fieldViews(settings, sources, writable), trailFunded: await trailFunded(s, collections) };
}

/**
 * Is the detector keeping up: the reads behind /api/status, with the report built from them. The
 * worker page reads the same, so the page and the route never disagree about a job. `zone` is the
 * reader's, for the dates in the notices.
 */
export async function statusReport(zone = 'UTC') {
  const s = store();
  const [passes, collections, sources, settings] = await Promise.all([s.passes(), s.collections(), s.sources(), s.settings()]);
  // What the worker reported, not this process's environment: only the worker reads the chain.
  const config = configFromSources(sources, settings);
  const backlog = await s.moneyBacklog(hopsFollowed(config));
  // With no key, whether a loaded money trail still feeds the money lenses.
  const trailFeeds = config.funding ? false : await trailFunded(s, collections);
  const manifest = await storedManifest();
  const report = status({ passes, collections, funding: backlog, config, trailFunded: trailFeeds, manifest }, Date.now(), zone);
  return { passes, collections, config, backlog, trailFeeds, manifest, report };
}

/** The worker page and /api/worker. `zone` is the reader's, for the dates in the notices. */
export async function workerView(zone = 'UTC') {
  const { passes, collections, config, backlog, trailFeeds, manifest, report } = await statusReport(zone);
  const silent = workerSilent(passes, Date.now()) !== null;
  return {
    every: EVERY,
    rpcChains: config.chains,
    // null numbers are the worker's defaults; the page says them from FIELDS.
    funding: config.funding ? { source: 'etherscan-v2', perSecond: config.perSecond } : null,
    followHops: config.followHops,
    trailFunded: trailFeeds,
    passes,
    jobs: report.jobs,
    notices: report.notices,
    backlog: backlog.map((b) => ({ ...b, etaMs: report.funding.find((f) => f.chainId === b.chainId)?.etaMs ?? null })),
    collections: collections.map((c) => ({
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock,
      headBlock: c.headBlock, ingestedAt: c.ingestedAt, error: c.error, errorAt: c.errorAt, stale: c.stale,
      analyzedAt: c.latest?.ranAt ?? null, analysisMs: c.latest?.tookMs ?? null, analysisError: c.analysisError, analysisRetryAt: c.analysisRetryAt,
      turn: report.collections.find((r) => r.chainId === c.chainId && r.address === c.address)?.turn ?? 'keeping-up',
      // Paused or not: its "No RPC" is no fault while its stored data is there.
      storedOnly: storedOnly(c, new Set(config.chains)),
      stages: pipeline({ c, entry: manifest === null ? null : entryFor(manifest, c.chainId, c.address), rpcChains: new Set(config.chains), funding: config.funding, analyzing: analyzingOn(passes, c.id), silent })
        .map(({ key, n, title, state, share }) => ({ key, n, title, state, share })),
      backfillEtaMs: c.readRate && c.headBlock !== null && c.cursorBlock !== null ? (Math.max(0, c.headBlock - c.cursorBlock) / c.readRate) * 1000 : null,
    })),
  };
}
