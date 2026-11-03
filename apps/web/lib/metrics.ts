import { BEHIND_BLOCKS, METHODS, type AnalysisRow, type CollectionRow, type FlaggedTransfer, type Method, type MethodTotals, type PassRow, type Transfer } from '@washtrace/detect';
import { localTime, pct, plural } from './format';

/**
 * The analysis, said the way a reader asks it. One collection's answer is a
 * range from Round trips to Linked wallets. Money loops back is left out: on
 * real data it flags about as many sales as randomly paired wallets do. A lens
 * that did not run is left out of the range, never read as 0%.
 */

export type Measure = 'sales' | 'volume' | 'owners';

/** One lens's share of one measure. Volume in micro-ETH: enough for a share, and it fits a number. */
export function part(t: MethodTotals, measure: Measure): { part: number; whole: number } {
  if (measure === 'sales') return { part: t.flaggedSales, whole: t.sales };
  if (measure === 'owners') return { part: t.flagged, whole: t.transfers };
  return { part: Number(BigInt(t.flaggedVolumeWei) / 10n ** 12n), whole: Number(BigInt(t.volumeWei) / 10n ** 12n) };
}

/** The lenses the headline range reads, Round trips to Linked wallets. Money loops back runs and keeps its card, but is not counted. */
export const HEADLINE: readonly Method[] = ['A', 'AC'];

/** Whether an analysis covers a transfer: only one that ran through the transfer's block can have judged it. */
export function judged(t: Pick<Transfer, 'blockNumber'>, latest: Pick<AnalysisRow, 'throughBlock'> | null): boolean {
  return latest !== null && latest.throughBlock !== null && t.blockNumber <= latest.throughBlock;
}

/**
 * The transfer with only the flags of lenses that ran in its collection's
 * latest analysis. When no funding ran the engine copies Round trips' flags
 * into the money lenses, so those copies must never be shown or counted. With
 * no analysis (null) nothing is known to have run, so no flag is kept; such a
 * transfer is not judged anyway.
 */
export function ranFlags<T extends Pick<FlaggedTransfer, 'flags'>>(t: T, latest: Pick<AnalysisRow, 'totals'> | null): T {
  const flags = Object.fromEntries(Object.entries(t.flags).filter(([m, w]) => w && latest?.totals[m as Method]?.available === true));
  return { ...t, flags };
}

export interface Verdict {
  judged: boolean;
  /** True when a headline lens that ran flags a transfer; null when none does but some transfer is not judged; else false. */
  washTrade: boolean | null;
  /** The lenses that flag any transfer and ran. The engine copies Round trips' flags into the money lenses when no funding ran, so a lens that did not run never counts. */
  by: Method[];
  /** Money loops back alone flags it: shown, but not counted. */
  apartOnly: boolean;
  /** The lenses that did not run in at least one of the analyses. */
  notRun: Method[];
}

/** One answer for a set of transfers and the latest analysis of each one's collection (null: none yet). The tx page, the token page and their routes all read it. */
export function verdict(rows: readonly { t: FlaggedTransfer; latest: AnalysisRow | null }[]): Verdict {
  const by = METHODS.filter((m) => rows.some((r) => ranFlags(r.t, r.latest).flags[m]));
  const notRun = METHODS.filter((m) => rows.some((r) => r.latest !== null && !r.latest.totals[m].available));
  const all = rows.length > 0 && rows.every((r) => judged(r.t, r.latest));
  const washTrade = by.some((m) => HEADLINE.includes(m)) ? true : all ? false : null;
  return { judged: all, washTrade, by, apartOnly: by.length === 1 && by[0] === 'AU', notRun };
}

export interface Range { low: Method; high: Method; lowShare: number; highShare: number }

/** Null when no lens ran or there is nothing to divide by, such as a collection with no priced sale. */
export function range(totals: Record<Method, MethodTotals>, measure: Measure): Range | null {
  const read = HEADLINE.filter((m) => totals[m].available)
    .map((m) => ({ m, ...part(totals[m], measure) }))
    .filter((r) => r.whole > 0)
    .map((r) => ({ m: r.m, share: r.part / r.whole }));
  if (read.length === 0) return null;
  // Stable over HEADLINE's order, so a tie keeps Round trips low and Linked wallets high.
  const sorted = [...read].sort((a, b) => a.share - b.share);
  const low = sorted[0]!, high = sorted[sorted.length - 1]!;
  return { low: low.m, high: high.m, lowShare: low.share, highShare: high.share };
}

/** "18–25%", or "18%" when the lenses agree. */
export function rangeText(r: Range): string {
  const lo = pct(r.lowShare, 1), hi = pct(r.highShare, 1);
  return lo === hi ? hi : `${lo.replace('%', '')}–${hi}`;
}

/** The range in a sentence: what Round trips counts, and what Linked wallets adds. */
export function summary(totals: Record<Method, MethodTotals>): string {
  const a = totals.A;
  if (a.sales === 0) return `No sale read yet, so there is no share of sales. ${a.flagged.toLocaleString('en-US')} of ${a.transfers.toLocaleString('en-US')} changes of owner are round trips.`;
  const strict = a.flaggedSales === 0
    ? `None of the ${a.sales.toLocaleString('en-US')} sales is a round trip between the same wallets.`
    : `${a.flaggedSales.toLocaleString('en-US')} of ${a.sales.toLocaleString('en-US')} sales are round trips between the same wallets.`;
  if (!totals.AC.available) return `${strict} Money links between buyers and sellers were not checked, so this is the strict count alone.`;
  const wide = totals.AC.flaggedSales;
  return wide > a.flaggedSales
    ? `${strict} Counting buyers and sellers linked by money, up to ${wide.toLocaleString('en-US')} are.`
    : `${strict} Following the money adds none.`;
}

/** The lead of "How was it found?": which lenses make the range above, and why Money loops back is shown apart. Linked wallets not run leaves Round trips as the whole range. */
export function evidenceLead(totals: Record<Method, MethodTotals>): string {
  const apart = 'Money loops back is shown apart: on real data it flags about as many sales as randomly paired wallets do, so it is not counted. Choose a lens to see the tokens and wallets it flags.';
  return totals.AC.available
    ? `Round trips and Linked wallets are the two ends of the range above. ${apart}`
    : `Round trips is the whole range above: Linked wallets has not run. ${apart}`;
}

/** A share of progress: "100%" only when it is done, so 99.98% of history reads as unfinished. */
export function progress(share: number): string {
  const text = pct(share, 1);
  return share < 1 && text === '100%' ? '>99%' : text;
}

/** A download's share rounded down, as the Hub's own count would say it: 41.6% reads 41%, never a step ahead of the bytes. */
export function downloaded(share: number): string {
  return `${Math.floor(share * 100)}%`;
}

export type Reading = 'queued' | 'downloading' | 'restoring' | 'stored-only' | 'head-unknown' | 'starting' | 'catching-up' | 'analyzing' | 'checking' | 'complete' | 'paused';

export interface Coverage {
  reading: Reading;
  /** Share of the collection's blocks read, 0 to 1. Null until its deployment block is known. */
  blocks: number | null;
  behind: number | null;
  wallets: { checked: number; of: number };
  /** False when the money lenses did not run: no wallet is waiting to be checked. */
  money: boolean;
  /** Money lenses whose shares are not final while wallets are unchecked: checking more can move them either way. */
  floor: Method[];
  /** How far a load of stored data has got, 0 to 1, while one runs; else null. */
  restore: number | null;
  /** How far the download of its transfers has got, 0 to 1, while one runs and it is not paused; else null. A trail download is a note on the funding step, not a reading. */
  download: number | null;
  /** When the stored data stops, while it is all there is (stored-only, not read past it); else null. */
  stops: number | null;
  /** How long ago that was, "9 days unsynced", whenever `stops` is set; else null. */
  unsynced: string | null;
  /** Stored-only but read from the chain, past the stored data or with none, before the RPC went: the block it was read to. Else null. */
  readTo: number | null;
  label: string;
}

/**
 * Whether a collection shows stored data only: its stored data has loaded
 * (the cursor sits past its start), and its chain has no RPC to read on
 * from there. Not a fault, and not starting: the numbers are all there, they
 * just stop where the stored data was cut.
 */
export function storedOnly(c: Pick<CollectionRow, 'chainId' | 'startBlock' | 'cursorBlock'> & Partial<Pick<CollectionRow, 'storedThroughTime'>>, rpcChains: ReadonlySet<number>): boolean {
  return !rpcChains.has(c.chainId) && (c.storedThroughTime ?? null) !== null && c.cursorBlock !== null && c.startBlock !== null && c.cursorBlock >= c.startBlock;
}

/**
 * Why a collection's stored data was not loaded, and what follows, as the
 * console says it. The worker writes only why (restoreNote); what follows
 * depends on the chain's RPC. With one the chain is read meanwhile; with none
 * nothing is, and the stored data is all the collection can have. Either way
 * a load the data failed is tried again once the stored data changes, and
 * one the store failed after its wait: then `then` ends in "after", and the
 * caller says `retryAt` in the reader's zone; once that has passed, it is
 * due. A paused collection is neither read nor tried, so it gets only why.
 * Nothing while a load runs: that is the try, and its progress says so.
 */
export function restoreNext(
  c: Pick<CollectionRow, 'chainId' | 'pausedAt'> & Partial<Pick<CollectionRow, 'restoreNote' | 'restoreRetryAt' | 'restoreProgress'>>,
  rpcChains: ReadonlySet<number>,
  now: number,
): { note: string; then: string | null; retryAt: number | null } | null {
  if (!c.restoreNote) return null;
  if (c.pausedAt !== null) return { note: c.restoreNote, then: null, retryAt: null };
  if ((c.restoreProgress ?? null) !== null) return null;
  const retryAt = c.restoreRetryAt ?? null;
  const read = rpcChains.has(c.chainId) ? 'Reading from the chain instead; it is' : 'It is';
  if (retryAt === null) return { note: c.restoreNote, then: `${read} tried again when its stored file or its manifest entry changes.`, retryAt };
  return retryAt > now ? { note: c.restoreNote, then: `${read} tried again after`, retryAt } : { note: c.restoreNote, then: `${read} due to be tried again.`, retryAt: null };
}

/** restoreNext as one line of text, its time said in `zone`. Built on the server, so the locale is pinned. */
export function restoreText(c: Parameters<typeof restoreNext>[0], rpcChains: ReadonlySet<number>, now: number, zone = 'UTC'): string | null {
  const n = restoreNext(c, rpcChains, now);
  if (n === null) return null;
  return [n.note, n.then, n.retryAt === null ? null : `${localTime(n.retryAt, 'time', zone, 'en-GB')}.`].filter((x) => x !== null).join(' ');
}

/** How long stored data has gone unread, as the owner put it: "9 days unsynced". With no RPC there is no head to count blocks to, only time. */
function unsyncedFor(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'up to date with its stored data';
  return hours < 24 ? `${plural(hours, 'hour')} unsynced` : `${plural(Math.floor(hours / 24), 'day')} unsynced`;
}

/**
 * How far the reading the numbers rest on has got. History comes first: with
 * blocks unread, any share can still move either way. Then wallets: with
 * money unread, the money lenses have missed links, and a wallet can turn out
 * to be a hub, so their shares are not final and can move either way. Before
 * either, stored data may be loading: the history it holds arrives at once,
 * when the load commits. A paused
 * collection is none of these: its head stops moving, so "up to date" would
 * be a claim nobody is keeping true. Nor is one whose chain has no
 * RPC, whatever it has read: its numbers stop at the stored date, said in
 * `zone` (the reader's; the console draws that date with Time), or at the
 * block it was read to, or there are none. Nor one read before whose chain's
 * head is not known now: its RPC failed before saying (the collection's
 * error says why), and what was read stands.
 *
 * `funding` is whether an Etherscan key is set (SourcesConfig.funding, as the
 * status report reads it). Without one nothing checks wallets, so unchecked
 * wallets leave the money lenses' shares not final but are not a step in progress.
 */
export function coverage(
  c: Pick<CollectionRow, 'chainId' | 'pausedAt' | 'startBlock' | 'cursorBlock' | 'headBlock' | 'wallets' | 'fundedWallets' | 'latest'> & Partial<Pick<CollectionRow, 'restoreProgress' | 'downloadFile' | 'downloadProgress' | 'storedThroughTime' | 'storedThroughBlock' | 'transfers' | 'analysisError'>>,
  rpcChains: ReadonlySet<number>, now: number, zone = 'UTC', funding = true,
): Coverage {
  const money = c.latest === null ? true : c.latest.totals.AU.available || c.latest.totals.AC.available;
  const wallets = { checked: c.fundedWallets, of: c.wallets };
  const behind = c.headBlock === null || c.cursorBlock === null ? null : Math.max(0, c.headBlock - c.cursorBlock);
  const span = c.headBlock === null || c.startBlock === null ? null : c.headBlock - c.startBlock;
  const blocks = span === null || c.cursorBlock === null || c.startBlock === null ? null : span <= 0 ? 1 : Math.max(0, Math.min(1, (c.cursorBlock - c.startBlock) / span));
  const unchecked = money && wallets.checked < wallets.of;
  const floor: Method[] = unchecked ? METHODS.filter((m) => m !== 'A' && (c.latest?.totals[m].available ?? true)) : [];
  // A load is never resumed after a pause, so progress left on a paused collection is stale.
  // Never shown as done: the data is not there until the load commits, and then the progress is gone.
  const restore = c.pausedAt === null && (c.restoreProgress ?? null) !== null ? Math.min(c.restoreProgress!, 0.99) : null;
  // The download comes first: the stored data cannot load until it has arrived. Capped like a load, for the same reason.
  const download = c.pausedAt === null && c.downloadFile === 'transfers' && (c.downloadProgress ?? null) !== null ? Math.min(c.downloadProgress!, 0.99) : null;
  // Held for a download that has not started (another runs, or another replica has the lock): the worker marks the file, with no progress.
  const queued = c.pausedAt === null && download === null && c.downloadFile === 'transfers' && (c.downloadProgress ?? null) === null;
  // Nothing moves stored data, so a missing RPC is what holds the reading: whatever was read, it reads stored-only.
  const noRpc = c.pausedAt === null && restore === null && download === null && !queued && !rpcChains.has(c.chainId);
  const stored = noRpc && storedOnly(c, rpcChains);
  // Read on past the stored data while an RPC was set: it stops at its cursor, whose time is not known. Before the block was kept, the date stands.
  const past = stored && (c.storedThroughBlock ?? null) !== null && c.cursorBlock! > c.storedThroughBlock!;
  const stops = stored && !past ? c.storedThroughTime! : null;
  const unsynced = stops === null ? null : unsyncedFor(now - stops);
  // Read from the chain with no stored data before the RPC went: what was read stands, so it stops at its cursor too.
  const chainRead = noRpc && !stored && c.cursorBlock !== null && c.startBlock !== null && c.cursorBlock >= c.startBlock && (c.transfers ?? 0) > 0;
  const readTo = past || chainRead ? c.cursorBlock : null;
  const base = { blocks, behind, wallets, money, floor, restore, download, stops, unsynced, readTo };
  if (download !== null) return { ...base, reading: 'downloading', label: `Downloading stored data · ${downloaded(download)}` };
  if (queued && restore === null) return { ...base, reading: 'queued', label: 'Waiting to download stored data' };
  if (restore !== null) return { ...base, reading: 'restoring', label: `Loading stored data · ${progress(restore)}` };
  if (c.pausedAt !== null) return { ...base, reading: 'paused', label: c.cursorBlock === null || (c.startBlock !== null && c.cursorBlock < c.startBlock) ? 'Paused · not read yet' : `Paused · read to block ${c.cursorBlock.toLocaleString('en-US')}` };
  // Before 'starting': with no RPC the head is never known, and the stored numbers are all there is.
  // Built on the server, so the locale is pinned; the console draws its own date with Time.
  if (stops !== null) return { ...base, reading: 'stored-only', label: `Stored data · stops ${localTime(stops, 'date', zone, 'en-GB')} · ${unsynced}` };
  if (readTo !== null) return { ...base, reading: 'stored-only', label: `Read to block ${readTo.toLocaleString('en-US')} · no RPC for its chain` };
  // Nothing of stored data to show, and nothing read on: `stops` and `readTo` stay null, and the pill and summary say the missing RPC.
  if (noRpc) return { ...base, reading: 'stored-only', label: 'No RPC for its chain' };
  // Read before, but no head now: an RPC that fails (a typo, a rate limit) never said it. The numbers are there; how far behind is not known.
  const read = c.cursorBlock !== null && c.startBlock !== null && c.cursorBlock >= c.startBlock && ((c.storedThroughTime ?? null) !== null || (c.transfers ?? 0) > 0);
  if (c.headBlock === null && read) return { ...base, reading: 'head-unknown', label: `Read to block ${c.cursorBlock!.toLocaleString('en-US')}` };
  // An unknown head cannot be caught up to.
  if (c.cursorBlock === null || c.startBlock === null || c.headBlock === null) return { ...base, reading: 'starting', label: 'Starting' };
  if (behind !== null && behind > BEHIND_BLOCKS) return { ...base, reading: 'catching-up', label: `Reading history · ${blocks === null ? '…' : progress(blocks)}` };
  // The wallet counts come from an analysis, so until the first one they are not zero but unknown.
  if (c.latest === null) return { ...base, reading: 'analyzing', label: c.analysisError ? 'First analysis failed' : 'Analyzing' };
  // Only a key checks wallets: without one (a loaded money trail, or a key just removed) nothing is in progress.
  if (unchecked && funding) return { ...base, reading: 'checking', label: `Checking wallets · ${progress(wallets.of === 0 ? 0 : wallets.checked / wallets.of)}` };
  return { ...base, reading: 'complete', label: 'Up to date' };
}

/**
 * The collections tabs' counts. "Behind" is the In sync collections showing
 * stored data only: in sync by choice, but nothing reads them on until their
 * chain has an RPC.
 */
export function tabCounts(rows: readonly CollectionRow[], rpcChains: ReadonlySet<number>): { sync: number; paused: number; all: number; behind: number } {
  const sync = rows.filter((c) => c.pausedAt === null);
  return { sync: sync.length, paused: rows.length - sync.length, all: rows.length, behind: sync.filter((c) => storedOnly(c, rpcChains)).length };
}

/** Whether history is still unread, paused or not: a pause does not read what was left. The history chart shades that stretch. */
export function unread(cov: Pick<Coverage, 'behind'>): boolean {
  return cov.behind !== null && cov.behind > BEHIND_BLOCKS;
}

/** A pass is running from when it starts until it finishes. The status route and the pages both decide it here. */
export function isRunning(p: PassRow): boolean {
  return p.finishedAt === null || p.finishedAt < p.startedAt;
}

/** Whether the running analyze pass is on collection `id`: only that one's analysis stages can be running. */
export function analyzingOn(passes: readonly PassRow[], id: number): boolean {
  return passes.some((p) => p.job === 'analyze' && isRunning(p) && p.subjectId === id);
}

/**
 * When a collection whose last analysis failed is tried again, as the console
 * says it: after a time in `zone`, or due once that has passed, when it waits
 * only for the analysis thread. Text, so the locale is pinned.
 */
export function analysisRetry(c: Pick<CollectionRow, 'analysisRetryAt'>, now: number, zone = 'UTC'): string {
  const at = c.analysisRetryAt ?? null;
  return at !== null && at > now ? `it is tried again after ${localTime(at, 'time', zone, 'en-GB')}` : 'it is due to be tried again';
}

/**
 * Why a collection has no analysis yet, from what the worker is doing now.
 * Analysis runs one collection per pass, so a new one may be queued behind
 * another that takes a while. One whose analysis failed waits out its back-off
 * first, said in `zone`.
 */
export function waiting(c: CollectionRow, analyzePass: PassRow | undefined, names: ReadonlyMap<number, string>, rpcChains: ReadonlySet<number>, now: number, zone = 'UTC'): string {
  // Never analysed while paused, so promise nothing.
  if (c.pausedAt !== null) return 'Paused · it is not analysed until you resume it.';
  // Its transfers arrive all at once when the load commits; until then there is nothing to analyse.
  if (c.downloadFile === 'transfers' && (c.downloadProgress ?? null) !== null) return 'Downloading stored data · it is analysed once it has loaded.';
  if (c.downloadFile === 'transfers') return 'Waiting to download stored data · it is analysed once it has loaded.';
  if ((c.restoreProgress ?? null) !== null) return 'Loading stored data · it is analysed once it has loaded.';
  if (c.transfers === 0) return rpcChains.has(c.chainId) ? 'Waiting for its first transfers.' : 'Nothing is read until its chain has an RPC.';
  const running = analyzePass && isRunning(analyzePass) && analyzePass.subjectId !== null ? analyzePass : null;
  const min = running === null ? '' : `${Math.floor((now - running.startedAt) / 60_000)} min`;
  if (running?.subjectId === c.id) return `First analysis running · started ${min} ago.`;
  // Not the next pass: it waits out its back-off whatever runs now.
  if (c.analysisError) return `Its analysis failed: ${c.analysisError} · ${analysisRetry(c, now, zone)}.`;
  if (running === null) return 'Waiting for its first analysis · the next pass starts within a minute.';
  return `Waiting for its first analysis · queued behind ${names.get(running.subjectId!) ?? 'another collection'} (running ${min}).`;
}
