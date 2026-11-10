import type { Witness } from '@washtrace/detect';
import { plural } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The console's small visual vocabulary: a symbol per kind of thing, a mark
 * per lens standing, and a picture per kind of evidence. Each is drawn in
 * currentColor or the verdict tokens, so it takes the colour of where it sits
 * and follows the dark theme with no colours of its own.
 */

export type Kind = 'collection' | 'ring' | 'token' | 'wallet' | 'transaction';

/** The five kinds of thing a page or link can be; the same shape on every link to it, so a reader learns it once. */
export function KindIcon({ kind, className }: { kind: Kind; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      className={cn('size-4 shrink-0', className)}>
      {kind === 'collection' ? <><rect x="2" y="4" width="10" height="10" rx="2" /><path d="M5 2h8a1 1 0 0 1 1 1v8" /></>
        : kind === 'ring' ? <><path d="M3.5 6.5A5 5 0 0 1 12.5 5" /><path d="M12.5 2.5V5H10" /><path d="M12.5 9.5A5 5 0 0 1 3.5 11" /><path d="M3.5 13.5V11H6" /></>
        : kind === 'token' ? <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" />
        : kind === 'wallet' ? <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" /></>
        : <><rect x="1.5" y="3.5" width="13" height="9" rx="2" /><path d="M5 8h6M9 6l2 2-2 2" /></>}
    </svg>
  );
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

// Each verdict by the tier of the lens behind it, in the lenses' own names.
const VERDICT = { cycle: 'Round trips · the floor', money: 'Linked wallets · the ceiling', apart: 'Money loops back · not counted', clean: 'Not flagged' } as const;

/**
 * A detail page's verdict as a chip under its title: the tier's mark and the
 * lens behind it, so the page says what it is before the reader gets to its
 * answer. Null for one not judged yet, which is never shown as clean.
 */
export function VerdictChip({ tone }: { tone: keyof typeof VERDICT | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium text-foreground">
      {tone === null ? <i aria-hidden className="inline-block size-2.5 shrink-0 rounded-[2px] border border-dashed border-muted-foreground" /> : <TierMark tone={tone} />}
      {tone === null ? 'Not judged yet' : VERDICT[tone]}
    </span>
  );
}

// Literal class names: Tailwind generates only the classes it can read in the source.
/** Each tone as a flat fill: a share's bar, a lens's pill, a legend's swatch. */
export const FILL = { cycle: 'bg-cycle', money: 'bg-money', apart: 'bg-muted-foreground', own: 'bg-flow' } as const;

/** The ceiling's hatching, the money hue on its own surface: its mark and its part of the sales strip both draw it. */
export const HATCH = 'bg-[repeating-linear-gradient(135deg,var(--money)_0_2px,var(--money-surface)_2px_4px)]';

const MARK = {
  cycle: 'rounded-[2px] bg-cycle',
  money: `rounded-[2px] ${HATCH}`,
  apart: 'rounded-full border border-dashed border-muted-foreground',
  own: 'rotate-45 rounded-[1px] bg-flow',
  clean: 'rounded-[2px] bg-muted',
} as const;

/**
 * A lens's standing as a shape as well as a hue, so it reads without colour:
 * a solid square for the floor (Round trips), a hatched one for what the
 * ceiling adds (Linked wallets), a dashed ring for a lens never counted, a
 * diamond for a lens of yours, a plain grey square for a sale no lens flags.
 */
export function TierMark({ tone, className }: { tone: keyof typeof MARK; className?: string }) {
  return <i aria-hidden className={cn('inline-block size-2.5 shrink-0', MARK[tone], className)} />;
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

/**
 * A witness in the token graph's own marks, small enough for a list row:
 * solid lines are the token changing hands, dashed ones money. A loop is its
 * wallets on a ring (two wallets, the two ways between them); a linked pair is
 * the sale with money under it, through a middle wallet when there was one.
 * It draws what the witness records and no more: a pair does not say who paid
 * whom, so neither does the picture.
 */
export function EvidenceGlyph({ witness: w, className }: { witness: Witness; className?: string }) {
  const node = 'fill-card stroke-foreground';
  let body;
  if (w.kind === 'pair') {
    body = (
      <>
        <path d="M15 10H41" strokeWidth={1.6} className="stroke-money" />
        {w.middle === null
          ? <path d="M42 15Q28 28 14 15" fill="none" strokeWidth={1.4} strokeDasharray="3 2" className="stroke-flow" />
          : <><path d="M13 14L24 24M43 14L32 24" strokeWidth={1.4} strokeDasharray="3 2" className="stroke-flow" /><circle cx="28" cy="26" r="3.5" className="fill-card stroke-flow" strokeWidth={1.4} /></>}
        <circle cx="10" cy="10" r="4.5" className={node} strokeWidth={1.5} />
        <circle cx="46" cy="10" r="4.5" className={node} strokeWidth={1.5} />
      </>
    );
  } else {
    const at = spots(Math.min(Math.max(w.wallets.length, 2), MAX_DRAWN));
    const line = w.kind === 'scc' ? 'stroke-cycle' : 'stroke-muted-foreground';
    const ring = at.length === 2
      ? <><path d="M15 13Q28 3 41 13" fill="none" strokeWidth={1.6} className={line} /><path d="M41 19Q28 29 15 19" fill="none" strokeWidth={1.6} className={line} {...(w.kind === 'scc+flow' ? { strokeDasharray: '3 2' } : {})} /></>
      : at.map(([x, y], i) => {
        const [nx, ny] = at[(i + 1) % at.length]!;
        // A loop closed by money: its last side is the payment back, dashed.
        const money = w.kind === 'scc+flow' && i === at.length - 1;
        return <path key={i} d={`M${x} ${y}L${nx} ${ny}`} strokeWidth={1.6} className={money ? 'stroke-flow' : line} {...(money ? { strokeDasharray: '3 2' } : {})} />;
      });
    body = <>{ring}{at.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={at.length > 4 ? 3.5 : 4.5} className={node} strokeWidth={1.5} />)}</>;
  }
  return (
    <svg viewBox="0 0 56 32" role="img" aria-label={evidenceLabel(w)} className={cn('h-8 w-14 shrink-0', className)}>
      {body}
    </svg>
  );
}
