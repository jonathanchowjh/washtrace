import { CUSTODIANS, EVERY, ZERO, entryFor, parkedOf, type AnalysisRow, type CollectionRow, type FlaggedTransfer, type Flow, type FlowDir, type Lens, type LensRun, type OwnFlag, type PartnerSort, type Store, type WalletFilter } from '@washtrace/detect';
import { lensIdOf } from '@washtrace/detect/trades';
import type { Lenses } from './format';
import { addressOf, findText, pageOf, pages as pagesOf } from './params';
import { authConfigured, mayWrite } from './auth';
import { analyzingOn, storedOnly } from './coverage';
import { lensContext, ownLenses, ranFlags, verdict, type Verdict } from './metrics';
import { configFromSources, fieldViews, hopsFollowed } from './settings';
import { pipeline } from './pipeline';
import { status, workerSilent } from './status';
import { store, storedManifest } from './store';

/**
 * Reads a page and its API route both serve, in one place, so the console
 * never shows what the API would not say.
 */

/**
 * What a token's graph is drawn from: its transfers with the flags of the
 * built-ins that ran, and your lenses' flags of it, of the lenses that ran
 * there (lensContext's `ran`). The token page and the trade page both read it
 * through tokenGraph, so layout() over it gives both the same loop keys, and
 * a trade's card opens the token page with its loop lit by ?loop=.
 */
export interface TokenGraph {
  transfers: FlaggedTransfer[];
  /** Wallets that joined two holders by money without holding the token: AC's middles. */
  middles: string[];
  flows: Flow[];
  /** In chain order, then by lens: each one loop, drawn and said beside the built-ins'. */
  own: OwnFlag[];
}

export type TokenView = {
  collection: { id: number; chainId: number; address: string; name: string | null };
  tokenId: string;
  /** Your lenses' names, for their chips and lines. */
  ownLenses: Lenses;
} & TokenGraph & Verdict;

/** A page of each of the wallet page's lists: its trades, its money partners, and the payments between it and one of them. */
export const TRADES = 100;
export const COUNTERPARTIES = 50;
export const FLOWS = 50;

/** Each collection's latest analysis, by address, for the collections these transfers are in (null: none yet). */
async function latestByAddress(s: Store, chainId: number, transfers: readonly FlaggedTransfer[]): Promise<Map<string, AnalysisRow | null>> {
  const addresses = [...new Set(transfers.map((t) => t.collection?.address ?? ''))];
  return new Map(await Promise.all(addresses.map(async (a) => [a, (await s.collection(chainId, a))?.latest ?? null] as const)));
}

/** A token's graph from its transfers as read (`all`), keeping the built-ins that ran in `c.latest` and your lenses in `ran` (lens ids). */
async function tokenGraph(s: Store, chainId: number, c: Pick<CollectionRow, 'id' | 'latest'>, tokenId: string, all: readonly FlaggedTransfer[], ran: readonly number[]): Promise<TokenGraph> {
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

/** Your lenses that ran on a collection, by id: a lens of yours with no finished run there has flagged nothing on it yet. */
function ownRanIds(latest: AnalysisRow | null, runs: readonly { lens: Lens; run: LensRun | null }[]): number[] {
  return lensContext(latest, runs).ran.flatMap((k) => lensIdOf(k) ?? []);
}

/** One token's view, or why there is none: the collection is not watched, or none of the token's transfers is read. */
export async function tokenView(chainId: number, address: string, tokenId: string): Promise<TokenView | 'not-watched' | 'no-transfer'> {
  const s = store();
  const c = await s.collection(chainId, address);
  if (!c) return 'not-watched';
  const [all, runs] = await Promise.all([s.token(c.id, tokenId), s.lensRuns(c.id)]);
  if (all.length === 0) return 'no-transfer';
  const graph = await tokenGraph(s, chainId, c, tokenId, all, ownRanIds(c.latest, runs));
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
  graphs: (TokenGraph | null)[];
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
  const of = (t: FlaggedTransfer): TxCollection | undefined => collections[t.collection?.address ?? ''];
  const ran = new Map(Object.values(collections).map((c) => [c.id, ownRanIds(c.latest, c.runs)]));
  const own = stored.filter((f) => ran.get(f.collectionId)?.includes(f.lensId) === true);
  // A token is read only when some lens caught a transfer of it here or it came out of custody, and once however many of its transfers the transaction moved.
  const history = new Map<string, Promise<FlaggedTransfer[]>>();
  const historyOf = (c: TxCollection, tokenId: string) => {
    const key = `${c.address}/${tokenId}`;
    if (!history.has(key)) history.set(key, s.token(c.id, tokenId));
    return history.get(key)!;
  };
  const read = new Map<string, Promise<TokenGraph>>();
  const graphs = await Promise.all(v.transfers.map((t) => {
    const c = of(t);
    if (c === undefined) return null;
    const caught = Object.keys(t.flags).length > 0 || own.some((f) => f.collectionId === c.id && f.logIndex === t.logIndex);
    if (!caught) return null;
    const key = `${c.address}/${t.tokenId}`;
    if (!read.has(key)) read.set(key, historyOf(c, t.tokenId).then((all) => tokenGraph(s, chainId, c, t.tokenId, all, ran.get(c.id)!)));
    return read.get(key)!;
  }));
  const custody = await Promise.all(v.transfers.map(async (t) => {
    const c = of(t);
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
export function outOfCustody(t: Pick<FlaggedTransfer, 'from' | 'to'>): boolean {
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

/**
 * What the wallet page and route ask for: each list's page, the trades' filter, and which payments between it and `filter.with`.
 * `partners` is the page of the money partners that the result and the store call counterparties (`COUNTERPARTIES`, `cut.counterparties`): the URL and `pages` say partners, so a caller's `partners=2` is read back as `pages.partners`.
 */
export type WalletOpts = { trades: number; partners: number; flows: number; filter: WalletFilter; dir: FlowDir; psort: PartnerSort };

const PARTNER_SORTS: readonly PartnerSort[] = ['flows', 'sent', 'received', 'watched'];

/**
 * The wallet page's and route's params as one reading. Junk is dropped: a
 * page under 1 or not a number is the first, a collection or `with` that is
 * no address is none, `flagged` is only `1`, and an unknown order or
 * direction is the default.
 */
export function walletOpts(q: Record<string, string | string[] | undefined>): WalletOpts {
  const one = (k: string) => { const v = q[k]; return Array.isArray(v) ? v[0] : v; };
  const filter: WalletFilter = {};
  const collection = addressOf(one('collection') ?? '');
  if (collection !== null) filter.collection = collection;
  if (one('flagged') === '1') filter.flaggedOnly = true;
  const find = findText(one('q'));
  if (find) filter.find = find;
  const other = addressOf(one('with') ?? '');
  if (other !== null) filter.with = other;
  const dir = one('dir');
  const psort = PARTNER_SORTS.find((s) => s === one('psort')) ?? 'flows';
  return { trades: pageOf(one('trades')), partners: pageOf(one('partners')), flows: pageOf(one('flows')), filter, dir: dir === 'sent' || dir === 'received' ? dir : 'both', psort };
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
 * every trade: the title's flagged count is the flagged-only list's.
 */
export async function walletView(chainId: number, address: string, opts: WalletOpts) {
  const s = store();
  const { with: other, ...narrow } = opts.filter;
  const narrowed = Object.keys(narrow).length > 0;
  const [funding, collections, all, flagged, matched, partnersTotal, flowsTotal, betweenTotal] = await Promise.all([
    s.wallet(chainId, address), s.walletCollections(chainId, address),
    s.walletTradeCount(chainId, address), s.walletTradeCount(chainId, address, { flaggedOnly: true }),
    narrowed ? s.walletTradeCount(chainId, address, narrow) : null, s.counterpartyCount(chainId, address),
    other === undefined ? 0 : s.flowsBetweenCount(chainId, address, other, opts.dir),
    other === undefined ? 0 : s.walletTradeCount(chainId, address, { with: other }),
  ]);
  const pages = { trades: paged(opts.trades, matched ?? all, TRADES), partners: paged(opts.partners, partnersTotal, COUNTERPARTIES), flows: paged(opts.flows, flowsTotal, FLOWS) };
  const offset = (p: { page: number }, size: number) => (p.page - 1) * size;
  const [shown, counterparties, betweenShown, flows] = await Promise.all([
    s.walletTransfers(chainId, address, TRADES, offset(pages.trades, TRADES), narrow),
    s.counterparties(chainId, address, COUNTERPARTIES, offset(pages.partners, COUNTERPARTIES), opts.psort),
    other === undefined ? [] : s.walletTransfers(chainId, address, TRADES, 0, { with: other }),
    other === undefined ? [] : s.flowsBetween(chainId, address, other, opts.dir, FLOWS, offset(pages.flows, FLOWS)),
  ]);
  const latest = await latestByAddress(s, chainId, [...shown, ...betweenShown]);
  const judge = (ts: readonly FlaggedTransfer[]) => ts.map((t) => ({ t, latest: latest.get(t.collection?.address ?? '') ?? null }));
  const rows = judge(shown);
  return {
    funding,
    collections,
    counterparties,
    transfers: rows.map((r) => ranFlags(r.t, r.latest)),
    /** Every trade it has, and those counted flagged, whatever the filter. */
    counts: { trades: all, flagged },
    pages,
    // Kept for the API: which list has more than one page.
    cut: { trades: pages.trades.pages > 1, counterparties: pages.partners.pages > 1 },
    // The trades between the two are the first TRADES; past that the page opens the rest as a Find on the other wallet.
    between: other === undefined ? null : { trades: judge(betweenShown).map((r) => ranFlags(r.t, r.latest)), tradesTotal: betweenTotal, flows, flowsTotal },
    ...verdict(rows),
  };
}

/**
 * Whether some collection's loaded money trail feeds its money lenses (see
 * Store.importedFunding), so having no Etherscan key does not turn them off.
 * The one answer the worker page, Settings and /api/status all give.
 */
export async function trailFunded(s: Store, collections: readonly CollectionRow[]): Promise<boolean> {
  const trailed = collections.filter((c) => c.trailImportedSha !== null);
  return (await Promise.all(trailed.map((c) => s.importedFunding(c.id)))).some(Boolean);
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
  const backlog = await s.fundingBacklog(hopsFollowed(config));
  // With no key, whether a loaded money trail still feeds the money lenses.
  const fed = config.funding ? false : await trailFunded(s, collections);
  const manifest = await storedManifest();
  const report = status({ passes, collections, funding: backlog, config, trailFunded: fed, manifest }, Date.now(), zone);
  return { passes, collections, config, backlog, fed, manifest, report };
}

/** The worker page and /api/worker. `zone` is the reader's, for the dates in the notices. */
export async function workerView(zone = 'UTC') {
  const { passes, collections, config, backlog, fed, manifest, report } = await statusReport(zone);
  const silent = workerSilent(passes, Date.now()) !== null;
  return {
    every: EVERY,
    rpcChains: config.chains,
    // null numbers are the worker's defaults; the page says them from FIELDS.
    funding: config.funding ? { source: 'etherscan-v2', perSecond: config.perSecond } : null,
    followHops: config.followHops,
    trailFunded: fed,
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
