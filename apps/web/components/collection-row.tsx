import Link from 'next/link';
import type { CollectionRow as Collection } from '@washtrace/detect';
import { ReadingPill, RestoreProgress } from '@/components/coverage';
import { Warn } from '@/components/head';
import { RangeBar } from '@/components/methods';
import { Time } from '@/components/time';
import { CollectionControls } from '@/components/watch';
import { chainName } from '@/lib/chains';
import { LENSES, eth, ethRange, plural, short } from '@/lib/format';
import { coverage, range, rangeText, type Range } from '@/lib/metrics';

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

/** One collection in the list: its answer, how complete it is, and what can be done with it (pause, resume, delete data). */
export function CollectionRow({ c, why }: { c: Collection; why: string }) {
  const a = c.latest;
  const cov = coverage(c);
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
        {c.error ? <p className="mt-1 flex max-w-sm items-start gap-1 text-xs text-fault"><Warn className="size-3.5" />{c.error}</p> : null}
        {/* Not a fault: the worker reads the chain instead, which only takes longer. */}
        {c.restoreNote ? <p className="mt-1 max-w-sm text-xs text-muted-foreground">{c.restoreNote}</p> : null}
      </div>
      {a === null ? (
        <p className="text-sm text-muted-foreground md:col-span-2">{why}</p>
      ) : (
        <>
          <Share
            r={sales} label="of sales"
            detail={sales ? `${LENSES[sales.low].name} → ${LENSES[sales.high].name}` : 'No sale read yet'}
          />
          <Share
            r={volume} label="of volume"
            detail={volume ? `${ethRange(a.totals[volume.low].flaggedVolumeWei, a.totals[volume.high].flaggedVolumeWei)} of ${eth(a.totals.A.volumeWei)}` : 'No priced sale read yet'}
          />
        </>
      )}
      <div className="flex flex-col items-start gap-1">
        <ReadingPill cov={cov} />
        <RestoreProgress cov={cov} />
        <p className="text-xs text-muted-foreground">{a === null ? '' : <>analyzed <Time ms={a.ranAt} /></>}</p>
        {cov.reading === 'checking' ? <p className="text-xs text-muted-foreground">money lenses can still rise</p> : null}
        {/* Above the link's whole-row overlay, so a press reaches the button and not the collection page. Prioritize stays on the collection page. */}
        <div className="relative z-10 mt-1"><CollectionControls chainId={c.chainId} address={c.address} paused={c.pausedAt !== null} priority={c.priority} compact /></div>
      </div>
    </li>
  );
}
