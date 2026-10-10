import type { ReactNode } from 'react';
import type { CollectionRow } from '@washtrace/detect';
import { chainName } from '@/lib/chains';
import { LENSES, formatBytes, lensList, plural } from '@/lib/format';
import { downloaded, progress, restoreNext, storedOnly, type Coverage } from '@/lib/metrics';
import { Warn } from '@/components/head';
import { FIELDS } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { Time } from '@/components/time';

const PILL = {
  // A working colour like a load: it is progress, not a fault.
  downloading: 'bg-focus/12 text-focus',
  // Neutral: it has not started, so there is nothing moving to colour as work.
  queued: 'bg-muted text-muted-foreground',
  restoring: 'bg-focus/12 text-focus',
  complete: 'bg-ok/12 text-ok',
  checking: 'bg-focus/12 text-focus',
  'catching-up': 'bg-focus/12 text-focus',
  analyzing: 'bg-focus/12 text-focus',
  starting: 'bg-muted text-muted-foreground',
  // Neutral: what was read stands, and the collection's error says why the head is not known.
  'head-unknown': 'bg-muted text-muted-foreground',
  paused: 'bg-muted text-muted-foreground',
  // Neutral like paused: a limit to lift, neither a fault nor done.
  'stored-only': 'bg-muted text-muted-foreground',
} as const;

/** Readings where nothing is moving, so the pill's dot does not pulse. */
const STILL: ReadonlySet<Coverage['reading']> = new Set(['complete', 'paused', 'stored-only', 'head-unknown', 'queued']);

/**
 * How far the reading under a collection's numbers has got, as one word or
 * two. Stored-only keeps the pill short enough for its column: where the
 * data stops goes on the line under it (StoredStop).
 */
export function ReadingPill({ cov }: { cov: Coverage }) {
  const text = cov.reading !== 'stored-only' ? cov.label : cov.stops !== null ? `Stored data · ${cov.unsynced}` : 'No RPC for its chain';
  return (
    // Wraps inside its column rather than running past it: a radius that is round on one line, and the dot kept on the first.
    <span className={cn('inline-flex max-w-full items-start gap-1.5 rounded-[10px] px-2 py-0.5 text-xs font-medium', PILL[cov.reading])}>
      <i aria-hidden className={cn('mt-[5px] size-1.5 shrink-0 rounded-full bg-current', !STILL.has(cov.reading) && 'animate-pulse')} />
      {/* One flex item: the gap between several read as a double space. */}
      <span className="min-w-0">{text}</span>
    </span>
  );
}

/** Under a stored-only pill: where its data stops, the date in the reader's zone (Time, as every date in the console), or the block it was read to. */
export function StoredStop({ cov }: { cov: Coverage }) {
  if (cov.stops !== null) return <p className="text-xs text-muted-foreground">stops <Time ms={cov.stops} style="date" /></p>;
  if (cov.readTo !== null) return <p className="text-xs text-muted-foreground">read to block {cov.readTo.toLocaleString('en-US')}</p>;
  return null;
}

/**
 * Why stored data was not loaded, and what follows (restoreNext): the time of
 * a retry in the reader's zone, as every time in the console. Information,
 * not a fault: the collection is analysed on what it has meanwhile.
 */
export function RestoreNote({ c, rpcChains, className }: { c: CollectionRow; rpcChains: ReadonlySet<number>; className?: string }) {
  const n = restoreNext(c, rpcChains);
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
 * That an analysed collection's latest analysis failed, and why: the numbers
 * shown are from the one before. A fault while the worker keeps trying it,
 * with when it does next in the reader's zone; information on a paused one,
 * which nothing tries until it is resumed. Null when none failed.
 */
export function AnalysisFailed({ c, now, className }: { c: CollectionRow; now: number; className?: string }) {
  if (!c.analysisError) return null;
  if (c.pausedAt !== null) return <p className={cn('text-xs text-muted-foreground', className)}>Paused · latest analysis before the pause failed: {c.analysisError}</p>;
  const at = c.analysisRetryAt ?? null;
  return (
    <p className={cn('flex items-start gap-1 text-xs text-fault', className)}>
      <Warn className="size-3.5" />
      <span>Latest analysis failed: {c.analysisError} · {at !== null && at > now ? <>tried again after <Time ms={at} style="time" />.</> : 'due to be tried again.'}</span>
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
  if (cov.reading === 'paused') return 'Paused: the worker is not reading new blocks, so these numbers rest on what it had read, not on the chain as it is now.';
  if (cov.reading === 'stored-only') return cov.stops !== null
    ? 'Stored data only: with no RPC for its chain the worker reads no newer blocks, so these numbers rest on history up to where the stored data stops.'
    : 'No RPC for its chain: the worker reads no newer blocks, so these numbers rest on what it had read, not on the chain as it is now.';
  if (cov.reading === 'head-unknown') return 'The chain\'s newest block is not known right now, so these numbers rest on what was read, not on the chain as it is now.';
  if (cov.reading === 'starting') return 'The worker is still finding where this collection begins, so there are no numbers yet.';
  if (cov.reading === 'catching-up') return `History is ${cov.blocks === null ? 'partly' : progress(cov.blocks)} read, so every share can still move either way.`;
  if (cov.reading === 'analyzing') return 'Every transfer is read. The shares, and how many wallets need checking for money, come from the first analysis, which has not finished yet.';
  const checked = progress(cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of);
  // Floors with nothing checking: no key, so the rest wait for one.
  if (cov.floor.length > 0 && cov.reading === 'complete') return `${checked} of wallets were checked for money, so ${lensList(cov.floor)} are floors: with no Etherscan key the rest go unchecked.`;
  if (cov.floor.length > 0) return `${checked} of wallets checked for money so far, so ${lensList(cov.floor)} are floors: they can only rise.`;
  if (!cov.money) return 'Every transfer is read. Money links were not checked, so only Round trips ran.';
  return 'Every transfer to the finalized head is read, and every trading wallet checked for money.';
}

/**
 * The reading in one line, for the top of a collection: the step holding the
 * numbers back right now, how far along it is, and what that means for them.
 * Steps run in order, so a step already done is shown ticked before it: the
 * wallets are only checked once the transfers are read. The steps
 * themselves are further down the page.
 */
export function ReadingSummary({ c, cov, href }: { c: CollectionRow; cov: Coverage; href: string }) {
  const stage: { share: number; of: ReactNode; figure?: string } | null = cov.stops !== null ? { share: 1, figure: 'Stored data', of: <>stops <Time ms={cov.stops} style="date" /> · {cov.unsynced}. No newer block is read until its chain has an RPC.</> }
    : cov.readTo !== null ? { share: 1, figure: 'No RPC', of: `Read to block ${cov.readTo.toLocaleString('en-US')}. No newer block is read until its chain has an RPC.` }
    : cov.reading === 'queued' ? { share: 0, figure: 'Waiting', of: 'to download its stored data from Hugging Face' }
    : cov.reading === 'downloading' ? { share: cov.download ?? 0, figure: downloaded(cov.download ?? 0), of: 'of its stored data downloaded from Hugging Face' }
    : cov.reading === 'restoring' ? { share: cov.restore ?? 0, of: 'Loading stored data: history cut ahead of time, so the chain is read only from where it stops' }
    : cov.reading === 'catching-up' ? { share: cov.blocks ?? 0, of: 'of its history read' }
    // Step 3 says when a failed first analysis is tried again.
    : cov.reading === 'analyzing' ? { share: 0, figure: c.analysisError ? 'Failed' : 'Analyzing', of: c.analysisError ? 'the first analysis of every transfer read failed' : 'the first analysis of every transfer read' }
    : cov.reading === 'checking' ? { share: cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of, of: 'of trading wallets checked for money' }
    : cov.reading === 'paused' ? { share: cov.blocks ?? 0, of: 'of its history read when paused' }
    : cov.reading === 'head-unknown' ? { share: 1, figure: 'Head unknown', of: `${cov.label}. The chain's newest block is not known right now, so how far behind that is cannot be said.` }
    : cov.reading === 'complete' && cov.floor.length > 0 ? { share: 1, of: 'of transfers read. Wallets not yet checked for money wait for an Etherscan key' }
    : cov.reading === 'complete' ? { share: 1, of: 'read: every transfer, and every wallet the lenses need' }
    : null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-4 py-3">
      <div className="flex min-w-[14rem] flex-1 flex-wrap items-center gap-3">
        {cov.reading === 'checking' || cov.reading === 'analyzing' ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-ok/12 px-2 py-0.5 text-xs font-medium text-ok">
            <span aria-hidden>✓</span>Transfers read<span aria-hidden className="ml-1 text-muted-foreground">→</span>
          </span>
        ) : null}
        <span className="text-xl font-semibold text-foreground tabular-nums">{stage === null ? '…' : stage.figure ?? progress(stage.share)}</span>
        <div className="min-w-[11rem] flex-1">
          <p className="text-xs text-muted-foreground">{stage === null ? 'Finding where the collection begins' : stage.of}</p>
          <div className="mt-1 max-w-md"><Bar share={stage?.share ?? 0} paused={cov.reading === 'paused' || cov.reading === 'stored-only' || cov.reading === 'head-unknown'} /></div>
        </div>
      </div>
      <p className="max-w-xl text-xs text-muted-foreground">{trust(c, cov)} <a href={href} className="whitespace-nowrap underline hover:text-foreground">The three steps ↓</a></p>
    </div>
  );
}

/** How far a download or a load of stored data has got, as a bar under the pill that says it in words: the list row's view of it. */
export function RestoreProgress({ cov }: { cov: Coverage }) {
  if (cov.download !== null) return <div className="w-full max-w-44"><Bar share={cov.download} name="download" /></div>;
  if (cov.restore === null) return null;
  return <div className="w-full max-w-44"><Bar share={cov.restore} name="restore" /></div>;
}

/** Never green when paused (or stored-only): the head is frozen, so a full bar would claim it is current. */
function Bar({ share, paused = false, name }: { share: number; paused?: boolean; name?: string }) {
  return (
    <span aria-hidden data-bar={name} className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <i className={cn('block h-full rounded-full', share >= 1 && !paused ? 'bg-ok' : 'bg-muted-foreground')} style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
    </span>
  );
}

function Step({ n, title, figure, value, bar, paused, affects, children }: { n: number; title: string; figure: ReactNode; value: ReactNode; bar?: number; paused?: boolean; affects: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative flex flex-col gap-1 px-4 py-3.5">
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums">{n}</span>{title}
      </p>
      <p className="text-xl font-semibold text-foreground tabular-nums">{figure}</p>
      {bar !== undefined ? <Bar share={bar} paused={paused} /> : null}
      <p className="text-xs tabular-nums">{value}</p>
      {children}
      <p className="mt-auto pt-1.5 text-xs text-muted-foreground"><span className="font-medium text-body">Affects </span>{affects}</p>
    </li>
  );
}

/**
 * Step 1's line. A paused collection's head stopped moving when it paused, so
 * nothing computed from the head is said of it but where it had read to.
 * Stored data with no RPC has no head at all: it says where the data stops.
 */
function step1(c: CollectionRow, cov: Coverage): ReactNode {
  const unread = c.cursorBlock === null || (c.startBlock !== null && c.cursorBlock < c.startBlock);
  if (cov.reading === 'restoring' || cov.reading === 'downloading' || cov.reading === 'queued') return cov.label;
  if (cov.stops !== null) return <>{plural(c.transfers, 'transfer')} from stored data, through block {c.cursorBlock!.toLocaleString('en-US')} (<Time ms={cov.stops} style="date" />)</>;
  if (cov.readTo !== null) return `${plural(c.transfers, 'transfer')} · read to block ${cov.readTo.toLocaleString('en-US')} · no RPC for its chain`;
  if (c.pausedAt !== null) return unread ? 'Not read yet · paused' : `${plural(c.transfers, 'transfer')} · read to block ${c.cursorBlock!.toLocaleString('en-US')} when paused`;
  if (c.cursorBlock === null) return 'Finding the deployment block…';
  if (cov.behind === null) return `${plural(c.transfers, 'transfer')} so far · block ${c.cursorBlock.toLocaleString()}, head not known yet`;
  if (cov.behind === 0) return `${plural(c.transfers, 'transfer')}, through the finalized head (block ${c.cursorBlock.toLocaleString()})`;
  return `${plural(c.transfers, 'transfer')} so far · block ${c.cursorBlock.toLocaleString()}, ${plural(cov.behind, 'block')} to go`;
}

/**
 * The pipeline under the numbers, step by step, each saying which part of
 * the answer it holds up. Ingest, fund, analyze: the worker's three jobs,
 * seen from the collection. It leads the page, because it says how far to
 * trust everything after it.
 *
 * `funding` is whether an Etherscan key is set. `funded` is whether the next
 * analysis has funding for the money lenses: a key, or this collection's
 * loaded trail with checked wallets (as the lens cards are told). `trail` is
 * the stored money trail's coverage, as the manifest gives it, when the trail
 * it describes is the one this collection loaded; else null. `trailBytes` is
 * the size of the trail the manifest lists, said while it downloads. `now` says
 * whether a failed analysis's wait is over.
 */
export function ReadingPanel({ c, cov, why, rpcChains, funding = true, funded, trail = null, trailBytes = null, now = Date.now() }: {
  c: CollectionRow; cov: Coverage; why: string; rpcChains: ReadonlySet<number>; funding?: boolean; funded?: boolean; trail?: { checked: number; of: number } | null; trailBytes?: number | null; now?: number;
}) {
  const a = c.latest;
  const stored = cov.reading === 'stored-only';
  const trailed = c.trailImportedSha != null;
  // A loaded money trail is funding once it checked a wallet: the money lenses run on it, key or not, from the next analysis on.
  const fed = funded ?? (funding || trailed);
  const money = cov.money || fed;
  return (
    <ol className="grid divide-y rounded-lg border bg-card md:grid-cols-3 md:divide-x md:divide-y-0">
      <Step
        n={1} title="Transfers read"
        figure={cov.reading === 'queued' ? <span className="text-base">Waiting</span> : cov.reading === 'downloading' ? downloaded(cov.download ?? 0) : cov.reading === 'restoring' ? progress(cov.restore ?? 0) : stored ? <span className="text-base">{cov.stops !== null ? 'Stored data' : 'No RPC'}</span>
          : cov.reading === 'head-unknown' ? <span className="text-base">Head unknown</span> : cov.blocks === null ? '…' : progress(cov.blocks)}
        bar={cov.reading === 'head-unknown' ? undefined : cov.reading === 'queued' ? 0 : cov.reading === 'downloading' ? cov.download ?? 0 : cov.reading === 'restoring' ? cov.restore ?? 0 : stored ? 1 : cov.blocks ?? 0} paused={cov.reading === 'paused' || stored}
        value={step1(c, cov)}
        affects="all three lenses. Unread history can move any share either way."
      >
        {/* A "No RPC" left from before the stored data loaded is no fault, paused or not: the worker clears it on its next pass. */}
        {/* Nor one on a paused collection: the worker does not touch it, so it cannot clear it, and nothing is failing now. */}
        {c.error && !storedOnly(c, rpcChains) ? c.pausedAt !== null
          ? <p className="text-xs text-muted-foreground">Paused · last error before the pause: {c.error}</p>
          : <p className="flex items-start gap-1 text-xs text-fault"><Warn className="size-3.5" />Last read failed: {c.error}</p> : null}
        {stored ? (
          <p className="text-xs text-muted-foreground">
            {cov.unsynced !== null ? `${cov.unsynced}: no` : 'No'} RPC is set for {chainName(c.chainId)}, so no newer block is read.{' '}
            {FIELDS.some((f) => f.key === `rpc.${c.chainId}`)
              ? <a href={`/settings#rpc.${c.chainId}`} className="underline hover:text-foreground">Set one in Settings to read on from here</a>
              : <>Set WASHTRACE_RPC_{c.chainId} for the worker to read on from here.</>}
          </p>
        ) : null}
        <RestoreNote c={c} rpcChains={rpcChains} />
      </Step>
      <Step
        n={2} title="Wallets checked for money"
        figure={!money ? 'Off' : a === null ? '…' : progress(cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of)}
        bar={money && a !== null ? (cov.wallets.of > 0 ? cov.wallets.checked / cov.wallets.of : 0) : undefined}
        value={!money ? `${trailed ? 'The stored money trail checked no wallet, and no' : 'No'} funding source is set (WASHTRACE_ETHERSCAN_KEY).`
          : a === null ? 'Counted by the first analysis. Funding read for these wallets before is kept.'
          : `${cov.wallets.checked.toLocaleString('en-US')} of ${cov.wallets.of.toLocaleString('en-US')} trading wallets, busiest first`}
        affects={<>{LENSES.AU.name} and {LENSES.AC.name}. An unchecked wallet hides its links, so their shares can only rise.</>}
      >
        {trailed ? (
          <p className="text-xs text-muted-foreground">
            Money trail loaded from stored data{trail ? ` · ${trail.checked.toLocaleString('en-US')} of ${trail.of.toLocaleString('en-US')} traders checked` : ''}
          </p>
        ) : null}
        {trailed && !funding && fed ? (
          <p className="text-xs text-muted-foreground">
            Using the stored money trail; <a href="/settings#etherscan.key" className="underline hover:text-foreground">add an Etherscan key</a> to check newer wallets.
          </p>
        ) : null}
        {/* Download of the money trail: the transfers are read already; this is the file the lenses feed on. Working, not a fault. */}
        {c.pausedAt === null && c.downloadFile === 'trail' && c.downloadProgress !== null
          ? <p className="text-xs text-muted-foreground">Money trail downloading from stored data · {downloaded(c.downloadProgress)}{trailBytes === null ? '' : ` of ${formatBytes(trailBytes)}`}</p> : null}
        {/* Import of the downloaded trail: it runs after the download, never beside it. The lenses wait for it, so this is working too. */}
        {c.pausedAt === null && c.trailProgress !== null
          ? <p className="text-xs text-muted-foreground">Money trail loading from stored data · {downloaded(c.trailProgress)}</p> : null}
        <DownloadNote c={c} />
        {/* Why a trail on disk did not load: information, since the lenses run as they would without it. */}
        {c.trailNote ? <p className="text-xs text-muted-foreground">{c.trailNote}</p> : null}
        {a && a.truncatedSearches > 0 ? <p className="text-xs text-muted-foreground">{plural(a.truncatedSearches, 'money search')} stopped at the visit cap before following every hop.</p> : null}
      </Step>
      <Step
        n={3} title="Analyzed"
        figure={a === null ? 'Not yet' : <span className="text-base"><Time ms={a.ranAt} /></span>}
        value={a === null ? why : <>took {a.tookMs < 10_000 ? `${a.tookMs} ms` : a.tookMs < 120_000 ? `${(a.tookMs / 1000).toFixed(0)} s` : `${(a.tookMs / 60_000).toFixed(1)} min`}{c.analysisError ? <span className="text-muted-foreground"> · still shown: the latest analysis failed</span> : c.stale ? <span className="text-muted-foreground"> · new data waiting for the next run</span> : c.trailProgress !== null ? ' · money trail loading; analysed again once it has' : ' · nothing new since'}</>}
        affects="every number on this page: it turns steps 1 and 2 into them."
      >
        {/* With no analysis yet, `why` says it failed. */}
        {a ? <AnalysisFailed c={c} now={now} /> : null}
        {a ? <p className="text-xs text-muted-foreground">Gaps in history: {(a.missingData * 100).toFixed(1)}% of changes of owner (skipped, never guessed).</p> : null}
      </Step>
    </ol>
  );
}
