import Link from 'next/link';
import type { CollectionRow as Collection } from '@washtrace/detect';
import { AnalysisFailed, DownloadNote, ReadingPill, RestoreNote, RestoreProgress, StoredStop } from '@/components/coverage';
import { Warn } from '@/components/head';
import { RangeBar } from '@/components/methods';
import { Time } from '@/components/time';
import { CollectionControls } from '@/components/watch';
import { chainName } from '@/lib/chains';
import { LENSES, eth, ethRange, plural, short } from '@/lib/format';
import { coverage, range, rangeText, storedOnly, type Range } from '@/lib/metrics';

/** The columns of the list and of every row in it, so a row lines up under the headings. */
export const COLS = 'md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(11.5rem,0.7fr)]';

function Share({ r, label, detail }: { r: Range | null; label: string; detail: string }) {
  if (r === null) return <div className="text-sm text-muted-foreground">{detail}</div>;
  return (
    <div className="min-w-0">
      <p className="flex items-baseline gap-1.5">
        <span className="text-xl font-semibold text-foreground tabular-nums">{rangeText(r)}</span>
        <span className="text-xs text-muted-foreground md:hidden">{label}</span>
      </p>
      <RangeBar range={r} className="mt-1.5 max-w-56" />
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/**
 * One collection in the list: its answer, how complete it is, and what can be
 * done with it (pause, resume, delete data). `rpcChains` are the chains the
 * worker can read, so a collection showing stored data with none says so.
 * `funding` is whether an Etherscan key is set: without one no wallet is
 * being checked, whatever is left unchecked.
 */
export function CollectionRow({ c, why, rpcChains, funding, now }: { c: Collection; why: string; rpcChains: ReadonlySet<number>; funding: boolean; now: number }) {
  const a = c.latest;
  const cov = coverage(c, rpcChains, now, 'UTC', funding);
  const sales = a && range(a.totals, 'sales');
  const volume = a && range(a.totals, 'volume');
  const href = `/c/${c.chainId}/${c.address}`;
  return (
    <li className={`relative grid gap-x-6 gap-y-3 px-4 py-4 hover:bg-muted/40 ${COLS}`}>
      <div className="min-w-0">
        {/* The whole row opens the collection; the name is the link a screen reader announces. */}
        <Link href={href} className="font-semibold text-foreground after:absolute after:inset-0 hover:underline">{c.name ?? short(c.address)}</Link>
        <p className="text-xs text-muted-foreground">{chainName(c.chainId)} · <span className="font-mono">{short(c.address)}</span></p>
        <p className="mt-1 text-xs text-muted-foreground">{a ? `${plural(a.totals.A.sales, 'sale')} among ${plural(c.transfers, 'transfer')}` : plural(c.transfers, 'transfer')}</p>
        {/* A "No RPC" left from before stored data loaded is no fault: the pill says where the data stops. */}
        {/* Nor an error on a paused collection: the worker leaves it alone, so nothing is failing now and nothing clears it. */}
        {c.error && !storedOnly(c, rpcChains) ? c.pausedAt !== null
          ? <p className="mt-1 max-w-sm text-xs text-muted-foreground">Paused · last error before the pause: {c.error}</p>
          : <p className="mt-1 flex max-w-sm items-start gap-1 text-xs text-fault"><Warn className="size-3.5" />{c.error}</p> : null}
        {/* Not a fault: the chain is read instead where there is an RPC, and the note says when the stored data is tried again. */}
        <RestoreNote c={c} rpcChains={rpcChains} className="mt-1 max-w-sm" />
        <DownloadNote c={c} className="mt-1 max-w-sm" />
        {/* Its shares are from the analysis before. With none yet, `why` says it failed. */}
        {a ? <AnalysisFailed c={c} now={now} className="mt-1 max-w-sm" /> : null}
      </div>
      {a === null ? (
        <p className="text-sm text-muted-foreground md:col-span-2">{why}</p>
      ) : (
        <>
          <Share
            r={sales} label="of sales"
            detail={sales ? sales.low === sales.high ? LENSES[sales.low].name : `${LENSES[sales.low].name} → ${LENSES[sales.high].name}` : 'No sale read yet'}
          />
          <Share
            r={volume} label="of volume"
            detail={volume ? `${ethRange(a.totals[volume.low].flaggedVolumeWei, a.totals[volume.high].flaggedVolumeWei)} of ${eth(a.totals.A.volumeWei)}` : 'No priced sale read yet'}
          />
        </>
      )}
      {/* min-w-0: the column keeps to its grid track, so the pill wraps instead of running past the card. */}
      <div className="flex min-w-0 flex-col items-start gap-1">
        <ReadingPill cov={cov} />
        <StoredStop cov={cov} />
        <RestoreProgress cov={cov} />
        <p className="text-xs text-muted-foreground">{a === null ? '' : <>analyzed <Time ms={a.ranAt} /></>}</p>
        {cov.reading === 'checking' ? <p className="text-xs text-muted-foreground">money lenses can still rise</p> : null}
        {/* Above the link's whole-row overlay, so a press reaches the button and not the collection page. Prioritize stays on the collection page. */}
        <div className="relative z-10 mt-1"><CollectionControls chainId={c.chainId} address={c.address} paused={c.pausedAt !== null} priority={c.priority} compact /></div>
      </div>
    </li>
  );
}
