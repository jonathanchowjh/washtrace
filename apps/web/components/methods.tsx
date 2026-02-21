import type { ReactNode } from 'react';
import Link from 'next/link';
import { METHODS, type AnalysisRow, type Bucket, type Method, type MethodTotals, type TimelinePoint } from '@washtrace/detect';
import { LENSES, eth, pct } from '@/lib/format';
import { part, type Range } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { TimeChart, type TimePoint } from './trend';

// Literal class names: Tailwind generates only the classes it can read in the source.
const DOT = { cycle: 'bg-cycle', money: 'bg-money' } as const;
const TEXT = { cycle: 'text-cycle', money: 'text-money' } as const;

/** A lens by its name, with its verdict hue. */
export function LensName({ m, className }: { m: Method; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <i aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[LENSES[m].tone])} />
      <span className="font-medium text-foreground">{LENSES[m].name}</span>
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
  const asset = LENSES[m].tone === 'cycle' ? 'stroke-cycle' : 'stroke-money';
  const head = LENSES[m].tone === 'cycle' ? 'fill-cycle' : 'fill-money';
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
 * A range as one bar: solid to the strictest lens's share, lighter on to the
 * widest's. Grey track only, so an empty bar is a reading of zero.
 */
export function RangeBar({ range, className }: { range: Range; className?: string }) {
  const w = (s: number) => (s > 0 ? Math.max(1.5, s * 100) : 0);
  return (
    <span aria-hidden className={cn('relative block h-2.5 overflow-hidden rounded-full bg-muted', className)}>
      <i className={cn('absolute inset-y-0 left-0 rounded-full opacity-45', DOT[LENSES[range.high].tone])} style={{ width: `${w(range.highShare)}%` }} />
      <i className={cn('absolute inset-y-0 left-0 rounded-full', DOT[LENSES[range.low].tone])} style={{ width: `${w(range.lowShare)}%` }} />
    </span>
  );
}

/** What the two ends of a range bar are, so its two shades are never a puzzle. */
export function RangeKey({ range }: { range: Range }) {
  if (range.low === range.high) return <span className="text-xs text-muted-foreground">by {LENSES[range.low].name}</span>;
  return (
    <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><i aria-hidden className={cn('h-2 w-3 rounded-sm', DOT[LENSES[range.low].tone])} />strictest: {LENSES[range.low].name}</span>
      <span className="flex items-center gap-1.5"><i aria-hidden className={cn('h-2 w-3 rounded-sm opacity-45', DOT[LENSES[range.high].tone])} />widest: {LENSES[range.high].name}</span>
    </span>
  );
}

const ACCENT = { cycle: 'border-t-cycle', money: 'border-t-money' } as const;
const SEAM = { A: 'md:rounded-tl-none', AU: '', AC: 'md:rounded-tr-none' } as const;

/**
 * One card per lens, and under them the panel of what the chosen lens flags.
 * The cards are tabs: the chosen one has no bottom edge and runs into the
 * panel, so what is listed is visibly that card's, with nothing between them.
 * A lens that could not run says why in grey.
 */
export function LensCards({ totals, selected, href, floor, trail = false, funded = false, children }: {
  totals: Record<Method, MethodTotals>; selected: Method; href: (m: Method) => string; floor: readonly Method[];
  /** This collection loaded a money trail from stored data. */
  trail?: boolean;
  /** The next analysis has funding to run the money lenses on: a key, or this collection's trail with checked wallets. */
  funded?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <nav aria-label="Lens" className="grid gap-3 md:grid-cols-3">
        {METHODS.map((m) => {
          const t = totals[m];
          const s = part(t, 'sales'), o = part(t, 'owners');
          const on = m === selected;
          return (
            <Link key={m} href={href(m)} scroll={false} aria-current={on ? 'page' : undefined}
              className={cn('group relative flex flex-col gap-3 rounded-lg border border-t-[3px] p-4 transition-colors',
                on ? cn('bg-card', ACCENT[LENSES[m].tone], 'md:z-10 md:-mb-px md:rounded-b-none md:border-b-0 md:pb-7')
                  : 'border-t-border bg-muted/50 hover:bg-card md:mb-3')}>
              <div className="flex items-start justify-between gap-3">
                <LensName m={m} />
                <LensPicture m={m} className={on ? undefined : 'opacity-70 group-hover:opacity-100'} />
              </div>
              <p className="text-sm text-muted-foreground">{LENSES[m].says}</p>
              {t.available ? (
                <div className="mt-auto">
                  <p className="flex items-baseline gap-1.5">
                    {floor.includes(m) ? <span className="text-xs text-muted-foreground">at least</span> : null}
                    <span className={cn('text-2xl font-semibold tabular-nums', t.flaggedSales > 0 ? TEXT[LENSES[m].tone] : 'text-foreground')}>{pct(s.part, s.whole)}</span>
                    <span className="text-sm text-muted-foreground">of sales</span>
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {t.flaggedSales.toLocaleString()} of {t.sales.toLocaleString()} sales · {eth(t.flaggedVolumeWei)} · {t.tokens.toLocaleString()} tokens · {t.wallets.toLocaleString()} wallets
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{pct(o.part, o.whole)} of every change of owner, sold or not</p>
                </div>
              ) : (
                <p className="mt-auto text-sm text-muted-foreground">
                  {funded
                    ? (trail ? 'Not run yet. The stored money trail is loaded, so it says who paid whom, and the next analysis runs this lens on it.' : 'Not run yet. A funding source is set, and the next analysis runs this lens.')
                    : <>Not run. {trail ? 'The stored money trail checked no wallet' : 'It needs to know who paid whom'}, and no funding source is set: <code className="font-mono text-xs">WASHTRACE_ETHERSCAN_KEY</code>.</>}
                </p>
              )}
              {on ? null : <span className="text-xs text-muted-foreground group-hover:text-foreground">Show what it flags</span>}
            </Link>
          );
        })}
      </nav>
      <div className={cn('mt-3 rounded-lg border bg-card p-4 md:mt-0', SEAM[selected])}>{children}</div>
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
export function History({ timeline, totals, floor, now, zone }: {
  timeline: { bucket: Bucket; readThrough: number | null; points: TimelinePoint[] }; totals: Record<Method, MethodTotals>; floor: Method[]; now: number; zone: string;
}) {
  if (timeline.points.length === 0) return null;
  const points: TimePoint[] = timeline.points.map((q) => {
    const lens = (m: Method) => (totals[m].available ? { part: q.flaggedSales[m], whole: q.sales } : null);
    return { at: q.at, lens: { A: lens('A'), AU: lens('AU'), AC: lens('AC') }, sales: q.sales, transfers: q.transfers };
  });
  return <TimeChart kind="history" points={points} bucket={timeline.bucket} readThrough={timeline.readThrough} now={now} floor={floor} zone={zone} />;
}

/** The three lenses side by side: what washtrace looks for, before any number. */
export function HowWeLook({ open = false }: { open?: boolean }) {
  return (
    <details open={open} className="group rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
        <span><span className="font-medium text-foreground">How washtrace spots wash trading.</span> <span className="text-muted-foreground">Three lenses, from strictest to widest. Every share on this console is one of them.</span></span>
        <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="grid gap-4 border-t px-4 py-4 md:grid-cols-3">
        {METHODS.map((m) => (
          <div key={m} className="flex gap-3">
            <LensPicture m={m} />
            <div>
              <LensName m={m} />
              <p className="mt-1 text-sm text-muted-foreground">{LENSES[m].says}</p>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground md:col-span-3">
          Solid arrows are the token changing hands; dashed arrows are money. A collection's answer is a range: the strictest lens's share up to the widest's.
          The two money lenses need to know who paid whom, which the worker reads wallet by wallet, so until every wallet is checked their shares are floors.
        </p>
      </div>
    </details>
  );
}

/**
 * Tokens or wallets ranked by how many of their trades a lens flags, each
 * with the share of its own trades flagged. `start` numbers a later page.
 */
export function Ranked({ title, unit, rows, tone, empty, more = null, start = 0 }: {
  title: string; unit: string; empty: string; tone: 'cycle' | 'money'; more?: { href: string; label: string } | null; start?: number;
  rows: { key: string; label: ReactNode; flagged: number; of: number }[];
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-xs text-muted-foreground">
        <span className="font-medium text-body">{title}</span>
        <span>flagged of {unit}</span>
      </div>
      {rows.length === 0 ? <p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">{empty}</p> : (
        <ol start={start + 1} className="rounded-lg border bg-card">
          {rows.map((r, i) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_6rem_5.5rem] items-center gap-3 border-b px-3 py-2 last:border-b-0">
              <span className="flex min-w-0 items-baseline gap-2"><span className="w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{start + i + 1}</span><span className="truncate">{r.label}</span></span>
              <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
                <i className={cn('block h-full rounded-full', tone === 'cycle' ? 'bg-cycle' : 'bg-money')} style={{ width: `${(r.flagged / Math.max(1, r.of)) * 100}%` }} />
              </span>
              <span className="text-right text-xs tabular-nums"><span className="font-medium text-foreground">{r.flagged}</span> of {r.of}</span>
            </li>
          ))}
        </ol>
      )}
      {more ? <Link href={more.href} className="mt-2 inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline">{more.label} →</Link> : null}
    </div>
  );
}
