import Link from 'next/link';
import { moneyFor, type Bucket, type TimelinePoint, type TradeRow } from '@washtrace/detect';
import { NO_FILTER, type TradeQuery } from '@washtrace/detect/trades';
import { readerZone } from '@/lib/api';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { LENSES, num, plural } from '@/lib/format';
import { txHref } from '@/lib/links';
import { lensContext } from '@/lib/metrics';
import { store } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';
import { cn } from '@/lib/utils';
import { nextStart } from '@/lib/zone';
import { HATCH, KindIcon, TierMark } from './kit';
import { Time } from './time';

/**
 * The collection's strip of every sale, in order, each coloured by the
 * strongest lens that caught it: on the overview as it is, and on a token,
 * wallet, ring or trade page with that item's own sales outlined.
 */

/** A period's sales by standing: the floor, what the ceiling adds, those only Money loops back flags, and the rest. */
export function standing(p: TimelinePoint): { floor: number; ceiling: number; apart: number; clean: number } {
  const floor = p.flaggedSales.A;
  const ceiling = Math.max(0, p.flaggedSales.AC - floor);
  const apart = p.apartSales;
  return { floor, ceiling, apart, clean: Math.max(0, p.sales - floor - ceiling - apart) };
}

/** One sale's standing, as the strip colours it: the strongest lens that caught it. */
export function saleStanding(lenses: readonly string[]): keyof ReturnType<typeof standing> {
  return lenses.includes('A') ? 'floor' : lenses.includes('AC') ? 'ceiling' : lenses.includes('AU') ? 'apart' : 'clean';
}

/** Up to this many sales, the strip is a square per sale, in order; past it, a column per period. */
export const SQUARES = 130;

const WORD = { floor: `${LENSES.A.name} (the floor)`, ceiling: `${LENSES.AC.name} (the ceiling)`, apart: `${LENSES.AU.name} alone (not counted)`, clean: 'not flagged' } as const;

const SEGMENT = {
  floor: 'bg-cycle',
  ceiling: HATCH,
  apart: 'border border-dashed border-muted-foreground bg-card',
  clean: 'bg-muted',
} as const;

/**
 * Every sale in order, a column per period: how many sold, and how many of
 * them each standing holds, floor at the foot. A column opens that period's
 * trades. One strip at any size: a collection's whole life is a row of periods.
 * When `sales` holds every sale (a small collection), it is a square per sale
 * instead, each opening its trade.
 */
/**
 * One item's sales on the strip: their keys (`txHash:logIndex`) outline its
 * squares, their times (ms) the columns they fall in. `label` names them
 * ("this token's"), and `href` lists them.
 */
export type Mine = { keys: ReadonlySet<string>; times: readonly number[]; label: string; href: string };

// Literal classes: an item's own sales, outlined on the strip.
const OUTLINE = 'ring-2 ring-foreground ring-offset-1 ring-offset-card';

export function SalesStrip({ timeline, base, zone, chainId, sales, mine }: {
  timeline: { bucket: Bucket; points: TimelinePoint[] }; base: string; zone: string; chainId: number; sales?: readonly TradeRow[] | null;
  /** On an item's page: its sales, outlined among the collection's. */
  mine?: Mine;
}) {
  const pts = timeline.points.filter((p) => p.sales > 0);
  if (pts.length === 0) return null;
  // A column holds an item's sale when the sale's time falls in its period.
  const lit = new Set(mine === undefined ? [] : pts.filter((p) => { const end = nextStart(p.at, timeline.bucket, zone); return mine.times.some((t) => t >= p.at && t < end); }).map((p) => p.at));
  const sum = { floor: 0, ceiling: 0, apart: 0, clean: 0 };
  for (const p of pts) for (const [k, v] of Object.entries(standing(p))) sum[k as keyof typeof sum] += v;
  const tallest = Math.max(...pts.map((p) => p.sales));
  const total = pts.reduce((n, p) => n + p.sales, 0);
  return (
    <section aria-label="Every sale, in order" className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground"><KindIcon kind="transaction" />{mine === undefined ? `All ${plural(total, 'sale')}, in order` : `Where ${mine.label} sales sit among all ${num(total)}`}</h2>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
          {mine === undefined ? null : <Link href={mine.href} className="flex items-center gap-1.5 font-medium text-foreground hover:underline"><i aria-hidden className={cn('inline-block size-2.5 rounded-[2px] bg-card', OUTLINE)} />{num(mine.keys.size)} {mine.label}</Link>}
          <Link href={tradesHref(base, { caught: ['A'] })} className="flex items-center gap-1.5 hover:underline"><TierMark tone="cycle" />{num(sum.floor)} {LENSES.A.name}</Link>
          <Link href={tradesHref(base, { caught: ['AC'], notCaught: ['A'] })} className="flex items-center gap-1.5 hover:underline"><TierMark tone="money" />{num(sum.ceiling)} + {LENSES.AC.name}</Link>
          <Link href={tradesHref(base, { caught: ['AU'], notCaught: ['A', 'AC'] })} className="flex items-center gap-1.5 hover:underline"><TierMark tone="apart" />{num(sum.apart)} {LENSES.AU.name} alone</Link>
          <Link href={tradesHref(base, { notCaught: ['A', 'AC', 'AU'] })} className="flex items-center gap-1.5 hover:underline"><TierMark tone="clean" />{num(sum.clean)} not flagged</Link>
        </p>
      </div>
      {sales && total <= SQUARES && sales.length === total ? (
        <ol aria-label="Each sale, oldest first" className="flex flex-wrap gap-0.5">
          {sales.map((r, i) => {
            const k = saleStanding(r.lenses);
            const own = mine?.keys.has(`${r.txHash}:${r.logIndex}`) ?? false;
            const title = `Sale ${i + 1} of ${total}: ${WORD[k]}${own ? `, ${mine!.label}` : ''}`;
            return <li key={`${r.txHash}:${r.logIndex}`}><Link href={txHref(chainId, r.txHash, base)} title={title} aria-label={title} className={cn('block size-3.5 rounded-[2px] hover:opacity-70', SEGMENT[k], own && OUTLINE)} /></li>;
          })}
        </ol>
      ) : <>
      <div className="overflow-x-auto">
        <div className="flex h-20 min-w-full items-end gap-px">
          {pts.map((p) => {
            const s = standing(p);
            const own = lit.has(p.at);
            const title = `${plural(p.sales, 'sale')}: ${s.floor} round trip, ${s.ceiling} linked by money, ${s.apart} not counted, ${s.clean} clean${own ? `; ${mine!.label} among them` : ''}`;
            return (
              <Link key={p.at} href={tradesHref(base, { fromMs: p.at, toMs: nextStart(p.at, timeline.bucket, zone) })} title={title} aria-label={title}
                className={cn('flex min-w-1 flex-1 flex-col-reverse overflow-hidden rounded-t-[2px] hover:opacity-80', own && OUTLINE)} style={{ height: `${(p.sales / tallest) * 100}%` }}>
                {(['floor', 'ceiling', 'apart', 'clean'] as const).map((k) => s[k] === 0 ? null : <i key={k} className={cn('block w-full', SEGMENT[k])} style={{ flexGrow: s[k] }} />)}
              </Link>
            );
          })}
        </div>
      </div>
      <p className="mt-1.5 flex justify-between text-xs text-muted-foreground"><Time ms={pts[0]!.at} /><span>one column per {timeline.bucket}</span><Time ms={pts[pts.length - 1]!.at} /></p>
      </>}
    </section>
  );
}

/** The most of one item's sales read to outline: a wallet past it is outlined by its first, and its count says so. */
const MINE = 2000;

/**
 * The collection's strip of every sale on a token, wallet, ring or trade page,
 * that item's sales outlined, so where it sits among the rest stays on screen.
 * `of` picks its sales as the Trades tab's filter does. Nothing before the
 * first analysis, or for an item with no sale. Rendered in a Suspense of its
 * own by the page: it reads the collection's timeline.
 */
export async function WhereItSits({ chainId, address, of, label }: {
  chainId: number; address: string; of: Partial<Pick<TradeQuery, 'wallet' | 'token' | 'ring' | 'find'>>; label: string;
}) {
  const c = await collectionOf(chainId, address);
  if (!c?.latest) return null;
  const [runs, zone] = await Promise.all([runsOf(c.id), readerZone()]);
  const ctx = { money: moneyFor(chainId), zone, ...lensContext(c.latest, runs) };
  const s = store();
  const asc = { ...NO_FILTER, sort: 'date', dir: 'asc' } as const;
  // As on the overview: a small collection's strip is a square per sale, every sale read.
  const few = c.latest.totals.A.sales <= SQUARES;
  const [timeline, sold, own] = await Promise.all([
    s.timeline(c.id, zone),
    few ? s.trades(c.id, asc, ctx, SQUARES + 1, 0) : null,
    s.trades(c.id, { ...asc, ...of }, ctx, MINE, 0),
  ]);
  if (own.length === 0) return null;
  const base = `/c/${chainId}/${address}`;
  const mine = {
    keys: new Set(own.map((r) => `${r.txHash}:${r.logIndex}`)),
    times: own.flatMap((r) => (r.blockTime === null ? [] : [r.blockTime * 1000])),
    label, href: tradesHref(base, of),
  };
  return <SalesStrip timeline={timeline} base={base} zone={zone} chainId={chainId} sales={sold} mine={mine} />;
}
