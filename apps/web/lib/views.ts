import { EVERY, ZERO, entryFor, type AnalysisRow, type CollectionRow, type FlaggedTransfer, type Flow, type FlowDir, type PartnerSort, type Store, type WalletFilter } from '@washtrace/detect';
import { addressOf } from './api';
import { authConfigured, mayWrite } from './auth';
import { analyzingOn, ranFlags, storedOnly, verdict, type Verdict } from './metrics';
import { configFromSources, hopsFollowed, view } from './settings';
import { pipeline } from './pipeline';
import { status, workerSilent } from './status';
import { store, storedManifest } from './store';

/**
 * Reads a page and its API route both serve, in one place, so the console
 * never shows what the API would not say.
 */

export type TokenView = {
  collection: { id: number; chainId: number; address: string; name: string | null };
  tokenId: string;
  transfers: FlaggedTransfer[];
  /** Wallets that joined two holders by money without holding the token: AC's middles. */
  middles: string[];
  flows: Flow[];
} & Verdict;

/** A page of each of the wallet page's lists: its trades, its money partners, and the payments between it and one of them. */
export const TRADES = 100;
export const COUNTERPARTIES = 50;
export const FLOWS = 50;

/** Each collection's latest analysis, by address, for the collections these transfers are in (null: none yet). */
async function latestByAddress(s: Store, chainId: number, transfers: readonly FlaggedTransfer[]): Promise<Map<string, AnalysisRow | null>> {
  const addresses = [...new Set(transfers.map((t) => t.collection?.address ?? ''))];
  return new Map(await Promise.all(addresses.map(async (a) => [a, (await s.collection(chainId, a))?.latest ?? null] as const)));
}

export async function tokenView(chainId: number, address: string, tokenId: string): Promise<TokenView | null> {
  const s = store();
  const c = await s.collection(chainId, address);
  if (!c) return null;
  const all = await s.token(c.id, tokenId);
  if (all.length === 0) return null;
  // Only the lenses that ran: the verdict, the middles and the rows all read these.
  const transfers = all.map((t) => ranFlags(t, c.latest));
  const middles = [...new Set(transfers.flatMap((t) => {
    const w = t.flags.AC;
    return w?.kind === 'pair' && w.middle !== null ? [w.middle] : [];
  }))];
  const holders = [...new Set(transfers.flatMap((t) => [t.from, t.to]))].filter((a) => a !== ZERO);
  const flows = holders.length === 0 ? [] : await s.flowsAmong(chainId, [...holders, ...middles]);
  return { collection: { id: c.id, chainId, address, name: c.name }, tokenId, transfers, middles, flows, ...verdict(transfers.map((t) => ({ t, latest: c.latest }))) };
}

/** A transaction's transfers and the one verdict the page and the route both give, from each collection's latest analysis. */
export async function txView(chainId: number, tx: string): Promise<{ transfers: FlaggedTransfer[] } & Verdict> {
  const s = store();
  const transfers = await s.transaction(chainId, tx);
  const latest = await latestByAddress(s, chainId, transfers);
  const rows = transfers.map((t) => ({ t, latest: latest.get(t.collection?.address ?? '') ?? null }));
  // Rows carry only the lenses that ran, so the API and the page never name one that did not.
  return { ...verdict(rows), transfers: rows.map((r) => ranFlags(r.t, r.latest)) };
}

/** What the wallet page and route ask for: each list's page, the trades' filter, and which payments between it and `filter.with`. */
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
  const page = (k: string) => { const n = Number.parseInt(one(k) ?? '1', 10); return Number.isSafeInteger(n) && n >= 1 ? n : 1; };
  const filter: WalletFilter = {};
  const collection = addressOf(one('collection') ?? '');
  if (collection !== null) filter.collection = collection;
  if (one('flagged') === '1') filter.flaggedOnly = true;
  const find = one('q')?.trim().slice(0, 100);
  if (find) filter.find = find;
  const other = addressOf(one('with') ?? '');
  if (other !== null) filter.with = other;
  const dir = one('dir');
  const psort = PARTNER_SORTS.find((s) => s === one('psort')) ?? 'flows';
  return { trades: page('trades'), partners: page('partners'), flows: page('flows'), filter, dir: dir === 'sent' || dir === 'received' ? dir : 'both', psort };
}

/** Page `asked` of `total` rows, clamped to the last there is, before any offset is read from it. */
function paged(asked: number, total: number, size: number): { page: number; pages: number; total: number } {
  const pages = Math.max(1, Math.ceil(total / size));
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
  return { writable, open: writable && !authConfigured(process.env), fields: view(settings, sources, writable), trailFunded: await trailFunded(s, collections) };
}

/** The worker page and /api/worker. `zone` is the reader's, for the dates in the notices. */
export async function workerView(zone = 'UTC') {
  const s = store();
  const [passes, collections, sources, settings] = await Promise.all([s.passes(), s.collections(), s.sources(), s.settings()]);
  // What the worker reported, not this process's environment: only the worker reads the chain.
  const config = configFromSources(sources, settings);
  const backlog = await s.fundingBacklog(hopsFollowed(config));
  // With no key, whether a loaded money trail still feeds the money lenses.
  const fed = config.funding ? false : await trailFunded(s, collections);
  // The same reading of the passes as /api/status, so the page and the route never disagree about a job.
  const manifest = await storedManifest();
  const report = status({ passes, collections, funding: backlog, config, trailFunded: fed, manifest }, Date.now(), zone);
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
