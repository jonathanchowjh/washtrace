import type { ReactNode } from 'react';
import Link from 'next/link';
import { TRAIL_NOTES, type CollectionRow } from '@washtrace/detect';
import { AnalysisFailed, DownloadNote, RestoreNote } from '@/components/coverage';
import { INLINE_ICON, KindIcon } from '@/components/kit';
import { Bar, Pill, Warn, type PillTone } from '@/components/ui';
import { Time } from '@/components/zone';
import { chainName } from '@/lib/chains';
import { progress, storedOnly, type Coverage } from '@/lib/coverage';
import { ETHERSCAN_CTA, ETHERSCAN_HREF, STAGES, num, pct, plural, short, took } from '@/lib/format';
import { formatBytes } from '@washtrace/detect/bytes';
import { stageFigure, stateWord, type Stage, type StageState } from '@/lib/pipeline';
import { cn } from '@/lib/utils';

/** A stage's hue: working is blue, a limit to lift (a missing key) is neutral, and only a failure is the fault colour. */
const TONE: Record<StageState, PillTone> = {
  done: 'done',
  running: 'working',
  live: 'working',
  failed: 'fault',
  // Not grey and not the fault colour: a missing key is a limit to lift, not a fault.
  blocked: 'limit',
  waiting: 'idle',
  'not-needed': 'idle',
  paused: 'idle',
  silent: 'idle',
};

/** A stage's state in one word, for the stage on the collection page and for any other list of stages. */
function StageChip({ n, state }: { n: Stage['n']; state: StageState }) {
  return <Pill tone={TONE[state]} className="shrink-0">{stateWord(n, state)}</Pill>;
}

type Cell = Pick<Stage, 'n' | 'title' | 'state' | 'share' | 'file'>;

/** A read that failed, as the collection's page and the worker page both say it. */
function lastReadFailed(error: string): string {
  return `Last read failed: ${error} · the worker tries again on its next pass.`;
}

/** A paused collection's error is from before the pause; on a chain with no RPC it is the old "No RPC", so the limit is said instead. */
function pausedError(error: string, rpc: boolean, chainId: number): string {
  return rpc ? `Paused · last error before the pause: ${error}` : `Paused · no RPC is set for ${chainName(chainId)}.`;
}

/** A collection's reading stages: they sit on its Methods page, not the overview. */
function stagesHref(r: { chainId: number; address: string }): string {
  return `/c/${r.chainId}/${r.address}/methods#reading`;
}

/**
 * Every collection's six stages on one grid, one state per cell, so what is
 * stuck on which collection reads at a glance. A row opens the collection's
 * own stages, which say what each means and what feeds what.
 * The row opens from any cell: each stage cell is its own link to the same place,
 * out of the tab order with tabIndex -1 (the name is the one a keyboard reaches;
 * the cell links stay in the accessibility tree), because an overlay on a `tr` relies on `position: relative` there, which CSS 2.1
 * leaves undefined.
 *
 * Below `sm` six stage columns do not fit the screen, so each collection is a
 * card there instead, its six stages listed down it, as a trade is on Trades:
 * both draw the same cells and the breakpoint shows one.
 */
export function PipelineTable({ rows }: { rows: { chainId: number; address: string; name: string | null; stages: Cell[] }[] }) {
  // Each stage's cell, made once: the table and the card both draw it.
  const state = (x: Cell) => (
    <>
      <StageChip n={x.n} state={x.state} />
      {x.state === 'running' && x.share !== null ? <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{stageFigure({ ...x, share: x.share })}</span> : null}
    </>
  );
  return (
    <>
      <ul aria-label="Collections" className="divide-y rounded-lg border bg-card text-sm sm:hidden">
        {rows.map((r) => {
          const href = stagesHref(r);
          return (
            <li key={`${r.chainId}/${r.address}`} data-pipeline-card>
              <Link href={href} prefetch={false} className="block px-4 pt-2.5 pb-1 font-medium text-foreground hover:underline"><KindIcon kind="collection" className={`${INLINE_ICON} mr-1.5 inline-block align-text-bottom`} />{r.name ?? short(r.address)}</Link>
              {/* The stages open the same place, out of the tab order, as the table's cells do: the name is the one a keyboard reaches. */}
              <Link href={href} tabIndex={-1} prefetch={false} className="block px-4 pb-2.5">
                <ol className="space-y-1">
                  {r.stages.map((x, i) => (
                    <li key={x.n} title={STAGES[i]?.title} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span data-row-number className="w-3 tabular-nums">{i + 1}</span>{STAGES[i]?.label}
                      <span className="ml-auto flex items-center whitespace-nowrap">{state(x)}</span>
                    </li>
                  ))}
                </ol>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border bg-card sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">Collection</th>
              {STAGES.map(({ label, title }, i) => (
                <th key={label} scope="col" title={title} className="px-2 py-2 font-medium whitespace-nowrap">
                  <span data-row-number className="tabular-nums">{i + 1}</span> {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={`${r.chainId}/${r.address}`} className="hover:bg-muted/50">
                <td className="p-0">
                  <Link href={stagesHref(r)} prefetch={false} className="block px-4 py-2.5 font-medium text-foreground hover:underline"><KindIcon kind="collection" className={`${INLINE_ICON} mr-1.5 inline-block align-text-bottom`} />{r.name ?? short(r.address)}</Link>
                </td>
                {r.stages.map((x) => (
                  <td key={x.n} className="p-0">
                    <Link href={stagesHref(r)} tabIndex={-1} prefetch={false} className="block px-2 py-2.5 whitespace-nowrap">{state(x)}</Link>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
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
          <span><Link href={stagesHref(r)} prefetch={false} className="font-medium hover:underline"><KindIcon kind="collection" className={`${INLINE_ICON} mr-1.5 inline-block align-text-bottom`} />{r.name ?? short(r.address)}</Link> · {r.paused ? pausedError(r.error!, r.rpc, r.chainId) : lastReadFailed(r.error!)}</span>
        </li>
      ))}
    </ul>
  );
}

function Step({ stage, figure, value, bar, children }: { stage: Stage; figure: ReactNode; value: ReactNode; bar?: number; children?: ReactNode }) {
  // A stage not needed has no card: NotNeeded says it in one line above the grid.
  if (stage.state === 'not-needed') return null;
  // A narrow column may shrink the card, and its chip then wraps under the title rather than past the card's edge.
  return (
    <li data-stage={stage.n} className="relative flex min-w-0 flex-col gap-1 px-4 py-3.5">
      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
        <span data-row-number className="flex size-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums">{stage.n}</span>{stage.title}
        <span className="ml-auto"><StageChip n={stage.n} state={stage.state} /></span>
      </p>
      <p data-progress className="text-xl font-semibold text-foreground tabular-nums">{figure}</p>
      {bar !== undefined ? <Bar share={bar} paused={stage.state !== 'done' && stage.state !== 'live'} name="stage" /> : null}
      {stage.needs ? (
        <p className="text-xs font-medium text-foreground">
          {stage.needs.href ? <Link href={stage.needs.href} className="underline hover:text-foreground">{stage.needs.text}</Link> : stage.needs.text}
        </p>
      ) : null}
      <p data-progress className="text-xs tabular-nums">{value}</p>
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
  if (cov.stops !== null) return <>{plural(c.transfers, 'transfer')} from stored data, through block {num(c.cursorBlock!)} (<Time ms={cov.stops} style="date" />)</>;
  if (cov.readTo !== null) return `${plural(c.transfers, 'transfer')} · read to block ${num(cov.readTo)} · no RPC for its chain`;
  if (c.pausedAt !== null) return unread ? 'Not read yet · paused' : `${plural(c.transfers, 'transfer')} · read to block ${num(c.cursorBlock!)} when paused`;
  // A silent worker finds and follows nothing: say what was read, not that it is current.
  if (cov.reading === 'silent') return c.cursorBlock === null ? 'Not read yet · the worker is silent' : `${plural(c.transfers, 'transfer')} read, to block ${num(c.cursorBlock)}, before the worker went silent`;
  if (c.cursorBlock === null) return 'Finding the deployment block…';
  if (cov.behind === null) return `${plural(c.transfers, 'transfer')} so far · block ${num(c.cursorBlock)}, head not known yet`;
  if (cov.behind === 0) return `${plural(c.transfers, 'transfer')}, through the finalized head (block ${num(c.cursorBlock)})`;
  return `${plural(c.transfers, 'transfer')} so far · block ${num(c.cursorBlock)}, ${plural(cov.behind, 'block')} to go`;
}

const DASH = '—';

/**
 * The stages not needed, in one line: with no stored data, stages 1 to 3
 * were three cards saying "Not needed", a whole row. They are not needed for
 * one reason (pipeline() gives each the same sentence), said once.
 */
function NotNeeded({ stages }: { stages: readonly Stage[] }) {
  const skipped = stages.filter((x) => x.state === 'not-needed');
  if (skipped.length === 0) return null;
  const ns = skipped.map((x) => x.n);
  const run = ns.every((n, i) => i === 0 || n === ns[i - 1]! + 1);
  const which = ns.length === 1 ? `Stage ${ns[0]}` : run ? `Stages ${ns[0]}–${ns[ns.length - 1]}` : `Stages ${ns.join(', ')}`;
  return (
    <p data-not-needed className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-4 py-2.5 text-xs text-muted-foreground">
      <StageChip n={skipped[0]!.n} state="not-needed" />
      <span><span className="font-medium text-foreground">{which}</span> ({skipped.map((x) => STAGES[x.n - 1]!.label).join(', ')}) · {skipped[0]!.skipped}</span>
    </p>
  );
}

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
    : s1.state === 'running' ? `${s1.file === 'trail' ? 'Money trail' : 'Transfers'} downloading from stored data · ${stageFigure({ ...s1, share: s1.share! })}${size(s1.file === 'trail' ? trailBytes : transfersBytes)}`
    : s1.state === 'done' ? 'Downloaded from stored data.'
    // The transfers are in (or loading) and a trail is still to come: the file that is waited for is the trail, not the transfers.
    : s1.state === 'waiting' ? ((c.storedThroughTime !== null || c.restoreProgress !== null) && c.downloadFile !== 'transfers' ? 'Transfers downloaded; the money trail is next.' : 'Waiting to download stored data')
    : s1.state === 'paused' ? 'Paused · stored data is not downloaded until you resume it.'
    // Silent: no claim that anything is under way, only that it stopped saying.
    : s1.state === 'silent' ? 'Download stopped reporting · the worker is silent'
    : null;
  const trailed = c.trailImportedSha != null;
  const v2 = s2.state === 'not-needed' ? s2.skipped
    : s2.state === 'running' ? (s2.file === 'trail' ? `Money trail loading from stored data · ${stageFigure({ ...s2, share: s2.share! })}` : `Loading stored data · ${stageFigure({ ...s2, share: s2.share! })}`)
    : s2.state === 'done' ? 'Loaded into the database.'
    : s2.state === 'waiting' ? (s1.state === 'done' ? 'Downloaded; waiting for the load to start.' : 'Waiting for the stored data to download.')
    : s2.state === 'paused' ? 'Paused · stored data is not loaded until you resume it.'
    : s2.state === 'silent' ? 'Load stopped reporting · the worker is silent'
    : null;

  // Stage 3: with no analysis yet, `why` says what it waits on, or why it failed and when it is tried again.
  const v3 = s3.state === 'not-needed' ? s3.skipped
    : a === null ? why
    : s3.state === 'done' ? <>Analyzed <Time ms={a.ranAt} />{a.throughBlock === null ? '' : ` through block ${num(a.throughBlock)}`} · took {took(a.tookMs)}</>
    : s3.state === 'running' ? 'Analyzing the stored data now.'
    : s3.state === 'paused' ? 'Paused · the stored data is not analyzed until you resume it.'
    : s3.state === 'silent' ? 'Analysis stopped reporting · the worker is silent'
    : s3.state === 'waiting' ? (c.storedThroughTime === null ? 'Waiting for the stored data to load, then it is analyzed.' : 'Waiting for the next analysis pass.')
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
    : s6.state === 'running' ? <>Analyzing now · the numbers shown are from the run before, which took {took(a.tookMs)}</>
    : <>took {took(a.tookMs)}{c.analysisError ? <span className="text-muted-foreground"> · still shown: the latest analysis failed</span> : c.stale ? <span className="text-muted-foreground"> · new data waiting for the next run</span> : c.pausedAt === null && c.trailProgress !== null ? ' · money trail loading; analyzed again once it has' : ' · nothing new since'}</>;

  return (
    <div>
      <NotNeeded stages={stages} />
      {/* Three across from md: a rule over the second row keeps each card its own, where the divide lines alone ran 1 into 4. */}
      {/* Each row's last card has no right edge: the divide gives every card but the last one, which doubled the list's own at the end of the first row. */}
      <ol className="grid divide-y rounded-lg border bg-card md:grid-cols-3 md:divide-x md:divide-y-0 md:[&>li:nth-child(3n)]:border-r-0 md:[&>li:nth-child(n+4)]:border-t">
        <Step stage={s1} figure={s1.state === 'running' ? stageFigure({ ...s1, share: s1.share! }) : s1.state === 'done' ? '100%' : DASH} bar={s1.share ?? undefined} value={v1}>
          <DownloadNote c={c} />
        </Step>
        <Step stage={s2} figure={s2.state === 'running' ? stageFigure({ ...s2, share: s2.share! }) : s2.state === 'done' ? '100%' : DASH} bar={s2.share ?? undefined} value={v2}>
          {trailed ? (
            <p className="text-xs text-muted-foreground">
              Money trail loaded from stored data{trail ? ` · ${num(trail.checked)} of ${num(trail.of)} traders in the trail checked` : ''}
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
          {/* Nor one under a No RPC chip: a missing RPC is a limit to lift, and the sentence below says it. */}
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
            : `${num(cov.wallets.checked)} of ${num(cov.wallets.of)} wallets that traded it, busiest first. Wallets only minted to are checked too, but no trade of theirs is judged.`}
        >
          {trailed && !funding && fed ? (
            <p className="text-xs text-muted-foreground">
              Using the stored money trail, so newer wallets go unchecked. <a href={ETHERSCAN_HREF} className="underline hover:text-foreground">{ETHERSCAN_CTA}</a>
            </p>
          ) : null}
          {a && a.truncatedSearches > 0 ? <p className="text-xs text-muted-foreground">{plural(a.truncatedSearches, 'money search', 'money searches')} stopped at the visit cap before following every wallet out.</p> : null}
        </Step>
        <Step stage={s6} figure={a === null ? 'Not yet' : <span className="text-base"><Time ms={a.ranAt} /></span>} value={v6}>
          {a ? <AnalysisFailed c={c} now={now} retrying={s6.state === 'running'} /> : null}
          {a ? <p className="text-xs text-muted-foreground">Gaps in history: {pct(a.missingData, 1)} of changes of owner (skipped, never guessed).</p> : null}
        </Step>
      </ol>
    </div>
  );
}
