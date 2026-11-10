import Link from 'next/link';
import { cache } from 'react';
import { moneyFor, type RingLine } from '@washtrace/detect';
import { collectionOf, type Item } from '@/lib/collection-reads';
import { eth, num, plural, ringName, short } from '@/lib/format';
import { cardSrc, walletHref, withFrom } from '@/lib/links';
import { store } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';
import { KindIcon, TierMark } from './kit';
import { HoverCard } from './hover-card';

/**
 * Rings (methods.md, Rings) as the console draws them: a table of them, a
 * picture of one ring's wallets, and the "Part of Ring N" chips a token,
 * wallet or trade page carries.
 */

/** A ring's mark: the floor's when Round trips flags any of its sales, else the ceiling's. */
export const ringTone = (r: Pick<RingLine, 'floorSales'>) => (r.floorSales > 0 ? 'cycle' : 'money');

/**
 * Rings as rows: its name and mark, a few of its wallets, then what its
 * flagged sales add up to. Each row opens the ring. Below `sm` the table is
 * too wide for the screen, so each ring is a card there instead, as a trade is
 * on Trades: both draw the same cells and the breakpoint shows one.
 */
export function RingsTable({ rows, base, chainId, total, from }: { rows: readonly RingLine[]; base: string; chainId: number; total?: number; from?: string }) {
  // Each ring's cells, made once: the table row and the card both draw these.
  const rings = rows.map((r) => {
    const href = withFrom(`${base}/r/${r.anchor}`, from);
    return {
      key: r.anchor,
      name: <HoverCard src={cardSrc(base, 'ring', r.anchor)}><Link href={href} prefetch={false} className="inline-flex items-center gap-2 font-medium text-foreground hover:underline"><TierMark tone={ringTone(r)} /><KindIcon kind="ring" />{ringName(r)}</Link></HoverCard>,
      wallets: (
        <>
          {r.sample.map((a, i) => <span key={a}>{i > 0 ? ' · ' : ''}<HoverCard src={cardSrc(base, 'wallet', a)}><Link href={walletHref(chainId, a, base)} prefetch={false} className="inline-flex items-center gap-1 font-mono hover:underline"><KindIcon kind="wallet" className="size-3.5" />{short(a)}</Link></HoverCard></span>)}
          {r.wallets > r.sample.length ? <Link href={href} prefetch={false} className="hover:underline"> +{num(r.wallets - r.sample.length)}</Link> : null}
        </>
      ),
      tokens: <Link href={href} prefetch={false} className="hover:underline">{num(r.tokens)}</Link>,
      sales: <Link href={tradesHref(base, { ring: r.anchor })} prefetch={false} className="hover:underline">{num(r.sales)}</Link>,
      eth: <Link href={tradesHref(base, { ring: r.anchor, sort: 'price', dir: 'desc' })} prefetch={false} className="hover:underline">{eth(r.volumeWei, '')}</Link>,
      // A card names its counts, having no column heads to.
      tokensWord: r.tokens === 1 ? 'token' : 'tokens',
      salesWord: r.sales === 1 ? 'sale' : 'sales',
    };
  });
  return (
    <div className="rounded-lg border bg-card">
      <ul aria-label="Rings" className="divide-y text-sm sm:hidden">
        {rings.map((r) => (
          <li key={r.key} data-ring-card className="space-y-1 px-3 py-2">
            <div>{r.name}</div>
            <div className="text-xs text-muted-foreground">{r.wallets}</div>
            <p className="flex flex-wrap gap-x-3 tabular-nums">
              <span>{r.tokens} {r.tokensWord}</span>
              <span>{r.sales} {r.salesWord}</span>
              <span>{r.eth} ETH</span>
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
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
            {rings.map((r) => (
              <tr key={r.key} className="hover:bg-muted/50">
                <td className="px-3 py-2 whitespace-nowrap">{r.name}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.wallets}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.tokens}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.sales}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.eth}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total !== undefined && total > rows.length ? <Link href={`${base}/rings`} className="block border-t px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:underline">All {plural(total, 'ring')} ›</Link> : null}
    </div>
  );
}

// Past a dozen wallets a ring of dots says no more; the count beside it keeps the number.
const DRAWN = 12;

/** One wallet as the ring's picture and its legend draw it: the wallet symbol, solid for a trader, dashed in the money hue for one that only moved the money. */
function walletMark(x: number, y: number, r: number, traded: boolean) {
  return (
    <>
      <circle cx={x} cy={y} r={r} strokeWidth={1.5} className={traded ? 'fill-card stroke-foreground' : 'fill-card stroke-flow'} {...(traded ? {} : { strokeDasharray: '3 2' })} />
      <circle cx={x} cy={y} r={r * 0.3} className={traded ? 'fill-foreground' : 'fill-flow'} />
    </>
  );
}

/**
 * A ring's wallets on a circle, each in the wallet symbol the list below uses:
 * those that traded in the text colour, those that only moved the money in
 * the money hue and dashed, each kind together on its own arc, the count in
 * the middle and a legend under it. It draws who is in it, not who paid
 * whom: the ring records membership, and the token pages draw the moves.
 */
export function RingFigure({ wallets, total }: { wallets: readonly { address: string; traded: boolean }[]; total: number }) {
  const traders = wallets.filter((w) => w.traded), movers = wallets.filter((w) => !w.traded);
  // Past a dozen, each kind keeps its share of the dots, and one at least, so a picture never drops a kind the ring has.
  const room = Math.min(wallets.length, DRAWN);
  const kept = Math.min(movers.length, Math.max(movers.length > 0 ? 1 : 0, Math.round((room * movers.length) / Math.max(wallets.length, 1))));
  const t = Math.min(traders.length, room - kept);
  const shown = [...traders.slice(0, t), ...movers.slice(0, room - t)];
  const n = Math.max(shown.length, 1);
  const r = shown.length > 8 ? 5 : 7;
  const at = (i: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [60 + 44 * Math.cos(a), 52 + 38 * Math.sin(a)] as const;
  };
  return (
    <figure className="flex shrink-0 flex-col items-center gap-1">
      <svg viewBox="0 0 120 104" role="img" aria-label={`${plural(total, 'wallet')}: ${traders.length} traded, ${movers.length} only moved the money`} className="h-28 w-32">
        <ellipse cx="60" cy="52" rx="44" ry="38" fill="none" strokeWidth={1.2} className="stroke-muted-foreground/40" />
        {shown.map((w, i) => {
          const [x, y] = at(i);
          return <g key={w.address} data-traded={w.traded ? '' : undefined}>{walletMark(x, y, r, w.traded)}</g>;
        })}
        <text x="60" y="52" textAnchor="middle" className="fill-foreground text-[20px] font-semibold tabular-nums">{num(total)}</text>
        <text x="60" y="66" textAnchor="middle" className="fill-muted-foreground text-[10px]">{total === 1 ? 'wallet' : 'wallets'}</text>
      </svg>
      {/* The picture's label says these counts already; the legend is for the eye. */}
      <figcaption aria-hidden className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {/* A kind with none drawn has no line: "0 only moved the money" says nothing the picture does not. */}
        {traders.length === 0 ? null : <span className="flex items-center gap-1.5"><svg viewBox="0 0 16 16" className="size-3.5 shrink-0">{walletMark(8, 8, 6, true)}</svg>{num(traders.length)} traded</span>}
        {movers.length === 0 ? null : <span className="flex items-center gap-1.5"><svg viewBox="0 0 16 16" className="size-3.5 shrink-0">{walletMark(8, 8, 6, false)}</svg>{num(movers.length)} only moved the money</span>}
        {total > shown.length ? <span>{num(shown.length)} of {num(total)} drawn</span> : null}
      </figcaption>
    </figure>
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
export async function RingChips({ chainId, address, of }: { chainId: number; address: string; of: Exclude<Item, { ring: string }> }) {
  const c = await collectionOf(chainId, address);
  if (!c) return null;
  const base = `/c/${chainId}/${address}`;
  const anchors = await store().ringsOf(c.id, 'token' in of ? { tokenId: of.token } : of);
  const lines = anchors.length === 0 ? [] : await linesOf(c.id, anchors.join(','), [...moneyFor(chainId)].join(','));
  if (lines.length === 0) return null;
  return (
    <>
      {lines.slice(0, CHIPS).map((r) => (
        <Link key={r.anchor} href={`${base}/r/${r.anchor}`} prefetch={false} className="chip font-medium hover:bg-muted">
          <TierMark tone={ringTone(r)} /><KindIcon kind="ring" className="size-3.5" />Part of {ringName(r)} ›
        </Link>
      ))}
      {lines.length > CHIPS ? <span className="text-xs text-muted-foreground">and {plural(lines.length - CHIPS, 'more ring')}</span> : null}
    </>
  );
}
