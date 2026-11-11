import type { Witness } from '@washtrace/detect';
import { LENSES, NOT_JUDGED_YET, num, plural } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The console's small visual vocabulary: a symbol per kind of thing, a mark
 * per lens standing, and a picture per kind of evidence. Each is drawn in
 * currentColor or the verdict tokens, so it takes the colour of where it sits
 * and follows the dark theme with no colours of its own.
 */

export type Kind = 'collection' | 'lens' | 'ring' | 'token' | 'wallet' | 'transaction';

/** The kinds of thing a page or link can be; the same shape on every link to it, so a reader learns it once. */
export function KindIcon({ kind, className }: { kind: Kind; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      className={cn('size-4 shrink-0', className)}>
      {kind === 'collection' ? <><rect x="2" y="4" width="10" height="10" rx="2" /><path d="M5 2h8a1 1 0 0 1 1 1v8" /></>
        : kind === 'lens' ? <><circle cx="5.75" cy="8" r="3.75" /><circle cx="10.25" cy="8" r="3.75" /></>
        : kind === 'ring' ? <><path d="M3.5 6.5A5 5 0 0 1 12.5 5" /><path d="M12.5 2.5V5H10" /><path d="M12.5 9.5A5 5 0 0 1 3.5 11" /><path d="M3.5 13.5V11H6" /></>
        : kind === 'token' ? <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" />
        : kind === 'wallet' ? <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" /></>
        : <><rect x="1.5" y="3.5" width="13" height="9" rx="2" /><path d="M5 8h6M9 6l2 2-2 2" /></>}
    </svg>
  );
}

/** The symbol that starts every link to a thing, in a line of text: small and muted, so the name is what reads. */
export const INLINE_ICON = 'size-3.5 text-muted-foreground';

/** A ring, named by its rank, behind its symbol: where a wallet, token or hit says which ring it is in. */
export function RingTag({ rank }: { rank: number }) {
  return <span className="inline-flex items-center gap-1"><KindIcon kind="ring" className={INLINE_ICON} />Ring {rank}</span>;
}

/** On a list's Find and filters: they narrow what the list shows, where the search box finds a thing anywhere, so the two look apart. */
export function FunnelIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      className={cn('size-4 shrink-0', className)}>
      <path d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z" />
    </svg>
  );
}

/** Finding one row, as against the funnel's narrowing of the list: a box that looks things up, not a filter. */
export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"
      className={cn('size-4 shrink-0', className)}>
      <circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25 13.5 13.5" />
    </svg>
  );
}

// Each verdict by the tier of the lens behind it, in the lenses' own names.
export const VERDICT = { cycle: `${LENSES.A.name} · ${LENSES.A.tier}`, ceiling: `${LENSES.AC.name} · ${LENSES.AC.tier}`, apart: `${LENSES.AU.name} · ${LENSES.AU.tier}`, clean: 'Not flagged' } as const;

/**
 * A detail page's verdict as a chip under its title: the tier's mark and the
 * lens behind it, so the page says what it is before the reader gets to its
 * answer. Null for one not judged yet, which is never shown as clean.
 */
export function VerdictChip({ tone }: { tone: keyof typeof VERDICT | null }) {
  return (
    <span className="chip font-medium">
      {tone === null ? <i aria-hidden className="inline-block size-2.5 shrink-0 rounded-[2px] border border-dashed border-muted-foreground" /> : <TierMark tone={tone} />}
      {tone === null ? NOT_JUDGED_YET : VERDICT[tone]}
    </span>
  );
}

// Literal class names: Tailwind generates only the classes it can read in the source.
/** The ceiling's hatching, the ceiling hue on its own surface: its mark and its part of the sales strip both draw it. */
export const HATCH = 'bg-[repeating-linear-gradient(135deg,var(--ceiling)_0_2px,var(--ceiling-surface)_2px_4px)]';

/** Each tone as a flat fill (the ceiling's is its hatching): a share's bar, a lens's pill, a legend's swatch. */
export const FILL = { cycle: 'bg-cycle', ceiling: HATCH, apart: 'bg-muted-foreground', own: 'bg-flow' } as const;

const MARK = {
  cycle: 'rounded-[2px] bg-cycle',
  ceiling: `rounded-[2px] ${HATCH}`,
  // Grey and dashed, as never counted; a 1.5 px ring round a tinted disc, so it has the weight of the marks beside it and never reads as the "–" of a sale no lens flagged.
  apart: 'rounded-full border-[1.5px] border-dashed border-muted-foreground bg-muted-foreground/30',
  own: 'rotate-45 rounded-[1px] bg-flow',
  clean: 'rounded-[2px] bg-muted-foreground/25',
} as const;

/**
 * A lens's standing as a shape as well as a hue, so it reads without colour:
 * a solid square for the floor (Round trips), a hatched one for what the
 * ceiling adds (Linked wallets), a dashed ring for a lens never counted, a
 * diamond for a lens of yours, a plain grey square for a sale no lens flags.
 * `label` says the standing to a screen reader too ("Round trips · the floor: "),
 * for a mark that leads a link or a name; a lens of yours has no standing to say.
 */
export function TierMark({ tone, className, label = false }: { tone: keyof typeof MARK; className?: string; label?: boolean }) {
  const mark = <i aria-hidden className={cn('inline-block size-2.5 shrink-0', MARK[tone], className)} />;
  return label && tone !== 'own' ? <>{mark}<span className="sr-only">{VERDICT[tone]}: </span></> : mark;
}

/** Wallets placed on a ring, first at the top, for a loop of `n`; two sit side by side. */
function spots(n: number): [number, number][] {
  if (n === 2) return [[10, 16], [46, 16]];
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [28 + 18 * Math.cos(a), 17 + 12 * Math.sin(a)] as [number, number];
  });
}

/** The words a witness's picture stands for, as its accessible name. */
export function evidenceLabel(w: Witness): string {
  if (w.kind === 'pair') return w.middle === null ? 'The seller and buyer are joined by money' : 'The seller and buyer are joined by money through one wallet';
  const many = w.cycles > 1 ? `, ${plural(w.cycles, 'cycle')}` : '';
  return w.kind === 'scc' ? `The token went round ${plural(w.wallets.length, 'wallet')}${many}` : `A loop among ${plural(w.wallets.length, 'wallet')}, closed by money${many}`;
}

// Beyond six wallets a ring of dots says no more than six do; the label keeps the count.
const MAX_DRAWN = 6;

/** What a glyph draws: a sale with money under it (through a middle wallet or not), or wallets on a ring, closed by money or not. */
type Shape = { pair: true; middle: boolean } | { pair: false; wallets: number; money: boolean };

/** The picture of a shape in the token graph's own marks: solid lines are the token changing hands, dashed ones money. */
function Glyph({ shape, label, className }: { shape: Shape; label: string; className?: string }) {
  const node = 'fill-card stroke-foreground';
  let body;
  if (shape.pair) {
    body = (
      <>
        <path d="M15 10H41" strokeWidth={1.6} className="stroke-ceiling" />
        {!shape.middle
          ? <path d="M42 15Q28 28 14 15" fill="none" strokeWidth={1.4} strokeDasharray="3 2" className="stroke-flow" />
          : <><path d="M13 14L24 24M43 14L32 24" strokeWidth={1.4} strokeDasharray="3 2" className="stroke-flow" /><circle cx="28" cy="26" r="3.5" className="fill-card stroke-flow" strokeWidth={1.4} /></>}
        <circle cx="10" cy="10" r="4.5" className={node} strokeWidth={1.5} />
        <circle cx="46" cy="10" r="4.5" className={node} strokeWidth={1.5} />
      </>
    );
  } else {
    const at = spots(Math.min(Math.max(shape.wallets, 2), MAX_DRAWN));
    const line = shape.money ? 'stroke-muted-foreground' : 'stroke-cycle';
    const ring = at.length === 2
      ? <><path d="M15 13Q28 3 41 13" fill="none" strokeWidth={1.6} className={line} /><path d="M41 19Q28 29 15 19" fill="none" strokeWidth={1.6} className={line} {...(shape.money ? { strokeDasharray: '3 2' } : {})} /></>
      : at.map(([x, y], i) => {
        const [nx, ny] = at[(i + 1) % at.length]!;
        // A loop closed by money: its last side is the payment back, dashed.
        const money = shape.money && i === at.length - 1;
        return <path key={i} d={`M${x} ${y}L${nx} ${ny}`} strokeWidth={1.6} className={money ? 'stroke-flow' : line} {...(money ? { strokeDasharray: '3 2' } : {})} />;
      });
    body = <>{ring}{at.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={at.length > 4 ? 3.5 : 4.5} className={node} strokeWidth={1.5} />)}</>;
  }
  return (
    <svg viewBox="0 0 56 32" role="img" aria-label={label} className={cn('h-8 w-14 shrink-0', className)}>
      {body}
    </svg>
  );
}

/**
 * A witness in the token graph's own marks, small enough for a list row:
 * a loop is its wallets on a ring (two wallets, the two ways between them),
 * closed by a dashed payment when money closes it; a linked pair is the sale
 * with money under it, through a middle wallet when there was one. A pair's
 * witness records who paid whom, but the glyph does not draw its shape: the
 * words beside it say that.
 */
export function EvidenceGlyph({ witness: w, className }: { witness: Witness; className?: string }) {
  const shape: Shape = w.kind === 'pair' ? { pair: true, middle: w.middle !== null } : { pair: false, wallets: w.wallets.length, money: w.kind === 'scc+flow' };
  return <Glyph shape={shape} label={evidenceLabel(w)} className={className} />;
}

/** What a list row's counts hold; null where the row has none (a lens of yours). */
export interface Counts { loops: number | null; pairs: number | null; wallets: number | null; closedByMoney: number | null; middles: number | null }

/** The words a row's counts stand for, as the glyph's accessible name; null when there is nothing to draw. */
export function countLabel(c: Counts): string | null {
  if ((c.loops ?? 0) > 0) {
    const among = (c.wallets ?? 0) > 0 ? ` among ${plural(c.wallets!, 'wallet')}` : '';
    return `${plural(c.loops!, 'loop')}${among}${(c.closedByMoney ?? 0) > 0 ? `, ${plural(c.closedByMoney!, 'loop')} closed by money` : ''}`;
  }
  if ((c.pairs ?? 0) > 0) return `${plural(c.pairs!, 'seller and buyer pair')} joined by money${(c.middles ?? 0) > 0 ? `, ${num(c.middles!)} through a middle wallet` : ''}`;
  return null;
}

/**
 * The same picture drawn from a row's counts, where a list holds no witness:
 * loops are a ring of the wallets they run among (up to six), its last side
 * dashed where money closed a loop; with no loop, the pairs are the sale with
 * money under it, through a middle wallet when any pair had one. Nothing for
 * a row with no counts, such as a lens of yours, whose rows hold none.
 */
export function CountGlyph({ counts, className }: { counts: Counts; className?: string }) {
  const label = countLabel(counts);
  if (label === null) return null;
  const shape: Shape = (counts.loops ?? 0) > 0
    ? { pair: false, wallets: counts.wallets ?? 2, money: (counts.closedByMoney ?? 0) > 0 }
    : { pair: true, middle: (counts.middles ?? 0) > 0 };
  return <Glyph shape={shape} label={label} className={className} />;
}

/** A ring's mark: the floor's when Round trips flags any of its sales, else the ceiling's. */
export const ringTone = (r: { floorSales: number }) => (r.floorSales > 0 ? 'cycle' : 'ceiling');
