import type { ReactNode } from 'react';
import Link from 'next/link';
import { TRAIL_NOTES, type CollectionRow } from '@washtrace/detect';
import { chainName } from '@/lib/chains';
import { formatBytes, lensList, plural, short } from '@/lib/format';
import { TRAIL_LOADING, downloaded, progress, restoreNext, storedOnly, type Coverage } from '@/lib/metrics';
import { Warn } from '@/components/head';
import { STATE_WORDS, TITLES, type Stage, type StageState } from '@/lib/pipeline';
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
  // Neutral like paused: nothing reports, so there is no progress to colour.
  silent: 'bg-muted text-muted-foreground',
  // Neutral like paused: a limit to lift, neither a fault nor done.
  'stored-only': 'bg-muted text-muted-foreground',
} as const;

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
 * That an analysed collection's latest analysis failed, and why: the numbers
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
  if (!cov.money) return 'Every transfer is read. Money links were not checked, so only Round trips ran.';
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
    : cov.readTo !== null ? { share: 1, figure: 'No RPC', of: `Read to block ${cov.readTo.toLocaleString('en-US')}. No newer block is read until its chain has an RPC.` }
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
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-ok/12 px-2 py-0.5 text-xs font-medium text-ok">
            <span aria-hidden>✓</span>Transfers read<span aria-hidden className="ml-1 text-muted-foreground">→</span>
          </span>
        ) : null}
        <span className="text-xl font-semibold text-foreground tabular-nums">{stage === null ? '…' : stage.figure ?? progress(stage.share)}</span>
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

/** Never green when `paused` (a stage that is not done or following, or a frozen head): a full bar would claim it is current. */
function Bar({ share, paused = false, name }: { share: number; paused?: boolean; name?: string }) {
  return (
    <span aria-hidden data-bar={name} className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <i className={cn('block h-full rounded-full', share >= 1 && !paused ? 'bg-ok' : 'bg-muted-foreground')} style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
    </span>
  );
}

/** The chip's colours: working is blue, a limit to lift (a missing key) is its own colour, and only a failure is the fault colour. */
const CHIP: Record<StageState, string> = {
  done: 'bg-ok/12 text-ok',
  running: 'bg-focus/12 text-focus',
  live: 'bg-focus/12 text-focus',
  failed: 'bg-fault/12 text-fault',
  // Not grey and not the fault colour: a missing key is a limit to lift, not a fault.
  blocked: 'bg-money/12 text-money',
  waiting: 'bg-muted text-muted-foreground',
  'not-needed': 'bg-muted text-muted-foreground',
  paused: 'bg-muted text-muted-foreground',
  silent: 'bg-muted text-muted-foreground',
};

/** A stage's state in one word, for the stage on the collection page and for any other list of stages. */
export function StageChip({ state }: { state: StageState }) {
  return <span className={cn('shrink-0 rounded-[10px] px-2 py-0.5 text-xs font-medium', CHIP[state])}>{STATE_WORDS[state]}</span>;
}

type Cell = Pick<Stage, 'n' | 'title' | 'state' | 'share'>;

/** A read that failed, as the collection's page and the worker page both say it. */
function lastReadFailed(error: string): string {
  return `Last read failed: ${error} · the worker tries again on its next pass.`;
}

/** A paused collection's error is from before the pause; on a chain with no RPC it is the old "No RPC", so the limit is said instead. */
function pausedError(error: string, rpc: boolean, chainId: number): string {
  return rpc ? `Paused · last error before the pause: ${error}` : `Paused · no RPC is set for ${chainName(chainId)}.`;
}

/** The header's short label for each stage: the full title is on hover, and on the collection's page. */
const LABELS = ['Download', 'Load', 'Analyze stored', 'Chain', 'Money', 'Re-analyze'] as const;

/**
 * Every collection's six stages on one grid, one state per cell, so what is
 * stuck on which collection reads at a glance. A row opens the collection's
 * own stages, which say what each means and what feeds what.
 * The row opens from any cell: each stage cell is its own link to the same place,
 * out of the tab order with tabIndex -1 (the name is the one a keyboard reaches;
 * the cell links stay in the accessibility tree), because an overlay on a `tr` relies on `position: relative` there, which CSS 2.1
 * leaves undefined.
 */
export function PipelineTable({ rows }: { rows: { chainId: number; address: string; name: string | null; stages: Cell[] }[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-medium">Collection</th>
            {LABELS.map((label, i) => (
              <th key={label} scope="col" title={TITLES[i]} className="px-2 py-2 font-medium whitespace-nowrap">
                <span className="tabular-nums">{i + 1}</span> {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={`${r.chainId}/${r.address}`} className="hover:bg-muted/50">
              <td className="p-0">
                <Link href={`/c/${r.chainId}/${r.address}#reading`} className="block px-4 py-2.5 font-medium text-foreground hover:underline">{r.name ?? short(r.address)}</Link>
              </td>
              {r.stages.map((x) => (
                <td key={x.n} className="p-0">
                  <Link href={`/c/${r.chainId}/${r.address}#reading`} tabIndex={-1} prefetch={false} className="block px-2 py-2.5 whitespace-nowrap">
                    <StageChip state={x.state} />
                    {x.state === 'running' && x.share !== null ? <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{x.n === 1 ? downloaded(x.share) : progress(x.share)}</span> : null}
                  </Link>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What each collection last failed at, below the table. A missing RPC is no
 * error: the worker writes "No RPC is configured" as one, but a blocked stage 4
 * says it as a limit to lift, so it is left out here. The same rules as the
 * collection's own page: none for stored data with no RPC, an error on a
 * paused collection is from before the pause, and a paused one on a chain with
 * no RPC says that instead. `rpc` is whether the row's chain has one.
 */
export function PipelineErrors({ rows }: { rows: { chainId: number; address: string; name: string | null; error: string | null; storedOnly: boolean; paused: boolean; rpc: boolean; stages: Pick<Stage, 'key' | 'state'>[] }[] }) {
  const shown = rows.filter((r) => r.error && !r.storedOnly && r.stages.find((x) => x.key === 'chain')?.state !== 'blocked');
  if (shown.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {shown.map((r) => (
        <li key={`${r.chainId}/${r.address}`} className={cn('flex items-start gap-1 text-xs', r.paused ? 'text-muted-foreground' : 'text-fault')}>
          {r.paused ? null : <Warn className="size-3.5" />}
          <span><Link href={`/c/${r.chainId}/${r.address}#reading`} className="font-medium hover:underline">{r.name ?? short(r.address)}</Link> · {r.paused ? pausedError(r.error!, r.rpc, r.chainId) : lastReadFailed(r.error!)}</span>
        </li>
      ))}
    </ul>
  );
}

/** How long an analysis took, in the unit that reads best. */
function took(ms: number): string {
  return ms < 10_000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

function Step({ stage, figure, value, bar, children }: { stage: Stage; figure: ReactNode; value: ReactNode; bar?: number; children?: ReactNode }) {
  return (
    <li className="relative flex flex-col gap-1 px-4 py-3.5">
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums">{stage.n}</span>{stage.title}
        <span className="ml-auto"><StageChip state={stage.state} /></span>
      </p>
      <p className="text-xl font-semibold text-foreground tabular-nums">{figure}</p>
      {bar !== undefined ? <Bar share={bar} paused={stage.state !== 'done' && stage.state !== 'live'} name="stage" /> : null}
      {stage.needs ? (
        <p className="text-xs font-medium text-foreground">
          {stage.needs.href ? <Link href={stage.needs.href} className="underline hover:text-foreground">{stage.needs.text}</Link> : stage.needs.text}
        </p>
      ) : null}
      <p className="text-xs tabular-nums">{value}</p>
      {children}
      <p className="mt-auto pt-1.5 text-xs text-muted-foreground"><span className="font-medium text-body">Feeds </span>{stage.feeds}</p>
    </li>
  );
}

/**
 * Stage 4's line. A paused collection's head stopped moving when it paused, so
 * nothing computed from the head is said of it but where it had read to.
 * Stored data with no RPC has no head at all: it says where the data stops.
 */
function step1(c: CollectionRow, cov: Coverage): ReactNode {
  const unread = c.cursorBlock === null || (c.startBlock !== null && c.cursorBlock < c.startBlock);
  if (cov.stops !== null) return <>{plural(c.transfers, 'transfer')} from stored data, through block {c.cursorBlock!.toLocaleString('en-US')} (<Time ms={cov.stops} style="date" />)</>;
  if (cov.readTo !== null) return `${plural(c.transfers, 'transfer')} · read to block ${cov.readTo.toLocaleString('en-US')} · no RPC for its chain`;
  if (c.pausedAt !== null) return unread ? 'Not read yet · paused' : `${plural(c.transfers, 'transfer')} · read to block ${c.cursorBlock!.toLocaleString('en-US')} when paused`;
  // A silent worker finds and follows nothing: say what was read, not that it is current.
  if (cov.reading === 'silent') return c.cursorBlock === null ? 'Not read yet · the worker is silent' : `${plural(c.transfers, 'transfer')} read, to block ${c.cursorBlock.toLocaleString()}, before the worker went silent`;
  if (c.cursorBlock === null) return 'Finding the deployment block…';
  if (cov.behind === null) return `${plural(c.transfers, 'transfer')} so far · block ${c.cursorBlock.toLocaleString()}, head not known yet`;
  if (cov.behind === 0) return `${plural(c.transfers, 'transfer')}, through the finalized head (block ${c.cursorBlock.toLocaleString()})`;
  return `${plural(c.transfers, 'transfer')} so far · block ${c.cursorBlock.toLocaleString()}, ${plural(cov.behind, 'block')} to go`;
}

const DASH = '—';

/**
 * The reading under the numbers as six stages, each in one state (pipeline())
 * and each saying which part of the answer it feeds. Stages 1 to 3 are the
 * stored data, 4 the chain, 5 the money, 6 the answer built from them; stages
 * 4 and 5 run beside each other, so the order is not a strict sequence. It
 * leads the page's evidence, because it says how far to trust everything.
 * Each note is said once, at the stage it is about, except a failed analysis,
 * which stages 3 and 6 each say for what they hold.
 *
 * `funding` is whether an Etherscan key is set. `funded` is whether the next
 * analysis has funding for the money lenses: a key, or this collection's
 * loaded trail with checked wallets (as the lens cards are told). `trail` is
 * the stored money trail's coverage, as the manifest gives it, when the trail
 * it describes is the one this collection loaded; else null. `trailBytes` and
 * `transfersBytes` are the sizes of the files the manifest lists, said while
 * they download. `trailComing` is whether the manifest's trail is not the one
 * loaded and checked wallets: once it is in, it funds the money lenses. `why`
 * is what the collection waits on while it has no analysis. `now` says whether
 * a failed analysis's wait is over.
 */
export function Pipeline({ c, stages, cov, why, rpcChains, funding = true, funded, trail = null, trailBytes = null, transfersBytes = null, trailComing = false, now = Date.now() }: {
  c: CollectionRow; stages: Stage[]; cov: Coverage; why: string; rpcChains: ReadonlySet<number>; funding?: boolean; funded?: boolean; trail?: { checked: number; of: number } | null;
  trailBytes?: number | null; transfersBytes?: number | null; trailComing?: boolean; now?: number;
}) {
  const [s1, s2, s3, s4, s5, s6] = stages as [Stage, Stage, Stage, Stage, Stage, Stage];
  const a = c.latest;
  const size = (bytes: number | null) => (bytes === null ? '' : ` of ${formatBytes(bytes)}`);

  // Stage 1 and 2: the stored files. The worker's own notes say why one failed and when it is tried again.
  const v1 = s1.state === 'not-needed' ? s1.skipped
    : s1.state === 'running' ? `${s1.file === 'trail' ? 'Money trail' : 'Transfers'} downloading from stored data · ${downloaded(s1.share!)}${size(s1.file === 'trail' ? trailBytes : transfersBytes)}`
    : s1.state === 'done' ? 'Downloaded from stored data.'
    // The transfers are in (or loading) and a trail is still to come: the file that is waited for is the trail, not the transfers.
    : s1.state === 'waiting' ? ((c.storedThroughTime !== null || c.restoreProgress !== null) && c.downloadFile !== 'transfers' ? 'Transfers downloaded; the money trail is next.' : 'Waiting to download stored data')
    : s1.state === 'paused' ? 'Paused · stored data is not downloaded until you resume it.'
    // Silent: no claim that anything is under way, only that it stopped saying.
    : s1.state === 'silent' ? 'Download stopped reporting · the worker is silent'
    : null;
  const trailed = c.trailImportedSha != null;
  const v2 = s2.state === 'not-needed' ? s2.skipped
    : s2.state === 'running' ? (s2.file === 'trail' ? `Money trail loading from stored data · ${downloaded(s2.share!)}` : `Loading stored data · ${progress(s2.share!)}`)
    : s2.state === 'done' ? 'Loaded into the database.'
    : s2.state === 'waiting' ? (s1.state === 'done' ? 'Downloaded; waiting for the load to start.' : 'Waiting for the stored data to download.')
    : s2.state === 'paused' ? 'Paused · stored data is not loaded until you resume it.'
    : s2.state === 'silent' ? 'Load stopped reporting · the worker is silent'
    : null;

  // Stage 3: with no analysis yet, `why` says what it waits on, or why it failed and when it is tried again.
  const v3 = s3.state === 'not-needed' ? s3.skipped
    : a === null ? why
    : s3.state === 'done' ? <>Analysed <Time ms={a.ranAt} />{a.throughBlock === null ? '' : ` through block ${a.throughBlock.toLocaleString('en-US')}`} · took {took(a.tookMs)}</>
    : s3.state === 'running' ? 'Analysing the stored data now.'
    : s3.state === 'paused' ? 'Paused · the stored data is not analysed until you resume it.'
    : s3.state === 'silent' ? 'Analysis stopped reporting · the worker is silent'
    : s3.state === 'waiting' ? (c.storedThroughTime === null ? 'Waiting for the stored data to load, then it is analysed.' : 'Waiting for the next analysis pass.')
    : null;

  // Stage 4: the chain. While the stored transfers are still to load, it waits on them.
  // After a failed load or download the worker reads the chain as if there were no stored data, so nothing is waited for; a failed load being retried is a load, so it is waited for.
  const loading = c.storedThroughTime === null && c.downloadNote === null && (c.restoreNote === null || c.restoreProgress !== null) && s3.state !== 'not-needed' && (s1.state === 'waiting' || s1.state === 'running' || s1.state === 'silent' || s2.state === 'waiting' || s2.state === 'running' || s2.state === 'silent');
  const v4 = loading && s4.state === 'waiting' ? 'Waiting for the stored data to load, then the chain is read from where it stops.'
    : loading && s4.state === 'blocked' && cov.stops === null && cov.readTo === null ? 'Waiting for the stored data to load.'
    // Blocked with nothing read: nothing is looking for a deployment block; the sentence under it says why.
    : s4.state === 'blocked' && c.cursorBlock === null && cov.stops === null && cov.readTo === null ? null
    : step1(c, cov);

  // Stage 5: a loaded money trail is funding once it checked a wallet: the money lenses run on it, key or not, from the next analysis on.
  const fed = funded ?? (funding || trailed);
  const money = cov.money || fed;
  // No funding for now, but not for good: the trail on its way funds the lenses once loaded, so stage 5 waits for it.
  const awaited = !money && trailComing;
  const checked = cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of;

  // Stage 6: the answer. It keeps what the last run said while the next is waited for.
  const v6 = a === null ? why
    : s6.state === 'silent' ? <>took {took(a.tookMs)} · the worker is silent, so nothing new is read</>
    : s6.state === 'running' ? <>Analysing now · the numbers shown are from the run before, which took {took(a.tookMs)}</>
    : <>took {took(a.tookMs)}{c.analysisError ? <span className="text-muted-foreground"> · still shown: the latest analysis failed</span> : c.stale ? <span className="text-muted-foreground"> · new data waiting for the next run</span> : c.pausedAt === null && c.trailProgress !== null ? ' · money trail loading; analysed again once it has' : ' · nothing new since'}</>;

  return (
    <ol className="grid divide-y rounded-lg border bg-card md:grid-cols-3 md:divide-x md:divide-y-0">
      <Step stage={s1} figure={s1.state === 'running' ? downloaded(s1.share!) : s1.state === 'done' ? '100%' : DASH} bar={s1.share ?? undefined} value={v1}>
        <DownloadNote c={c} />
      </Step>
      <Step stage={s2} figure={s2.state === 'running' ? (s2.file === 'trail' ? downloaded(s2.share!) : progress(s2.share!)) : s2.state === 'done' ? '100%' : DASH} bar={s2.share ?? undefined} value={v2}>
        {trailed ? (
          <p className="text-xs text-muted-foreground">
            Money trail loaded from stored data{trail ? ` · ${trail.checked.toLocaleString('en-US')} of ${trail.of.toLocaleString('en-US')} traders in the trail checked` : ''}
          </p>
        ) : null}
        <RestoreNote c={c} rpcChains={rpcChains} now={now} />
        {/* Why a trail on disk did not load: information, since the lenses run as they would without it. A failed import is retried, which a paused collection is not: the notes about the file stay. */}
        {c.trailNote && !(c.pausedAt !== null && c.trailNote === TRAIL_NOTES.failed) ? <p className="text-xs text-muted-foreground">{c.trailNote}</p> : null}
      </Step>
      <Step stage={s3} figure={s3.state === 'done' ? '100%' : DASH} value={v3}>
        {a && s3.state === 'failed' ? <AnalysisFailed c={c} now={now} /> : null}
      </Step>
      <Step
        stage={s4}
        figure={s4.state === 'blocked' ? <span className="text-base">{cov.stops !== null ? 'Stored data' : 'No RPC'}</span> : cov.reading === 'head-unknown' ? <span className="text-base">Head unknown</span> : cov.blocks === null ? '…' : progress(cov.blocks)}
        bar={s4.share ?? (s4.state === 'paused' ? cov.blocks ?? 0 : undefined)}
        value={v4}
      >
        {/* A "No RPC" left from before the stored data loaded is no fault, paused or not: the worker clears it on its next pass. */}
        {/* Nor one on a paused collection: the worker does not touch it, so it cannot clear it, and nothing is failing now. */}
        {/* Nor one under a Needs a key chip: a missing RPC is a limit to lift, and the sentence below says it. */}
        {c.error && s4.state !== 'blocked' && !storedOnly(c, rpcChains) ? c.pausedAt !== null
          ? <p className="text-xs text-muted-foreground">{pausedError(c.error, rpcChains.has(c.chainId), c.chainId)}</p>
          : <p className="flex items-start gap-1 text-xs text-fault"><Warn className="size-3.5" /><span>{lastReadFailed(c.error)}</span></p> : null}
        {s4.state === 'blocked' ? <p className="text-xs text-muted-foreground">{cov.unsynced !== null ? `${cov.unsynced}: no` : 'No'} RPC is set for {chainName(c.chainId)}, so no newer block is read.</p> : null}
        {s4.state === 'live' ? <p className="text-xs text-muted-foreground">Up to date · following new blocks</p> : null}
      </Step>
      <Step
        stage={s5}
        figure={awaited ? <span className="text-base">Waiting</span> : s5.state === 'blocked' && !(fed && a !== null) ? DASH : !money ? DASH : a === null ? '…' : progress(checked)}
        bar={money && a !== null ? checked : undefined}
        value={awaited ? 'Funded by the stored money trail once it has loaded. No funding source is set (WASHTRACE_ETHERSCAN_KEY) for wallets it did not check.'
          : !money ? `${trailed ? 'The stored money trail checked no wallet, and no' : 'No'} funding source is set (WASHTRACE_ETHERSCAN_KEY).`
          : a === null ? 'Counted by the first analysis. Funding read for these wallets before is kept.'
          : `${cov.wallets.checked.toLocaleString('en-US')} of ${cov.wallets.of.toLocaleString('en-US')} wallets that traded it, busiest first`}
      >
        {trailed && !funding && fed ? (
          <p className="text-xs text-muted-foreground">
            Using the stored money trail; <a href="/settings#etherscan.key" className="underline hover:text-foreground">add an Etherscan key</a> to check newer wallets.
          </p>
        ) : null}
        {a && a.truncatedSearches > 0 ? <p className="text-xs text-muted-foreground">{plural(a.truncatedSearches, 'money search', 'money searches')} stopped at the visit cap before following every hop.</p> : null}
      </Step>
      <Step stage={s6} figure={a === null ? 'Not yet' : <span className="text-base"><Time ms={a.ranAt} /></span>} value={v6}>
        {a ? <AnalysisFailed c={c} now={now} retrying={s6.state === 'running'} /> : null}
        {a ? <p className="text-xs text-muted-foreground">Gaps in history: {(a.missingData * 100).toFixed(1)}% of changes of owner (skipped, never guessed).</p> : null}
      </Step>
    </ol>
  );
}
