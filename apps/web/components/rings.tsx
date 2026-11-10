import Link from 'next/link';
import { cache } from 'react';
import type { RingLine } from '@washtrace/detect';
import { eth, num, plural, short } from '@/lib/format';
import { cardSrc, walletHref, withFrom } from '@/lib/links';
import { store } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';
import { cn } from '@/lib/utils';
import { KindIcon, TierMark } from './kit';
import { HoverCard } from './hover-card';

/**
 * Rings (methods.md, Rings) as the console draws them: a table of them, a
 * picture of one ring's wallets, and the "Part of Ring N" chips a token,
 * wallet or trade page carries.
 */

/** A ring's mark: the floor's when Round trips flags any of its sales, else the ceiling's. */
export const ringTone = (r: Pick<RingLine, 'floorSales'>) => (r.floorSales > 0 ? 'cycle' : 'money');

/** "Ring 3": its place among the collection's, the most ETH first. A new analysis can move it; its anchor names it in a link. */
export const ringName = (r: Pick<RingLine, 'rank'>) => `Ring ${r.rank}`;

/** Rings as rows: its name and mark, a few of its wallets, then what its flagged sales add up to. Each row opens the ring. */
export function RingsTable({ rows, base, chainId, total, from }: { rows: readonly RingLine[]; base: string; chainId: number; total?: number; from?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 font-medium">Ring</th>
            <th className="px-3 py-2 font-medium">Wallets</th>
            <th className="px-3 py-2 text-right font-medium">Tokens</th>
            <th className="px-3 py-2 text-right font-medium">Sales</th>
            <th className="px-3 py-2 text-right font-medium">ETH</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => {
            const href = withFrom(`${base}/r/${r.anchor}`, from);
            return (
              <tr key={r.anchor} className="hover:bg-muted/50">
                <td className="px-3 py-2 whitespace-nowrap">
                  <HoverCard src={cardSrc(base, 'ring', r.anchor)}><Link href={href} className="inline-flex items-center gap-2 font-medium text-foreground hover:underline"><TierMark tone={ringTone(r)} /><KindIcon kind="ring" />{ringName(r)}</Link></HoverCard>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.sample.map((a, i) => <span key={a}>{i > 0 ? ' · ' : ''}<HoverCard src={cardSrc(base, 'wallet', a)}><Link href={walletHref(chainId, a, base)} className="font-mono hover:underline">{short(a)}</Link></HoverCard></span>)}
                  {r.wallets > r.sample.length ? <Link href={href} className="hover:underline"> +{num(r.wallets - r.sample.length)}</Link> : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums"><Link href={href} className="hover:underline">{num(r.tokens)}</Link></td>
                <td className="px-3 py-2 text-right tabular-nums"><Link href={tradesHref(base, { ring: r.anchor })} className="hover:underline">{num(r.sales)}</Link></td>
                <td className="px-3 py-2 text-right tabular-nums"><Link href={tradesHref(base, { ring: r.anchor, sort: 'price', dir: 'desc' })} className="hover:underline">{eth(r.volumeWei, '')}</Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {total !== undefined && total > rows.length ? <Link href={`${base}/rings`} className="block border-t px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:underline">All {plural(total, 'ring')} ›</Link> : null}
    </div>
  );
}

// Past a dozen wallets a ring of dots says no more; the count beside it keeps the number.
const DRAWN = 12;

/**
 * A ring's wallets on a circle: those that traded solid, those that only
 * moved the money in the money hue, dashed. It draws who is in it, not who
 * paid whom: the ring records membership, and the token pages draw the moves.
 */
export function RingFigure({ wallets, total }: { wallets: readonly { address: string; traded: boolean }[]; total: number }) {
  const shown = wallets.slice(0, DRAWN);
  const n = Math.max(shown.length, 1);
  const at = (i: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [60 + 44 * Math.cos(a), 52 + 38 * Math.sin(a)] as const;
  };
  return (
    <svg viewBox="0 0 120 104" role="img" aria-label={`${plural(total, 'wallet')}: ${wallets.filter((w) => w.traded).length} traded, ${wallets.filter((w) => !w.traded).length} only moved the money`} className="h-28 w-32 shrink-0">
      <ellipse cx="60" cy="52" rx="44" ry="38" fill="none" strokeWidth={1.2} className="stroke-muted-foreground/40" />
      {shown.map((w, i) => {
        const [x, y] = at(i);
        return <circle key={w.address} cx={x} cy={y} r={shown.length > 8 ? 5 : 7} strokeWidth={1.5}
          className={w.traded ? 'fill-card stroke-foreground' : 'fill-card stroke-flow'} {...(w.traded ? {} : { strokeDasharray: '3 2' })} />;
      })}
      {total > shown.length ? <text x="60" y="56" textAnchor="middle" className="fill-muted-foreground text-[11px]">+{num(total - shown.length)}</text> : null}
    </svg>
  );
}

/** Rings' lines by anchor, read once per request: a page and its chips can both ask. */
const linesOf = cache((id: number, anchors: string, money: string) => store().ringLines(id, anchors.split(','), { money: new Set(money.split(',')) }));

// A thing in more rings than this lists the first few; each opens its ring.
const CHIPS = 3;

/**
 * "Part of Ring N" for a token, wallet or trade: each ring of the latest
 * analysis it is in, by rank. Rendered in a Suspense of its own by the page,
 * since ranking reads every ring of the collection: a slow read holds no page.
 */
/** The rings of the latest analysis a token, wallet or trade is in, by rank: the chips and the Connected to rail both list them. */
export async function ringsIn(id: number, money: ReadonlySet<string>, of: Parameters<ReturnType<typeof store>['ringsOf']>[1]): Promise<RingLine[]> {
  const anchors = await store().ringsOf(id, of);
  return anchors.length === 0 ? [] : linesOf(id, anchors.join(','), [...money].join(','));
}

export async function RingChips({ id, base, money, of }: {
  id: number; base: string; money: ReadonlySet<string>; of: Parameters<ReturnType<typeof store>['ringsOf']>[1];
}) {
  const lines = await ringsIn(id, money, of);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.slice(0, CHIPS).map((r) => (
        <Link key={r.anchor} href={`${base}/r/${r.anchor}`} className={cn('inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium text-foreground hover:bg-muted')}>
          <TierMark tone={ringTone(r)} /><KindIcon kind="ring" className="size-3.5" />Part of {ringName(r)} ›
        </Link>
      ))}
      {lines.length > CHIPS ? <span className="text-xs text-muted-foreground">and {plural(lines.length - CHIPS, 'more ring')}</span> : null}
    </>
  );
}
