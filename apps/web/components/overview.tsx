import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Bucket, CollectionProfile, LensRun, Lens, Method, MethodTotals, TimelinePoint, TokenLine, TradeRow, WalletLine } from '@washtrace/detect';
import { LENSES, NOT_RUN, eth, num, pctTenth, plural, short, tokenLabel } from '@/lib/format';
import { cardSrc, lensTabHref, listHref, txHref, venues, walletHref } from '@/lib/links';
import type { Stage, StageState } from '@/lib/pipeline';
import { tradesHref } from '@/lib/trades-url';
import { cn } from '@/lib/utils';
import { HATCH, KindIcon, TierMark } from './kit';
import { LensPicture, nextStart } from './methods';
import { Time } from './time';
import { HoverCard } from './hover-card';

/**
 * The collection overview's parts, top down: the reading in four steps, how
 * sure the range is, every sale in order, the tokens and wallets most of the
 * flagged ETH went through, what looks suspicious but is not counted, and
 * your lenses. Each is a picture first and a few words second; the numbers
 * behind them are on the Methods page.
 */

/** The six reading stages as four steps a reader thinks in: stages 1–3 are all "stored data". */
const STEPS: readonly { label: string; keys: readonly Stage['key'][] }[] = [
  { label: 'Stored data', keys: ['download', 'load', 'stored-analysis'] },
  { label: 'Chain', keys: ['chain'] },
  { label: 'Money', keys: ['money'] },
  { label: 'Analysis', keys: ['analysis'] },
];

// Worst first: a step reads as the worst of its stages, so a failure is never hidden behind a stage that is done.
const WORST: readonly StageState[] = ['failed', 'blocked', 'silent', 'running', 'waiting', 'paused', 'live', 'done', 'not-needed'];

/** One step's state and the stage that gives it: the worst of its stages, "not needed" only when every one is. */
export function stepOf(stages: readonly Stage[], keys: readonly Stage['key'][]): Stage | null {
  const mine = stages.filter((x) => keys.includes(x.key));
  return mine.sort((a, b) => WORST.indexOf(a.state) - WORST.indexOf(b.state))[0] ?? null;
}

const STEP_MARK: Record<StageState, { mark: string; word: string; tone: string }> = {
  failed: { mark: '✕', word: 'failed', tone: 'text-fault' },
  blocked: { mark: '!', word: 'needs a setting', tone: 'text-fault' },
  silent: { mark: '?', word: 'worker silent', tone: 'text-muted-foreground' },
  running: { mark: '', word: 'reading', tone: 'text-foreground' },
  waiting: { mark: '…', word: 'waiting', tone: 'text-muted-foreground' },
  paused: { mark: '❚❚', word: 'paused', tone: 'text-muted-foreground' },
  live: { mark: '✓', word: 'live', tone: 'text-clean' },
  done: { mark: '✓', word: 'done', tone: 'text-clean' },
  'not-needed': { mark: '–', word: 'not needed', tone: 'text-muted-foreground' },
};

/** The reading in four steps, each a mark and a word; a running one says how far, small. The six stages are on the Methods page. */
export function ReadingStrip({ stages, base }: { stages: readonly Stage[]; base: string }) {
  return (
    <section aria-label="How far it has read" className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-2.5 text-sm">
      {STEPS.map(({ label, keys }) => {
        const st = stepOf(stages, keys);
        if (st === null) return null;
        const m = STEP_MARK[st.state];
        return (
          <span key={label} data-step={label} className="flex items-center gap-2">
            <span aria-hidden className={cn('w-4 text-center font-semibold', m.tone)}>{st.state === 'running' ? '◔' : m.mark}</span>
            <span className="font-medium text-foreground">{label}</span>
            <span className={cn('text-xs', m.tone)}>
              {st.state === 'running' && st.share !== null ? `${Math.floor(st.share * 100)}%` : m.word}
              {st.state === 'blocked' && st.needs ? <>: {st.needs.href === null ? st.needs.text : <Link href={st.needs.href} className="underline">{st.needs.text}</Link>}</> : null}
            </span>
          </span>
        );
      })}
      <Link href={`${base}/methods#reading`} className="ml-auto text-xs text-muted-foreground hover:text-foreground hover:underline">All six stages ›</Link>
    </section>
  );
}

/** The collection before any verdict, in one line: what exists, who holds it, when and where it sold, who made it. */
export function Facts({ profile: p, creator, base, chainId }: { profile: CollectionProfile; creator: string | null; base: string; chainId: number }) {
  const sold = venues(p.marketplaces);
  const sales = sold.reduce((n, v) => n + v.sales, 0);
  const parts: ReactNode[] = [
    // No page lists every token or every holder, so these two open nothing.
    <span key="s" data-supply>{plural(p.supply, 'token')}</span>,
    <span key="h" data-supply>{plural(p.holders, 'holder')}</span>,
    p.firstMint === null ? null : <>minted <Time ms={p.firstMint} style="date" /></>,
    sales === 0 ? 'no sale yet' : <>
      <Link href={tradesHref(base, { sort: 'date', dir: 'asc' })} className="hover:underline">{plural(sales, 'sale')}</Link>
      {sold.length === 1 ? `, all on ${sold[0]!.name}` : <>: {sold.slice(0, 3).map((v, i) => <span key={v.key}>{i > 0 ? ', ' : ''}{v.name} <Link href={tradesHref(base, { venues: [v.key] })} className="hover:underline">{num(v.sales)}</Link></span>)}{sold.length > 3 ? ` and ${sold.length - 3} more` : ''}</>}
    </>,
    creator === null ? 'deployer unknown' : <>deployed by <Link href={walletHref(chainId, creator)} className="font-mono hover:underline">{short(creator)}</Link></>,
  ];
  return (
    <p aria-label="The collection" className="text-sm text-muted-foreground tabular-nums">
      {parts.filter((x) => x !== null).map((x, i) => <span key={i}>{i > 0 ? ' · ' : ''}{x}</span>)}
    </p>
  );
}

/**
 * How sure the range is, as a ladder: the floor (Round trips), what the
 * ceiling adds to it (Linked wallets), and apart from both, never added in,
 * Money loops back. Each rung is its lens's picture, its tier mark, its share
 * of sales, and the sales that make it. `apart` is how many of Money loops
 * back's sales no counted lens flags: the strip's and the panel's count, said
 * here too so the two never read as a contradiction.
 */
export function HowSure({ totals, base, apart }: { totals: Record<Method, MethodTotals>; base: string; apart?: number }) {
  const sales = totals.A.sales;
  // Linked wallets is a superset of Round trips; read as one, its rung is what it adds.
  const added = Math.max(0, totals.AC.flaggedSales - totals.A.flaggedSales);
  const rungs: { m: Method; tone: 'cycle' | 'money' | 'apart'; name: string; does: string; share: string; count: string; href: string; note?: string }[] = [
    { m: 'A', tone: 'cycle', name: LENSES.A.name, does: 'the floor', share: pctTenth(totals.A.flaggedSales, sales),
      count: plural(totals.A.flaggedSales, 'sale'), href: tradesHref(base, { caught: ['A'] }) },
    { m: 'AC', tone: 'money', name: LENSES.AC.name, does: 'the ceiling', share: `+${pctTenth(added, sales)}`,
      count: `+${plural(added, 'sale')}`, href: tradesHref(base, { caught: ['AC'], notCaught: ['A'] }) },
    { m: 'AU', tone: 'apart', name: LENSES.AU.name, does: 'not counted', share: pctTenth(totals.AU.flaggedSales, sales),
      count: plural(totals.AU.flaggedSales, 'sale'), href: tradesHref(base, { caught: ['AU'] }),
      note: `${apart === undefined ? '' : `${num(apart)} of them it alone flags · `}fails the placebo test` },
  ];
  return (
    <section aria-label="How sure" className="rounded-lg border bg-card p-4">
      <h2 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">How sure</h2>
      <ol className="space-y-2">
        {rungs.map((r) => (
          <li key={r.m} data-rung={r.m} className={cn('flex items-center gap-3', r.tone === 'apart' && 'mt-3 border-t border-dashed pt-3')}>
            <TierMark tone={r.tone} />
            <LensPicture m={r.m} className="h-7 w-14" />
            <span className="min-w-0 flex-1 text-sm"><span className="font-medium text-foreground">{r.name}</span> <span className="text-muted-foreground">· {r.does}</span></span>
            {totals[r.m].available ? (
              <>
                <Link href={r.href} className="w-16 text-right text-base font-semibold tabular-nums text-foreground hover:underline">{r.share}</Link>
                <Link href={r.href} className="w-24 text-right text-xs text-muted-foreground tabular-nums hover:underline">{r.count}</Link>
              </>
            ) : <span className="w-40 text-right text-xs text-muted-foreground" title={`${LENSES[r.m].name}: ${NOT_RUN}`}>{NOT_RUN}</span>}
            {r.note ? <span className="hidden w-36 text-xs text-muted-foreground sm:block">{r.note}</span> : <span className="hidden w-36 sm:block" />}
          </li>
        ))}
      </ol>
      <Link href={`${base}/methods`} className="mt-3 block text-xs text-muted-foreground hover:text-foreground hover:underline">Methods, numbers and your lenses ›</Link>
    </section>
  );
}

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

/**
 * The few tokens or wallets most of the flagged ETH went through, under
 * Linked wallets, each with the mark of its strongest evidence: a loop is a
 * round trip (the floor), a linked pair alone is money (the ceiling).
 */
export function TopList({ kind, rows, total, base, chainId }: {
  kind: 'tokens' | 'wallets'; rows: readonly (TokenLine | WalletLine)[]; total: number; base: string; chainId: number;
}) {
  const unit = kind === 'tokens' ? 'token' : 'wallet';
  return (
    <section aria-label={`Top ${kind}`} className="rounded-lg border bg-card">
      <h2 className="flex items-center justify-between border-b px-4 py-2.5 text-sm font-medium text-foreground">
        <span className="flex items-center gap-1.5"><KindIcon kind={unit} />Top {kind}</span>
        <span className="text-xs font-normal text-muted-foreground">by ETH flagged</span>
      </h2>
      {rows.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">None flagged.</p> : (
        <ol className="divide-y">
          {rows.map((r) => {
            const href = 'tokenId' in r ? `${base}/t/${r.tokenId}` : walletHref(chainId, r.address, base);
            return (
              <li key={'tokenId' in r ? r.tokenId : r.address}>
                <HoverCard className="block" src={'tokenId' in r ? cardSrc(base, 'token', r.tokenId) : cardSrc(base, 'wallet', r.address)}>
                <Link href={href} className="flex items-center gap-2.5 px-4 py-2 text-sm hover:bg-muted/60">
                  <TierMark tone={(r.loops ?? 0) > 0 ? 'cycle' : 'money'} />
                  <span className="flex-1 truncate font-mono text-foreground">{'tokenId' in r ? `#${tokenLabel(r.tokenId)}` : short(r.address)}</span>
                  <span className="tabular-nums text-foreground">{eth(r.volumeWei)}</span>
                  <span aria-hidden className="text-muted-foreground">›</span>
                </Link>
                </HoverCard>
              </li>
            );
          })}
        </ol>
      )}
      <Link href={listHref(base, kind, { method: 'AC', sort: 'volume' })} className="block border-t px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:underline">All {plural(total, unit)} ›</Link>
    </section>
  );
}

/**
 * Why the number is not higher: what looks like wash trading and is left
 * out. Only what the data holds is said: sales Money loops back alone flags.
 */
export function NotCounted({ apart, base }: { apart: number; base: string }) {
  if (apart === 0) return null;
  return (
    <section aria-label="Looks suspicious, not counted" className="rounded-lg border border-dashed bg-card p-4">
      <h2 className="text-sm font-medium text-foreground">Looks suspicious, not counted</h2>
      <p className="mb-3 text-xs text-muted-foreground">Why the number is not higher</p>
      <Link href={tradesHref(base, { caught: ['AU'], notCaught: ['A', 'AC'] })} className="flex items-start gap-3 rounded-md border p-3 hover:bg-muted/60">
        <TierMark tone="apart" className="mt-1" />
        <span className="text-sm">
          <span className="font-medium text-foreground">{plural(apart, 'sale')} only {LENSES.AU.name} flags: money went back to the seller</span>
          <span className="block text-muted-foreground">Not counted: only {LENSES.AU.name} sees {apart === 1 ? 'it' : 'them'}, and that method fails the placebo test.</span>
        </span>
      </Link>
    </section>
  );
}

/** Your lenses on this collection, each with its share of sales; a lens with no run yet says so. */
export function YourLenses({ runs, base, writable }: { runs: readonly { lens: Lens; run: LensRun | null }[]; base: string; writable: boolean }) {
  if (runs.length === 0 && !writable) return null;
  return (
    <section aria-label="Your lenses" className="rounded-lg border bg-card p-4">
      <h2 className="mb-2 text-sm font-medium text-foreground">Your lenses</h2>
      <ul className="flex flex-wrap gap-2">
        {runs.map(({ lens, run }) => {
          const t = run?.totals ?? null;
          return (
            <li key={lens.key}>
              <Link href={lensTabHref(base, lens.key, { evidence: true })} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted/60">
                <TierMark tone="own" />
                <span className="font-medium text-foreground">{lens.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{t === null ? 'not run yet' : `${pctTenth(t.flaggedSales, t.sales)} · ${plural(t.flaggedSales, 'sale')}`}</span>
                <span aria-hidden className="text-muted-foreground">›</span>
              </Link>
            </li>
          );
        })}
        {writable ? <li><Link href={lensTabHref(base, 'AC', { lens: 'new' })} className="block rounded-md border border-dashed px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">+ New lens</Link></li> : null}
      </ul>
    </section>
  );
}
