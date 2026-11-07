import type { ReactNode } from 'react';
import Link from 'next/link';
import type { CollectionRow } from '@washtrace/detect';
import { LENSES, lensList, num } from '@/lib/format';
import { TRAIL_LOADING, downloaded, progress, restoreNext, type Coverage } from '@/lib/coverage';
import { Bar, Pill, Warn, type PillTone } from '@/components/head';
import type { Stage } from '@/lib/pipeline';
import { cn } from '@/lib/utils';
import { Time } from '@/components/time';

/** Each reading's pill hue: progress is blue, done is green, and everything that is not moving is grey (the limit, a pause or a silent worker is not a fault). */
const TONE: Record<Coverage['reading'], PillTone> = {
  downloading: 'working',
  queued: 'idle',
  restoring: 'working',
  complete: 'done',
  checking: 'working',
  'catching-up': 'working',
  analyzing: 'working',
  starting: 'idle',
  // Neutral: what was read stands, and the collection's error says why the head is not known.
  'head-unknown': 'idle',
  paused: 'idle',
  // Neutral like paused: nothing reports, so there is no progress to colour.
  silent: 'idle',
  // Neutral like paused: a limit to lift, neither a fault nor done.
  'stored-only': 'idle',
};

/** Readings where nothing is moving, so the pill's dot does not pulse. */
const STILL: ReadonlySet<Coverage['reading']> = new Set(['complete', 'paused', 'stored-only', 'head-unknown', 'queued', 'silent']);

/**
 * How far the reading under a collection's numbers has got, as one word or
 * two. Stored-only keeps the pill short enough for its column: where the
 * data stops goes on the line under it (StoredStop).
 */
export function ReadingPill({ cov }: { cov: Coverage }) {
  const stored = cov.stops !== null ? `Stored data · ${cov.unsynced}` : 'No RPC for its chain';
  const text = cov.reading !== 'stored-only' ? cov.label : cov.trail !== null ? `${stored}${TRAIL_LOADING}` : stored;
  return (
    // Wraps inside its column rather than running past it: a radius that is round on one line, and the dot kept on the first.
    <Pill tone={TONE[cov.reading]} className="inline-flex max-w-full items-start gap-1.5">
      <i aria-hidden className={cn('mt-[5px] size-1.5 shrink-0 rounded-full bg-current', !STILL.has(cov.reading) && 'animate-pulse')} />
      {/* One flex item: the gap between several read as a double space. */}
      <span className="min-w-0">{text}</span>
    </Pill>
  );
}

/** Under a stored-only pill: where its data stops, the date in the reader's zone (Time, as every date in the console), or the block it was read to. */
export function StoredStop({ cov }: { cov: Coverage }) {
  if (cov.stops !== null) return <p className="text-xs text-muted-foreground">stops <Time ms={cov.stops} style="date" /></p>;
  if (cov.readTo !== null) return <p className="text-xs text-muted-foreground">read to block {num(cov.readTo)}</p>;
  return null;
}

/**
 * Why stored data was not loaded, and what follows (restoreNext): the time of
 * a retry in the reader's zone, as every time in the console. Information,
 * not a fault: the collection is analyzed on what it has meanwhile.
 */
export function RestoreNote({ c, rpcChains, now, className }: { c: CollectionRow; rpcChains: ReadonlySet<number>; now: number; className?: string }) {
  const n = restoreNext(c, rpcChains, now);
  if (n === null) return null;
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {n.note}{n.then === null ? null : <> {n.then}</>}{n.retryAt === null ? null : <> <Time ms={n.retryAt} style="time" />.</>}
    </p>
  );
}

/**
 * Why stored data could not be downloaded, as the worker wrote it (it says
 * the retry itself). Information, not a fault: the chain is read meanwhile
 * where there is an RPC. Nothing for a paused collection, which tries nothing.
 */
export function DownloadNote({ c, className }: { c: CollectionRow; className?: string }) {
  if (!c.downloadNote || c.pausedAt !== null) return null;
  return <p className={cn('text-xs text-muted-foreground', className)}>{c.downloadNote}</p>;
}

/**
 * That an analyzed collection's latest analysis failed, and why: the numbers
 * shown are from the one before. A fault while the worker keeps trying it,
 * with when it does next in the reader's zone; information on a paused one,
 * which nothing tries until it is resumed. `retrying` is whether the analysis
 * is running again now (stage 6): it is then tried, not due. Null when none failed.
 */
export function AnalysisFailed({ c, now, retrying = false, className }: { c: CollectionRow; now: number; retrying?: boolean; className?: string }) {
  if (!c.analysisError) return null;
  if (c.pausedAt !== null) return <p className={cn('text-xs text-muted-foreground', className)}>Paused · latest analysis before the pause failed: {c.analysisError}</p>;
  const at = c.analysisRetryAt ?? null;
  return (
    <p className={cn('flex items-start gap-1 text-xs text-fault', className)}>
      <Warn className="size-3.5" />
      <span>Latest analysis failed: {c.analysisError} · {retrying ? 'trying again now.' : at !== null && at > now ? <>tried again after <Time ms={at} style="time" />.</> : 'due to be tried again.'}</span>
    </p>
  );
}

/** What the reading's state means for the numbers: the sentence under the answer that says how far to trust it. */
export function trust(c: CollectionRow, cov: Coverage): string | null {
  // No analysis yet means no shares on screen; the empty state says why instead.
  if (c.latest === null) return null;
  if (cov.reading === 'queued') return 'Stored data is waiting to download from Hugging Face: the history it holds arrives once it has downloaded and loaded, and every share can move either way.';
  if (cov.reading === 'downloading') return 'Stored data is downloading from Hugging Face: the history it holds arrives once it has downloaded and loaded, and every share can move either way.';
  if (cov.reading === 'restoring') return 'Stored data is loading: the history it holds arrives all at once when it is done, and every share can move either way.';
  if (cov.reading === 'silent') return 'The worker is not reporting, so these numbers rest on what it had read before it went silent, not on the chain as it is now.';
  if (cov.reading === 'paused') return 'Paused: the worker is not reading new blocks, so these numbers rest on what it had read, not on the chain as it is now.';
  if (cov.reading === 'stored-only') return cov.stops !== null
    ? 'Stored data only: with no RPC for its chain the worker reads no newer blocks, so these numbers rest on history up to where the stored data stops.'
    : 'No RPC for its chain: the worker reads no newer blocks, so these numbers rest on what it had read, not on the chain as it is now.';
  if (cov.reading === 'head-unknown') return 'The chain\'s newest block is not known right now, so these numbers rest on what was read, not on the chain as it is now.';
  if (cov.reading === 'starting') return 'The worker is still finding where this collection begins, so there are no numbers yet.';
  if (cov.reading === 'catching-up') return `History is ${cov.blocks === null ? 'partly' : progress(cov.blocks)} read, so every share can still move either way.`;
  if (cov.reading === 'analyzing') return 'Every transfer is read. The shares, and how many wallets need checking for money, come from the first analysis, which has not finished yet.';
  const checked = progress(cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of);
  // Not final with nothing checking: no key, so the rest wait for one.
  if (cov.notFinal.length > 0 && cov.reading === 'complete') return `${checked} of wallets that traded it were checked for money, so ${lensList(cov.notFinal)} are not final: with no Etherscan key the rest go unchecked.`;
  if (cov.notFinal.length > 0) return `${checked} of wallets that traded it checked for money so far, so ${lensList(cov.notFinal)} are not final: checking the rest can move them either way.`;
  if (!cov.money) return `Every transfer is read. Money links were not checked, so only ${LENSES.A.name} ran.`;
  return 'Every transfer to the finalized head is read, and every trading wallet checked for money once: a payment made after a wallet\'s check is not seen.';
}

/**
 * The reading in one line, for the top of a collection: what holds the
 * numbers back right now, how far along it is, and what that means for them.
 * The figure and bar follow the coverage; the stages are further down the
 * page, and `stages`, when given, adds what blocks the reading on a missing
 * key, as a link to where it is added. Wallets are only checked once the
 * transfers are read, so the wallets are shown with the transfers ticked
 * before them.
 */
export function ReadingSummary({ c, cov, href, stages }: { c: CollectionRow; cov: Coverage; href: string; stages?: Stage[] }) {
  // Stages 4 and 5 are the ones a missing key blocks; a paused collection is blocked by nothing (pipeline() clears needs).
  const blocked = (stages ?? []).filter((x) => (x.key === 'chain' || x.key === 'money') && x.state === 'blocked' && x.needs !== null && c.pausedAt === null);
  // A retry of the first analysis is running: Failed is the last outcome, and Analyzing is what is true now.
  const retrying = (stages ?? []).some((x) => (x.key === 'stored-analysis' || x.key === 'analysis') && x.state === 'running');
  const failed = c.analysisError && !retrying;
  // Everything is read but no key checks the wallets: the same sentence as when links are missing, since a key just added is also without money lenses.
  const waitsForKey = cov.notFinal.length > 0 || (stages ?? []).some((x) => x.key === 'money' && x.state === 'blocked');
  const stage: { share: number; of: ReactNode; figure?: string } | null = cov.stops !== null ? { share: 1, figure: 'Stored data', of: <>stops <Time ms={cov.stops} style="date" /> · {cov.unsynced}. No newer block is read until its chain has an RPC.</> }
    : cov.readTo !== null ? { share: 1, figure: 'No RPC', of: `Read to block ${num(cov.readTo)}. No newer block is read until its chain has an RPC.` }
    : cov.reading === 'stored-only' ? { share: 0, figure: 'No RPC', of: 'Nothing is read until its chain has an RPC.' }
    : cov.reading === 'silent' ? { share: cov.blocks ?? 0, figure: 'Silent', of: 'The worker is not reporting, so nothing here is kept current' }
    : cov.reading === 'queued' ? { share: 0, figure: 'Waiting', of: 'to download its stored data from Hugging Face' }
    : cov.reading === 'downloading' ? { share: cov.download ?? 0, figure: downloaded(cov.download ?? 0), of: 'of its stored data downloaded from Hugging Face' }
    : cov.reading === 'restoring' ? { share: cov.restore ?? 0, of: 'Loading stored data: history cut ahead of time, so the chain is read only from where it stops' }
    : cov.reading === 'catching-up' ? { share: cov.blocks ?? 0, of: 'of its history read' }
    // Stage 6 says when a failed first analysis is tried again.
    : cov.reading === 'analyzing' ? { share: 0, figure: failed ? 'Failed' : 'Analyzing', of: failed ? 'the first analysis of every transfer read failed' : 'the first analysis of every transfer read' }
    : cov.reading === 'checking' ? { share: cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of, of: 'of wallets that traded it checked for money' }
    : cov.reading === 'paused' ? { share: cov.blocks ?? 0, of: 'of its history read when paused' }
    : cov.reading === 'head-unknown' ? { share: 1, figure: 'Head unknown', of: `${cov.label}. The chain's newest block is not known right now, so how far behind that is cannot be said.` }
    : cov.reading === 'complete' && waitsForKey ? { share: 1, of: 'of transfers read. Wallets not yet checked for money wait for an Etherscan key' }
    : cov.reading === 'complete' ? { share: 1, of: 'read: every transfer, and every wallet the lenses need' }
    : null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-4 py-3">
      <div className="flex min-w-[14rem] flex-1 flex-wrap items-center gap-3">
        {cov.reading === 'checking' || cov.reading === 'analyzing' ? (
          <Pill tone="done" className="flex shrink-0 items-center gap-1.5">
            <span aria-hidden>✓</span>Transfers read<span aria-hidden className="ml-1 text-muted-foreground">→</span>
          </Pill>
        ) : null}
        <span data-progress className="text-xl font-semibold text-foreground tabular-nums">{stage === null ? '…' : stage.figure ?? progress(stage.share)}</span>
        <div className="min-w-[11rem] flex-1">
          <p className="text-xs text-muted-foreground">{stage === null ? 'Finding where the collection begins' : stage.of}</p>
          <div className="mt-1 max-w-md"><Bar share={stage?.share ?? 0} paused={cov.reading === 'paused' || cov.reading === 'silent' || cov.reading === 'stored-only' || cov.reading === 'head-unknown'} /></div>
        </div>
      </div>
      <p className="max-w-xl text-xs text-muted-foreground">{trust(c, cov)} <a href={href} className="whitespace-nowrap underline hover:text-foreground">The six stages ↓</a></p>
      {blocked.length > 0 ? (
        <p className="w-full text-xs text-muted-foreground">
          Blocked:{' '}
          {blocked.map((x, i) => (
            <span key={x.key}>{i > 0 ? ' · ' : null}{x.needs!.href ? <Link href={x.needs!.href} className="underline hover:text-foreground">{x.needs!.text}</Link> : x.needs!.text}</span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/** How far a download or a load of stored data has got, as a bar under the pill that says it in words: the list row's view of it. */
export function RestoreProgress({ cov }: { cov: Coverage }) {
  if (cov.download !== null) return <div className="w-full max-w-44"><Bar share={cov.download} name="download" /></div>;
  if (cov.restore === null) return null;
  return <div className="w-full max-w-44"><Bar share={cov.restore} name="restore" /></div>;
}
