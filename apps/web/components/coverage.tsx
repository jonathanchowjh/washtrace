import type { ReactNode } from 'react';
import type { CollectionRow } from '@washtrace/detect';
import { chainName } from '@/lib/chains';
import { LENSES, lensList, plural } from '@/lib/format';
import { progress, storedOnly, type Coverage } from '@/lib/metrics';
import { Warn } from '@/components/head';
import { FIELDS } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { Time } from '@/components/time';

const PILL = {
  restoring: 'bg-focus/12 text-focus',
  complete: 'bg-ok/12 text-ok',
  checking: 'bg-focus/12 text-focus',
  'catching-up': 'bg-focus/12 text-focus',
  starting: 'bg-muted text-muted-foreground',
  paused: 'bg-muted text-muted-foreground',
  // Neutral like paused: a limit to lift, neither a fault nor done.
  'stored-only': 'bg-muted text-muted-foreground',
} as const;

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
      <i aria-hidden className={cn('mt-[5px] size-1.5 shrink-0 rounded-full bg-current', cov.reading !== 'complete' && cov.reading !== 'paused' && cov.reading !== 'stored-only' && 'animate-pulse')} />
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

/** What the reading's state means for the numbers: the sentence under the answer that says how far to trust it. */
export function trust(c: CollectionRow, cov: Coverage): string | null {
  // No analysis yet means no shares on screen; the empty state says why instead.
  if (c.latest === null) return null;
  if (cov.reading === 'restoring') return 'Stored data is loading: the history it holds arrives all at once when it is done, and every share can move either way.';
  if (cov.reading === 'paused') return 'Paused: the worker is not reading new blocks, so these numbers rest on what it had read, not on the chain as it is now.';
  if (cov.reading === 'stored-only') return cov.stops !== null
    ? 'Stored data only: with no RPC for its chain the worker reads no newer blocks, so these numbers rest on history up to where the stored data stops.'
    : 'No RPC for its chain: the worker reads no newer blocks, so these numbers rest on what it had read, not on the chain as it is now.';
  if (cov.reading === 'starting') return 'The worker is still finding where this collection begins, so there are no numbers yet.';
  if (cov.reading === 'catching-up') return `History is ${cov.blocks === null ? 'partly' : progress(cov.blocks)} read, so every share can still move either way.`;
  if (cov.floor.length > 0) return `${progress(cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of)} of wallets checked for money so far, so ${lensList(cov.floor)} are floors: they can only rise.`;
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
    : cov.reading === 'restoring' ? { share: cov.restore ?? 0, of: 'Loading stored data: history cut ahead of time, so the chain is read only from where it stops' }
    : cov.reading === 'catching-up' ? { share: cov.blocks ?? 0, of: 'of its history read' }
    : cov.reading === 'checking' ? { share: cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of, of: 'of trading wallets checked for money' }
    : cov.reading === 'paused' ? { share: cov.blocks ?? 0, of: 'of its history read when paused' }
    : cov.reading === 'complete' ? { share: 1, of: 'read: every transfer, and every wallet the lenses need' }
    : null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-4 py-3">
      <div className="flex min-w-[14rem] flex-1 flex-wrap items-center gap-3">
        {cov.reading === 'checking' ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-ok/12 px-2 py-0.5 text-xs font-medium text-ok">
            <span aria-hidden>✓</span>Transfers read<span aria-hidden className="ml-1 text-muted-foreground">→</span>
          </span>
        ) : null}
        <span className="text-xl font-semibold text-foreground tabular-nums">{stage === null ? '…' : stage.figure ?? progress(stage.share)}</span>
        <div className="min-w-[11rem] flex-1">
          <p className="text-xs text-muted-foreground">{stage === null ? 'Finding where the collection begins' : stage.of}</p>
          <div className="mt-1 max-w-md"><Bar share={stage?.share ?? 0} paused={cov.reading === 'paused' || cov.reading === 'stored-only'} /></div>
        </div>
      </div>
      <p className="max-w-xl text-xs text-muted-foreground">{trust(c, cov)} <a href={href} className="whitespace-nowrap underline hover:text-foreground">The three steps ↓</a></p>
    </div>
  );
}

/** How far a load of stored data has got, as a bar under the pill that says it in words: the list row's view of it. */
export function RestoreProgress({ cov }: { cov: Coverage }) {
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
  if (cov.reading === 'restoring') return cov.label;
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
 * it describes is the one this collection loaded; else null.
 */
export function ReadingPanel({ c, cov, why, rpcChains, funding = true, funded, trail = null }: {
  c: CollectionRow; cov: Coverage; why: string; rpcChains: ReadonlySet<number>; funding?: boolean; funded?: boolean; trail?: { checked: number; of: number } | null;
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
        figure={cov.reading === 'restoring' ? progress(cov.restore ?? 0) : stored ? <span className="text-base">{cov.stops !== null ? 'Stored data' : 'No RPC'}</span> : cov.blocks === null ? '…' : progress(cov.blocks)}
        bar={cov.reading === 'restoring' ? cov.restore ?? 0 : stored ? 1 : cov.blocks ?? 0} paused={cov.reading === 'paused' || stored}
        value={step1(c, cov)}
        affects="all three lenses. Unread history can move any share either way."
      >
        {/* A "No RPC" left from before the stored data loaded is no fault, paused or not: the worker clears it on its next pass. */}
        {c.error && !storedOnly(c, rpcChains) ? <p className="flex items-start gap-1 text-xs text-fault"><Warn className="size-3.5" />Last read failed: {c.error}</p> : null}
        {stored ? (
          <p className="text-xs text-muted-foreground">
            {cov.unsynced !== null ? `${cov.unsynced}: no` : 'No'} RPC is set for {chainName(c.chainId)}, so no newer block is read.{' '}
            {FIELDS.some((f) => f.key === `rpc.${c.chainId}`)
              ? <a href={`/settings#rpc.${c.chainId}`} className="underline hover:text-foreground">Set one in Settings to read on from here</a>
              : <>Set WASHTRACE_RPC_{c.chainId} for the worker to read on from here.</>}
          </p>
        ) : null}
        {c.restoreNote ? <p className="text-xs text-muted-foreground">{c.restoreNote}</p> : null}
      </Step>
      <Step
        n={2} title="Wallets checked for money"
        figure={money ? progress(cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of) : 'Off'}
        bar={money ? (cov.wallets.of > 0 ? cov.wallets.checked / cov.wallets.of : 0) : undefined}
        value={money ? `${cov.wallets.checked.toLocaleString('en-US')} of ${cov.wallets.of.toLocaleString('en-US')} trading wallets, busiest first`
          : `${trailed ? 'The stored money trail checked no wallet, and no' : 'No'} funding source is set (WASHTRACE_ETHERSCAN_KEY).`}
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
        {/* Why a trail on disk did not load: information, since the lenses run as they would without it. */}
        {c.trailNote ? <p className="text-xs text-muted-foreground">{c.trailNote}</p> : null}
        {a && a.truncatedSearches > 0 ? <p className="text-xs text-muted-foreground">{plural(a.truncatedSearches, 'money search')} stopped at the visit cap before following every hop.</p> : null}
      </Step>
      <Step
        n={3} title="Analyzed"
        figure={a === null ? 'Not yet' : <span className="text-base"><Time ms={a.ranAt} /></span>}
        value={a === null ? why : <>took {a.tookMs < 10_000 ? `${a.tookMs} ms` : a.tookMs < 120_000 ? `${(a.tookMs / 1000).toFixed(0)} s` : `${(a.tookMs / 60_000).toFixed(1)} min`}{c.stale ? <span className="text-muted-foreground"> · new data waiting for the next run</span> : ' · nothing new since'}</>}
        affects="every number on this page: it turns steps 1 and 2 into them."
      >
        {a ? <p className="text-xs text-muted-foreground">Gaps in history: {(a.missingData * 100).toFixed(1)}% of changes of owner (skipped, never guessed).</p> : null}
      </Step>
    </ol>
  );
}
