import { BEHIND_BLOCKS, NOT_DONE, TRAIL_NOTES, reaches, type CollectionRow, type StoredEntry } from '@washtrace/detect';
import { ETHERSCAN_CTA, ETHERSCAN_HREF, LENSES, STAGES } from './format';

export type StageKey = 'download' | 'load' | 'stored-analysis' | 'chain' | 'money' | 'analysis';
export type StageState = 'waiting' | 'running' | 'done' | 'not-needed' | 'blocked' | 'failed' | 'paused' | 'live' | 'silent';

export interface Stage {
  key: StageKey;
  n: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  state: StageState;
  /** 0 to 1 while running (and 1 when live); else null. */
  share: number | null;
  /** Which stored file stages 1 and 2 are on while running; else null. */
  file: 'transfers' | 'trail' | null;
  feeds: string;
  /** Set only when blocked: what to add, and where (null href: not a console setting). */
  needs: { text: string; href: string | null } | null;
  /** Set only when not-needed: the sentence that says why. */
  skipped: string | null;
}

export interface PipelineInput {
  c: CollectionRow;
  entry: StoredEntry | null;
  rpcChains: ReadonlySet<number>;
  /** An Etherscan key is set (SourcesConfig.funding). */
  funding: boolean;
  /** The analyze pass is running on this collection now. */
  analyzing: boolean;
  /** No pass has shown a sign of life (workerSilent): nothing is being kept current. */
  silent: boolean;
}

/** The chip's word for each state; a missing key reads as the action it needs, never as Off. */
export const STATE_WORDS: Record<StageState, string> = {
  waiting: 'Waiting', running: 'Running', done: 'Done', 'not-needed': 'Not needed',
  blocked: 'Needs a key', failed: 'Failed', paused: 'Paused', live: 'Following', silent: 'Worker silent',
};

/** A blocked chain stage lacks an RPC, not a key (the money stage's blocked word): the chip says which. */
export const stateWord = (n: Stage['n'], state: StageState): string => (n === 4 && state === 'blocked' ? 'No RPC' : STATE_WORDS[state]);

const FEEDS = [
  'stage 2: the history it holds arrives once it has downloaded.',
  `every lens: the history up to where the stored data stops, and the money trail for ${LENSES.AU.name} and ${LENSES.AC.name}.`,
  'every number on this page until the chain is read.',
  'every lens. Unread history can move any share either way.',
  `${LENSES.AU.name} and ${LENSES.AC.name}. An unchecked wallet hides its links, so their shares are not final until it is checked.`,
  'every number on this page: it turns stages 1 to 5 into them.',
] as const;
const NO_STORED = 'No stored data for this collection.';
const READ_PAST = 'Read past its stored data from the chain, so it was not needed.';
const READ_BEFORE = 'Its reading started before its stored data, so it was not needed.';
const KEYS: StageKey[] = ['download', 'load', 'stored-analysis', 'chain', 'money', 'analysis'];

/**
 * A collection's reading as six stages, each in one state, from the columns
 * the worker already writes: nothing is stored for the display. Stages 4 and 5
 * run side by side, so the stages are not a strict sequence. A trail that has
 * downloaded but not started importing reads as waiting, because the row
 * cannot tell it from one not downloaded yet.
 *
 * Three rules look like they could be simplified, and must not be. Stage 1 is
 * done while the transfers load (`restoreProgress`): the file has arrived, and
 * Waiting beside a running stage 2 on the same file would be false; but with a
 * trail still to come it stays waiting through the load. A `restoreNote` does
 * not count, since a load can be noted missing with no download. Stage 4 waits
 * on unloaded stored transfers only when no load or download failed: after
 * either note the worker reads the chain as if there were no stored data
 * (StoredSync.restore); a load being retried is not a failed one, so the note does
 * not count while it runs. Running shares of stages 1 and 2 stop at 99%, as
 * coverage() does: the data is not there until the load commits. Stage 6 checks running before failed,
 * so a retry of a failed analysis reads as running, not as still failed; and
 * while stage 3 is the one retrying, stage 6 waits rather than showing the old
 * failure. Stage 2 fails on any trail note, not only a failed import: the worker
 * does not retry a mismatch or unreadable trail until the file changes, so
 * Waiting would last forever. Stage 3 is about stored data that is loaded: after
 * a failed load the worker analyses what it has, and that shows at stage 6.
 * A silent worker keeps nothing current, so a stage that would be running or
 * following reads silent with no share; paused still wins, and a stage that is
 * done or not needed stands.
 */
export function pipeline({ c, entry, rpcChains, funding, analyzing, silent }: PipelineInput): Stage[] {
  const transfers = c.storedThroughTime !== null ? 'loaded'
    : entry === null ? 'none'
    : !reaches(c, entry) ? 'read-past'
    : 'pending';
  const trail = entry?.trail == null ? 'none'
    : c.trailImportedSha === entry.trail.sha256 ? 'loaded'
    : c.trailProgress !== null ? 'importing'
    : 'pending';
  // failed and unreadable are noted only after the file was read, so it had arrived; mismatch is noted without it.
  const trailRead = c.trailNote === TRAIL_NOTES.failed || c.trailNote === TRAIL_NOTES.unreadable;
  // Stages 1 to 3 are not needed for one reason, so they say one thing. `reaches()` is false for read-past either way, but only a cursor at or beyond the stored end has read past it.
  const skipped = transfers === 'none' ? NO_STORED : entry !== null && c.cursorBlock !== null && c.cursorBlock >= entry.throughBlock ? READ_PAST : READ_BEFORE;
  const nothingToLoad = (transfers === 'none' || transfers === 'read-past') && trail === 'none';

  type Part = Pick<Stage, 'state'> & Partial<Pick<Stage, 'share' | 'file' | 'needs'>>;

  let download: Part = { state: 'waiting' };
  if (nothingToLoad) download = { state: 'not-needed' };
  else if (c.downloadFile !== null && c.downloadProgress !== null) download = { state: 'running', share: Math.min(c.downloadProgress, NOT_DONE), file: c.downloadFile as 'transfers' | 'trail' };
  // Held for a download that has not started: the pill says so, whatever else is loaded.
  else if (c.downloadFile !== null) download = { state: 'waiting' };
  else if (c.downloadNote !== null) download = { state: 'failed' };
  else if ((transfers !== 'pending' || c.restoreProgress !== null) && (trail !== 'pending' || trailRead)) download = { state: 'done' };

  let load: Part = { state: 'waiting' };
  if (nothingToLoad) load = { state: 'not-needed' };
  else if (c.restoreProgress !== null) load = { state: 'running', share: Math.min(c.restoreProgress, NOT_DONE), file: 'transfers' };
  else if (c.trailProgress !== null) load = { state: 'running', share: Math.min(c.trailProgress, NOT_DONE), file: 'trail' };
  else if (c.restoreNote !== null || c.trailNote !== null) load = { state: 'failed' };
  else if ((transfers === 'loaded' || transfers === 'none' || transfers === 'read-past') && (trail === 'loaded' || trail === 'none')) load = { state: 'done' };

  let stored: Part = { state: 'waiting' };
  if (transfers === 'none' || transfers === 'read-past') stored = { state: 'not-needed' };
  else if (c.latest?.throughBlock != null && c.storedThroughBlock !== null && c.latest.throughBlock >= c.storedThroughBlock) stored = { state: 'done' };
  else if (transfers !== 'loaded') stored = { state: 'waiting' };
  else if (analyzing) stored = { state: 'running' };
  else if (c.analysisError !== null) stored = { state: 'failed' };

  let chain: Part = { state: 'live', share: 1 };
  const { startBlock, cursorBlock, headBlock } = c;
  if (!rpcChains.has(c.chainId)) {
    chain = {
      state: 'blocked',
      needs: c.chainId === 1
        ? { text: 'Add an RPC URL in Settings →', href: '/settings#rpc.1' }
        : { text: `Set WASHTRACE_RPC_${c.chainId} for the worker to read this chain.`, href: null },
    };
  } else if (transfers === 'pending' && c.downloadNote === null && (c.restoreNote === null || c.restoreProgress !== null)) chain = { state: 'waiting' };
  else if (c.error !== null) chain = { state: 'failed' };
  else if (startBlock === null || cursorBlock === null || headBlock === null) chain = { state: 'waiting' };
  else if (headBlock - cursorBlock > BEHIND_BLOCKS) {
    // The same share as coverage().blocks.
    const span = headBlock - startBlock;
    chain = { state: 'running', share: span <= 0 ? 1 : Math.min(1, Math.max(0, (cursorBlock - startBlock) / span)) };
  }

  let money: Part = { state: 'done' };
  if (!funding) money = { state: 'blocked', needs: { text: ETHERSCAN_CTA, href: ETHERSCAN_HREF } };
  else if (c.latest === null) money = { state: 'waiting' };
  else if (c.fundedWallets < c.wallets) money = { state: 'running', share: c.fundedWallets / c.wallets };

  let analysis: Part = { state: 'done' };
  if (analyzing && stored.state !== 'running') analysis = { state: 'running' };
  else if (c.analysisError !== null && !analyzing) analysis = { state: 'failed' };
  else if (c.latest === null || c.stale) analysis = { state: 'waiting' };

  return [download, load, stored, chain, money, analysis].map((part, i) => {
    const paused = c.pausedAt !== null && part.state !== 'done' && part.state !== 'not-needed';
    const quiet = !paused && silent && (part.state === 'running' || part.state === 'live');
    return {
      key: KEYS[i]!,
      n: (i + 1) as Stage['n'],
      title: STAGES[i]!.title,
      state: paused ? 'paused' : quiet ? 'silent' : part.state,
      share: paused || quiet ? null : part.share ?? null,
      file: paused || quiet ? null : part.file ?? null,
      feeds: FEEDS[i]!,
      needs: paused ? null : part.needs ?? null,
      // Paused leaves a not-needed stage alone, so its sentence stays.
      skipped: part.state === 'not-needed' ? skipped : null,
    };
  });
}

/**
 * Whether a stored money trail with checked wallets is on its way: the manifest
 * has one that is not the one loaded, on a collection that is not paused. The
 * worker does not retry a mismatched or unreadable one until the file changes,
 * so "on its way" would last forever; a failed import it does retry.
 */
export function trailComing(c: Pick<CollectionRow, 'trailImportedSha' | 'pausedAt' | 'trailNote'>, entry: StoredEntry | null): boolean {
  if (entry?.trail == null || c.pausedAt !== null) return false;
  if (c.trailNote === TRAIL_NOTES.mismatch || c.trailNote === TRAIL_NOTES.unreadable) return false;
  return entry.trail.sha256 !== c.trailImportedSha && entry.trail.checked > 0;
}
