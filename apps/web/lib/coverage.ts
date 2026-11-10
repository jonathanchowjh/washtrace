import { BEHIND_BLOCKS, METHODS, NOT_DONE, type CollectionRow, type Method, type PassRow } from '@washtrace/detect';
import { LENSES, floorPct, lensList, localTime, pct, plural, num } from './format';

/**
 * A collection's reading progress, said the way the console shows it: how far
 * its history, stored data, money trail and first analysis have got
 * (coverage), the tab counts and waiting reasons built on it, and the
 * percentages that say it (progress, downloaded). The verdict and range
 * answer lives in metrics.ts; the two share only the Method type and format.ts.
 */

/** A share of progress: "100%" only when it is done, so 99.98% of history reads as unfinished. */
export function progress(share: number): string {
  const text = pct(share, 1);
  return share < 1 && text === '100%' ? '>99%' : text;
}

export type Reading = 'queued' | 'downloading' | 'restoring' | 'stored-only' | 'head-unknown' | 'starting' | 'catching-up' | 'analyzing' | 'checking' | 'complete' | 'paused' | 'silent';

export interface Coverage {
  reading: Reading;
  /** Share of the collection's blocks read, 0 to 1. Null until its deployment block is known. */
  blocks: number | null;
  behind: number | null;
  wallets: { checked: number; of: number };
  /** False when the money lenses did not run: no wallet is waiting to be checked. */
  money: boolean;
  /** Money lenses whose shares are not final while wallets are unchecked: checking more can move them either way. */
  notFinal: Method[];
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
  /** How far a money trail's download or import has got, 0 to 1, while one runs on a collection that is not paused and whose worker is not silent; else null. */
  trail: number | null;
  label: string;
}

const TRAIL_READINGS: ReadonlySet<Reading> = new Set(['stored-only', 'head-unknown', 'checking', 'complete']);

/** What a label gains while a money trail loads: the lenses that need it have not run on it yet. */
export const TRAIL_LOADING = ' · money trail loading';

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
 * error says why), and what was read stands. A silent worker keeps nothing
 * current, so no reading claims progress: all but those that claim none
 * (paused, stored-only, head-unknown) read silent, and no bar moves.
 *
 * `funding` is whether an Etherscan key is set (SourcesConfig.funding, as the
 * status report reads it). Without one nothing checks wallets, so unchecked
 * wallets leave the money lenses' shares not final but are not a step in progress.
 */
export function coverage(
  c: Pick<CollectionRow, 'chainId' | 'pausedAt' | 'startBlock' | 'cursorBlock' | 'headBlock' | 'wallets' | 'fundedWallets' | 'latest'> & Partial<Pick<CollectionRow, 'restoreProgress' | 'downloadFile' | 'downloadProgress' | 'storedThroughTime' | 'storedThroughBlock' | 'transfers' | 'analysisError' | 'trailProgress'>>,
  rpcChains: ReadonlySet<number>, now: number, zone = 'UTC', funding = true, silent = false,
): Coverage {
  const money = c.latest === null ? true : c.latest.totals.AU.available || c.latest.totals.AC.available;
  const wallets = { checked: c.fundedWallets, of: c.wallets };
  const behind = c.headBlock === null || c.cursorBlock === null ? null : Math.max(0, c.headBlock - c.cursorBlock);
  const span = c.headBlock === null || c.startBlock === null ? null : c.headBlock - c.startBlock;
  const blocks = span === null || c.cursorBlock === null || c.startBlock === null ? null : span <= 0 ? 1 : Math.max(0, Math.min(1, (c.cursorBlock - c.startBlock) / span));
  const unchecked = money && wallets.checked < wallets.of;
  const notFinal: Method[] = unchecked ? METHODS.filter((m) => m !== 'A' && (c.latest?.totals[m].available ?? true)) : [];
  // A load is never resumed after a pause, so progress left on a paused collection is stale.
  // Never shown as done: the data is not there until the load commits, and then the progress is gone.
  const restore = c.pausedAt === null && (c.restoreProgress ?? null) !== null ? Math.min(c.restoreProgress!, NOT_DONE) : null;
  // The download comes first: the stored data cannot load until it has arrived. Capped like a load, for the same reason.
  const download = c.pausedAt === null && c.downloadFile === 'transfers' && (c.downloadProgress ?? null) !== null ? Math.min(c.downloadProgress!, NOT_DONE) : null;
  // Held for a download that has not started (another runs, or another replica has the lock): the worker marks the file, with no progress.
  const queued = c.pausedAt === null && download === null && c.downloadFile === 'transfers' && (c.downloadProgress ?? null) === null;
  // Nothing moves stored data, so a missing RPC is what holds the reading: whatever was read, it reads stored-only.
  const noRpc = c.pausedAt === null && restore === null && download === null && !queued && !rpcChains.has(c.chainId);
  const isStoredOnly = noRpc && storedOnly(c, rpcChains);
  // Read on past the stored data while an RPC was set: it stops at its cursor, whose time is not known. Before the block was kept, the date stands.
  const readPastStored = isStoredOnly && (c.storedThroughBlock ?? null) !== null && c.cursorBlock! > c.storedThroughBlock!;
  const stops = isStoredOnly && !readPastStored ? c.storedThroughTime! : null;
  const unsynced = stops === null ? null : unsyncedFor(now - stops);
  // Read from the chain with no stored data before the RPC went: what was read stands, so it stops at its cursor too.
  const chainRead = noRpc && !isStoredOnly && c.cursorBlock !== null && c.startBlock !== null && c.cursorBlock >= c.startBlock && (c.transfers ?? 0) > 0;
  const readTo = readPastStored || chainRead ? c.cursorBlock : null;
  // A trail loads beside the reading, not as one: the lenses that need it wait on it. The same cap as a load.
  const trailShare = c.downloadFile === 'trail' && (c.downloadProgress ?? null) !== null ? c.downloadProgress! : (c.trailProgress ?? null);
  const trail = c.pausedAt === null && !silent && trailShare !== null ? Math.min(trailShare, NOT_DONE) : null;
  // No bar under a pill moves while nothing reports.
  const base = { blocks, behind, wallets, money, notFinal, restore: silent ? null : restore, download: silent ? null : download, stops, unsynced, readTo, trail };
  // Where the trail is loading, the label says so: the reading is true, and the lenses that need the trail have not run on it.
  const out = (reading: Reading, label: string): Coverage => ({ ...base, reading, label: trail !== null && TRAIL_READINGS.has(reading) ? `${label}${TRAIL_LOADING}` : label });
  // A reading that claims progress cannot be kept while nothing reports.
  const moving = (reading: Reading, label: string): Coverage => silent ? out('silent', 'Worker silent · not kept current') : out(reading, label);
  if (download !== null) return moving('downloading', `Downloading stored data · ${floorPct(download, 1)}`);
  if (queued && restore === null) return moving('queued', 'Waiting to download stored data');
  if (restore !== null) return moving('restoring', `Loading stored data · ${progress(restore)}`);
  if (c.pausedAt !== null) return out('paused', c.cursorBlock === null || (c.startBlock !== null && c.cursorBlock < c.startBlock) ? 'Paused · not read yet' : `Paused · read to block ${num(c.cursorBlock)}`);
  // Before 'starting': with no RPC the head is never known, and the stored numbers are all there is.
  // Built on the server, so the locale is pinned; the console draws its own date with Time.
  if (stops !== null) return out('stored-only', `Stored data · stops ${localTime(stops, 'date', zone, 'en-GB')} · ${unsynced}`);
  if (readTo !== null) return out('stored-only', `Read to block ${num(readTo)} · no RPC for its chain`);
  // Nothing of stored data to show, and nothing read on: `stops` and `readTo` stay null, and the pill and summary say the missing RPC.
  if (noRpc) return out('stored-only', 'No RPC for its chain');
  // Read before, but no head now: an RPC that fails (a typo, a rate limit) never said it. The numbers are there; how far behind is not known.
  const read = c.cursorBlock !== null && c.startBlock !== null && c.cursorBlock >= c.startBlock && ((c.storedThroughTime ?? null) !== null || (c.transfers ?? 0) > 0);
  if (c.headBlock === null && read) return out('head-unknown', `Read to block ${num(c.cursorBlock!)}`);
  // An unknown head cannot be caught up to.
  if (c.cursorBlock === null || c.startBlock === null || c.headBlock === null) return moving('starting', 'Starting');
  if (behind !== null && behind > BEHIND_BLOCKS) return moving('catching-up', `Reading history · ${blocks === null ? '…' : progress(blocks)}`);
  // The wallet counts come from an analysis, so until the first one they are not zero but unknown.
  if (c.latest === null) return moving('analyzing', c.analysisError ? 'First analysis failed' : 'Analyzing');
  // Only a key checks wallets: without one (a loaded money trail, or a key just removed) nothing is in progress.
  if (unchecked && funding) return moving('checking', `Checking wallets · ${progress(wallets.of === 0 ? 0 : wallets.checked / wallets.of)}`);
  return moving('complete', 'Up to date');
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

/** A pass is running from when it starts until it finishes, and again when it restarts after an earlier finish (`finishedAt < startedAt`). The status route and the pages both decide it here. */
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
 * first, said in `zone`. While the worker is silent (workerSilent) nothing is
 * downloaded, loaded or analyzed, so no step is claimed as under way.
 */
export function analysisWaitText(c: CollectionRow, analyzePass: PassRow | undefined, names: ReadonlyMap<number, string>, rpcChains: ReadonlySet<number>, now: number, zone = 'UTC', silent = false): string {
  // Never analyzed while paused, so promise nothing.
  if (c.pausedAt !== null) return 'Paused · it is not analyzed until you resume it.';
  if (silent) return 'Not analyzed yet · the worker is silent, so nothing is read or analyzed until it reports again.';
  // Its transfers arrive all at once when the load commits; until then there is nothing to analyse.
  if (c.downloadFile === 'transfers' && (c.downloadProgress ?? null) !== null) return 'Downloading stored data · it is analyzed once it has loaded.';
  if (c.downloadFile === 'transfers') return 'Waiting to download stored data · it is analyzed once it has loaded.';
  if ((c.restoreProgress ?? null) !== null) return 'Loading stored data · it is analyzed once it has loaded.';
  if (c.transfers === 0) return rpcChains.has(c.chainId) ? 'Waiting for its first transfers.' : 'Nothing is read until its chain has an RPC.';
  const running = analyzePass && isRunning(analyzePass) && analyzePass.subjectId !== null ? analyzePass : null;
  const min = running === null ? '' : `${Math.floor((now - running.startedAt) / 60_000)} min`;
  if (running?.subjectId === c.id) return `First analysis running · started ${min} ago.`;
  // Not the next pass: it waits out its back-off whatever runs now.
  if (c.analysisError) return `Its analysis failed: ${c.analysisError} · ${analysisRetry(c, now, zone)}.`;
  if (running === null) return 'Waiting for its first analysis · the next pass starts within a minute.';
  return `Waiting for its first analysis · queued behind ${names.get(running.subjectId!) ?? 'another collection'} (running ${min}).`;
}

/** How far to trust the numbers: the sentence, and the chip that names it in a word (null: the reading is complete and there is nothing to warn of). */
type Trust = { chip: 'Shares may move' | 'Not current' | 'Starting' | null; text: string };
const say = (chip: Trust['chip'], text: string): Trust => ({ chip, text });

/** What the reading's state means for the numbers: the chip under the answer, and the sentence that says how far to trust it. A complete reading has no chip: its sentence is the whole line. */
export function trust(c: CollectionRow, cov: Coverage): Trust | null {
  // No analysis yet means no shares on screen; the empty state says why instead.
  if (c.latest === null) return null;
  if (cov.reading === 'queued') return say('Shares may move', 'Stored data is waiting to download from Hugging Face: the history it holds arrives once it has downloaded and loaded, and every share can move either way.');
  if (cov.reading === 'downloading') return say('Shares may move', 'Stored data is downloading from Hugging Face: the history it holds arrives once it has downloaded and loaded, and every share can move either way.');
  if (cov.reading === 'restoring') return say('Shares may move', 'Stored data is loading: the history it holds arrives all at once when it is done, and every share can move either way.');
  if (cov.reading === 'silent') return say('Not current', 'The worker is not reporting, so these numbers rest on what it had read before it went silent, not on the chain as it is now.');
  if (cov.reading === 'paused') return say('Not current', 'Paused: the worker is not reading new blocks, so these numbers rest on what it had read, not on the chain as it is now.');
  if (cov.reading === 'stored-only') return say('Not current', cov.stops !== null
    ? 'Stored data only: with no RPC for its chain the worker reads no newer blocks, so these numbers rest on history up to where the stored data stops.'
    : 'No RPC for its chain: the worker reads no newer blocks, so these numbers rest on what it had read, not on the chain as it is now.');
  if (cov.reading === 'head-unknown') return say('Not current', 'The chain\'s newest block is not known right now, so these numbers rest on what was read, not on the chain as it is now.');
  if (cov.reading === 'starting') return say('Starting', 'The worker is still finding where this collection begins, so there are no numbers yet.');
  if (cov.reading === 'catching-up') return say('Shares may move', `History is ${cov.blocks === null ? 'partly' : progress(cov.blocks)} read, so every share can still move either way.`);
  if (cov.reading === 'analyzing') return say('Shares may move', 'Every transfer is read. The shares, and how many wallets need checking for money, come from the first analysis, which has not finished yet.');
  const checked = progress(cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of);
  // Not final with nothing checking: no key, so the rest wait for one.
  if (cov.notFinal.length > 0 && cov.reading === 'complete') return say('Shares may move', `${checked} of wallets that traded it were checked for money, so ${lensList(cov.notFinal)} are not final: with no Etherscan key the rest go unchecked.`);
  if (cov.notFinal.length > 0) return say('Shares may move', `${checked} of wallets that traded it checked for money so far, so ${lensList(cov.notFinal)} are not final: checking the rest can move them either way.`);
  if (!cov.money) return say(null, `Every transfer is read. Money links were not checked, so only ${LENSES.A.name} ran.`);
  return say(null, 'Every transfer to the finalized head is read, and every trading wallet checked for money once: a payment made after a wallet\'s check is not seen.');
}
