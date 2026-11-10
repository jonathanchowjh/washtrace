import type { ReactNode } from 'react';
import Link from 'next/link';
import type { LensKey, TradeQuery } from '@washtrace/detect/trades';
import { METHODS, type AnalysisRow, type Bucket, type Method, type MethodTotals, type TimelinePoint } from '@washtrace/detect';
import { LENSES, eth, lensInfo, pct, pctTenth, plural, num, type Lenses } from '@/lib/format';
import type { Qualifier } from '@/lib/lens-state';
import { APART, APART_WHY_TITLE, part, rangeEnds, type Range, SHOWN } from '@/lib/metrics';
import { listHref } from '@/lib/links';
import { tradesHref } from '@/lib/trades-url';
import { nextStart } from '@/lib/zone';
import { cn } from '@/lib/utils';
import { FILL, TierMark } from './kit';
import { TimeChart, type TimePoint } from './trend';

// Literal class names: Tailwind generates only the classes it can read in the source.

/** " (not counted)" after the name of a lens the verdict leaves out; the tooltip says why. */
const NotCountedTag = () => <span title={APART_WHY_TITLE}> (not counted)</span>;

/** A lens by its name, with its verdict hue; `href` makes the name open that lens's tab (leave it off inside a link). */
export function LensName({ m, className, href, own = {} }: { m: string; className?: string; href?: string; own?: Lenses }) {
  const info = lensInfo(m, own);
  if (info === null) return null;
  const name = info.name;
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <TierMark tone={info.tone} />
      {href === undefined ? <span className="font-medium text-foreground">{name}</span>
        : <Link href={href} prefetch={false} title={`Open the evidence for ${name}`} className="font-medium text-foreground hover:underline">{name}</Link>}
    </span>
  );
}

/**
 * The pattern each lens looks for, in the token graph's own marks: solid is
 * the token moving, dashed is money. A reader who learns these three learns
 * to read every token's graph.
 */
export function LensPicture({ m, className }: { m: Method; className?: string }) {
  const node = 'fill-card stroke-foreground';
  const asset = m === 'A' ? 'stroke-cycle' : 'stroke-money';
  const head = m === 'A' ? 'fill-cycle' : 'fill-money';
  return (
    <svg viewBox="0 0 72 36" className={cn('h-9 w-[72px] shrink-0', className)} aria-hidden>
      <defs>
        <marker id={`lp-${m}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" className={head} /></marker>
        <marker id={`lp-${m}-flow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" className="fill-flow" /></marker>
      </defs>
      {m === 'A' ? (
        <>
          <path d="M14 12 Q36 0 57 12" fill="none" strokeWidth={1.6} className={asset} markerEnd={`url(#lp-${m})`} />
          <path d="M58 20 Q36 32 15 20" fill="none" strokeWidth={1.6} className={asset} markerEnd={`url(#lp-${m})`} />
        </>
      ) : m === 'AU' ? (
        <>
          <path d="M15 12 L56 12" fill="none" strokeWidth={1.6} className={asset} markerEnd={`url(#lp-${m})`} />
          <path d="M60 20 L41 29" fill="none" strokeWidth={1.3} strokeDasharray="3 2.5" className="stroke-flow" markerEnd={`url(#lp-${m}-flow)`} />
          <path d="M31 30 L13 21" fill="none" strokeWidth={1.3} strokeDasharray="3 2.5" className="stroke-flow" markerEnd={`url(#lp-${m}-flow)`} />
        </>
      ) : (
        <>
          <path d="M15 12 L56 12" fill="none" strokeWidth={1.6} className={asset} markerEnd={`url(#lp-${m})`} />
          <path d="M32 29 L14 20" fill="none" strokeWidth={1.3} strokeDasharray="3 2.5" className="stroke-flow" markerEnd={`url(#lp-${m}-flow)`} />
          <path d="M40 29 L58 20" fill="none" strokeWidth={1.3} strokeDasharray="3 2.5" className="stroke-flow" markerEnd={`url(#lp-${m}-flow)`} />
        </>
      )}
      <circle cx="10" cy="16" r="4.5" className={node} strokeWidth={1.3} />
      <circle cx="62" cy="16" r="4.5" className={node} strokeWidth={1.3} />
      {m === 'A' ? null : <circle cx="36" cy="31" r="3.5" className="fill-card stroke-flow" strokeWidth={1.3} />}
    </svg>
  );
}

/**
 * A range as one bar: solid to Round trips' share, lighter on to Linked
 * wallets'. Grey track only, so an empty bar is a reading of zero.
 */
export function RangeBar({ range, className }: { range: Range; className?: string }) {
  const w = (s: number) => (s > 0 ? Math.max(1.5, s * 100) : 0);
  return (
    <span aria-hidden className={cn('relative block h-2.5 overflow-hidden rounded-full bg-muted', className)}>
      <i className={cn('absolute inset-y-0 left-0 rounded-full opacity-45', FILL[LENSES[range.high].tone])} style={{ width: `${w(range.highShare)}%` }} />
      <i className={cn('absolute inset-y-0 left-0 rounded-full', FILL[LENSES[range.low].tone])} style={{ width: `${w(range.lowShare)}%` }} />
    </span>
  );
}

/** What the two ends of a range bar are, so its two shades are never a puzzle. */
export function RangeKey({ range }: { range: Range }) {
  if (range.low === range.high) return <span className="text-xs text-muted-foreground">by {LENSES[range.low].name}</span>;
  return (
    <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><i aria-hidden className={cn('h-2 w-3 rounded-sm', FILL[LENSES[range.low].tone])} />{LENSES[range.low].name}</span>
      <span className="flex items-center gap-1.5"><i aria-hidden className={cn('h-2 w-3 rounded-sm opacity-45', FILL[LENSES[range.high].tone])} />{LENSES[range.high].name}</span>
    </span>
  );
}

/** A range's number, "x–y%": each end made by `end`, so each can open its own lens. One link when both ends agree. */
export function RangeFigure({ range, end }: { range: Range; end: (text: string, m: Method) => ReactNode }) {
  const e = rangeEnds(range);
  return e.same ? end(e.high, range.high) : <>{end(e.low, range.low)}–{end(e.high, range.high)}</>;
}

/**
 * "X–Y ETH of Z ETH", each end opening what it counts, biggest sale first.
 * `overlay` lifts the links above a row's whole-row link.
 */
export function VolumeDetail({ volume: r, totals, base, overlay = false }: { volume: Range; totals: Record<Method, MethodTotals>; base: string; overlay?: boolean }) {
  const priciest = { sort: 'price', dir: 'desc' } as const;
  const link = (q: Partial<TradeQuery>, text: string) => <Link href={tradesHref(base, { ...q, ...priciest })} prefetch={false} className={cn('hover:underline', overlay && 'relative z-10')}>{text}</Link>;
  const lo = totals[r.low].flaggedVolumeWei, hi = totals[r.high].flaggedVolumeWei;
  return <>
    {lo === hi ? link({ caught: [r.high] }, eth(hi)) : <>{link({ caught: [r.low] }, eth(lo, '').trim())}–{link({ caught: [r.high] }, eth(hi))}</>}
    {' of '}{link({}, eth(totals.A.volumeWei))}
  </>;
}

const FIGURE = 'font-medium text-foreground tabular-nums hover:underline';

/**
 * The chosen lens in numbers, at the top of its panel: every figure opens the
 * list it counts. It lives outside the tabs because each tab is one link, and
 * a link cannot hold links. `loops` is the lens's own count, null for an
 * analysis saved before loops were counted and for a lens of yours, which
 * counts none; a lens that did not run has no numbers, and its panel says why.
 * `qualifier`: shareQualifier of the lens's causes: "at least" before the
 * figure, "so far" after it.
 */
export function LensStats({ m, t, loops, base, qualifier, own = {} }: {
  m: LensKey; t: MethodTotals; loops: { loops: number; pairs: number } | null; base: string; qualifier: Qualifier | null;
  /** Your lenses by key, for the name of one of them. */
  own?: Lenses;
}) {
  if (!t.available) return null;
  const s = part(t, 'sales'), o = part(t, 'owners');
  const caught = tradesHref(base, { caught: [m] });
  const priciest = { sort: 'price', dir: 'desc' } as const;
  const flagged = (kind: 'tokens' | 'wallets') => listHref(base, kind, { method: m });
  return (
    <div aria-label={`${lensInfo(m, own)?.name} in numbers`} className="mb-4 space-y-1 text-sm text-muted-foreground tabular-nums">
      <p>
        {qualifier === 'at least' ? 'at least ' : null}<Link href={caught} prefetch={false} className={cn('text-lg', FIGURE)}>{pctTenth(s.part, s.whole)}</Link> of sales
        {(APART as readonly string[]).includes(m) ? <NotCountedTag /> : null}{qualifier === 'so far' ? ' so far' : ''}
        {' · '}<Link href={caught} prefetch={false} className={FIGURE}>{num(t.flaggedSales)}</Link> trades of <Link href={tradesHref(base, {})} prefetch={false} className={FIGURE}>{num(t.sales)}</Link>
        {' · '}<Link href={tradesHref(base, { caught: [m], ...priciest })} prefetch={false} className={FIGURE}>{eth(t.flaggedVolumeWei)}</Link> of <Link href={tradesHref(base, priciest)} prefetch={false} className={FIGURE}>{eth(t.volumeWei)}</Link>
      </p>
      <p>
        <Link href={flagged('tokens')} prefetch={false} className={FIGURE}>{plural(t.tokens, 'token')}</Link>
        {' · '}<Link href={flagged('wallets')} prefetch={false} className={FIGURE}>{plural(t.wallets, 'wallet')}</Link>
        {loops ? <>{' · '}<Link href={flagged('tokens')} prefetch={false} className={FIGURE}>{loops.pairs > 0 ? `${plural(loops.loops, 'loop')} and ${plural(loops.pairs, 'linked pair')}` : plural(loops.loops, 'loop')}</Link></> : null}
      </p>
      <p><Link href={tradesHref(base, { caught: [m], kind: 'all' })} prefetch={false} className={FIGURE}>{pct(o.part, o.whole)}</Link> of every change of owner, sold or not</p>
    </div>
  );
}

/**
 * The answer at each run of the worker, for the reading section: how it
 * settled as history and wallets filled in. An analysis of nothing has no
 * share, and is left out rather than drawn as a drop to zero.
 */
export function Trend({ history: all, zone }: { history: AnalysisRow[]; zone: string }) {
  const history = all.filter((a) => a.totals.A.transfers > 0);
  if (history.length < 2) return null;
  const points: TimePoint[] = history.map((a) => ({
    at: a.ranAt,
    lens: { A: sales(a.totals, 'A'), AU: sales(a.totals, 'AU'), AC: sales(a.totals, 'AC') },
    sales: a.totals.A.sales,
    transfers: a.totals.A.transfers,
    funded: a.fundedWallets,
    wallets: a.wallets,
    through: a.throughBlock,
  }));
  return <TimeChart kind="analyses" points={points} zone={zone} />;
}

function sales(totals: Record<Method, MethodTotals>, m: Method): { part: number; whole: number } | null {
  return totals[m].available ? part(totals[m], 'sales') : null;
}

/**
 * The collection's own history: each lens's share of the sales in each
 * period they happened in. A lens that did not run in the latest analysis
 * is drawn as not run in every period, never as 0%.
 */
export function History({ timeline, totals, notFinal, funded, funding, now, zone, base, own = [], ownLeft = [], ownNotRun = [] }: {
  timeline: { bucket: Bucket; readThrough: number | null; points: TimelinePoint[] }; totals: Record<Method, MethodTotals>; notFinal: Method[]; funded: boolean; funding: boolean; now: number; zone: string;
  /** Your lenses to draw (the page picks at most three; `timeline` was asked for each) and those it left out, which the chart names. */
  own?: { key: `L${number}`; name: string; qualifier: Qualifier | null; floorWhy?: string }[]; ownLeft?: { key: string; name: string }[]; ownNotRun?: { key: string; name: string; why: string }[];
  /** The collection's path: each period opens its trades under it. */
  base: string;
}) {
  if (timeline.points.length === 0) return null;
  const points: TimePoint[] = timeline.points.map((q) => {
    const lens = (m: Method) => (totals[m].available ? { part: q.flaggedSales[m], whole: q.sales } : null);
    const mine = Object.fromEntries(own.map((o) => [o.key, { part: q.flaggedSales[o.key] ?? 0, whole: q.judgedSales?.[o.key] ?? 0 }]));
    return { at: q.at, lens: { A: lens('A'), AU: lens('AU'), AC: lens('AC'), ...mine }, sales: q.sales, transfers: q.transfers };
  });
  // A period is the span its bar covers: from its start to the next period's start, whether or not that one has trades. Instants, so they round-trip.
  const spans = timeline.points.map((q) => ({ fromMs: q.at, toMs: nextStart(q.at, timeline.bucket, zone) }));
  const periodHrefs = spans.map((r) => tradesHref(base, r));
  // A lens's share of a period opens what that lens caught in it; a lens that did not run has no share, so no link.
  const linked = [...METHODS.filter((m) => totals[m].available), ...own.map((o) => o.key)] as LensKey[];
  const lensHrefs = spans.map((r) => Object.fromEntries(linked.map((m) => [m, tradesHref(base, { ...r, caught: [m] })])) as Partial<Record<LensKey, string>>);
  return <TimeChart kind="history" points={points} bucket={timeline.bucket} readThrough={timeline.readThrough} now={now} notFinal={notFinal} funded={funded} funding={funding} zone={zone} periodHrefs={periodHrefs} lensHrefs={lensHrefs} own={own} ownLeft={ownLeft} ownNotRun={ownNotRun} />;
}

/** The three lenses side by side: what washtrace looks for, before any number. */
export function HowWeLook({ open = false }: { open?: boolean }) {
  return (
    <details open={open} className="group rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
        <span><span className="font-medium text-foreground">How washtrace spots wash trading.</span> <span className="text-muted-foreground">Three lenses. The answer is the range from {LENSES.A.name} to {LENSES.AC.name}; {LENSES.AU.name} is shown apart.</span></span>
        <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="grid gap-4 border-t px-4 py-4 md:grid-cols-3">
        {SHOWN.map((m) => (
          <div key={m} className="flex gap-3">
            <LensPicture m={m} />
            <div>
              <LensName m={m} />
              <p className="mt-1 text-sm text-muted-foreground">{LENSES[m].says}</p>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground md:col-span-3">
          Solid arrows are the token changing hands; dashed arrows are money. A collection's answer is a range: {LENSES.A.name}' share up to {LENSES.AC.name}'.
          The two money lenses need to know who paid whom, which the worker reads wallet by wallet, so until every wallet is checked their shares are not final.
        </p>
      </div>
    </details>
  );
}
