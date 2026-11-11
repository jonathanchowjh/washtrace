import Link from 'next/link';
import { cache } from 'react';
import { moneyFor, type RingLine } from '@washtrace/detect';
import { collectionOf, type Item } from '@/lib/collection-reads';
import { eth, num, plural, ringName, short } from '@/lib/format';
import { cardSrc, carry, walletHref, type Context } from '@/lib/links';
import { cn } from '@/lib/utils';
import { store } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';
import { ringPattern } from '@/lib/why';
import { CountGlyph, INLINE_ICON, KindIcon, TierMark, VERDICT, WalletMark, ringTone, type Counts } from './kit';
import { HoverCard } from './hover-card';
import { TokenLink } from './transfers';

/**
 * A ring, linked to its page: its tier's mark, then the ring's symbol, then
 * its name, or `children` in the name's place. It carries `ctx` when it is given.
 */
export function RingLink({ base, ring, ctx = {}, className, children }: { base: string; ring: RingLine; ctx?: Context; className?: string; children?: React.ReactNode }) {
  return (
    <Link href={carry(`${base}/r/${ring.anchor}`, ctx)} prefetch={false} className={cn('inline-flex items-center gap-1.5', className)}>
      <TierMark tone={ringTone(ring)} label /><KindIcon kind="ring" className={INLINE_ICON} />{children ?? ringName(ring)}
    </Link>
  );
}

/**
 * Rings (methods.md, Rings) as the console draws them: a table of them, one
 * ring's members, and the "Part of Ring N" chips a token, wallet or trade
 * page carries.
 */

/** A ring's counts for its glyph: loops are a ring of its wallets, pairs the sale with money under it, through a middle wallet when any is. */
const glyphOf = (r: RingLine): Counts => ({ loops: r.pattern.loops, pairs: r.pattern.pairs, wallets: r.wallets, closedByMoney: 0, middles: r.pattern.middles });

/** A glyph in a list's cell or key: smaller than a detail page's. */
const SMALL = 'h-6 w-10';

/**
 * What the list's marks mean, those its rows use: each tier's mark in the
 * lenses' order (floor, then ceiling), then the glyphs of the pattern column.
 */
function RingsKey({ rows }: { rows: readonly RingLine[] }) {
  const floor = rows.some((r) => r.floorSales > 0), ceiling = rows.some((r) => r.floorSales === 0);
  // A row draws one glyph (CountGlyph): its loop when it has one, else its pair, through a third when any of its pairs is.
  const loop = rows.some((r) => r.pattern.loops > 0);
  const pairs = rows.filter((r) => r.pattern.loops === 0 && r.pattern.pairs > 0);
  const middle = pairs.some((r) => r.pattern.middles > 0), direct = pairs.some((r) => r.pattern.middles === 0);
  const item = 'inline-flex items-center gap-1.5';
  return (
    <div role="group" aria-label="Key" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
      {floor ? <span className={item}><TierMark tone="cycle" />{VERDICT.cycle}</span> : null}
      {ceiling ? <span className={item}><TierMark tone="ceiling" />{VERDICT.ceiling}</span> : null}
      {loop ? <span className={item}><CountGlyph counts={{ loops: 1, pairs: null, wallets: 3, closedByMoney: 0, middles: null }} className={SMALL} />loop</span> : null}
      {middle ? <span className={item}><CountGlyph counts={{ loops: 0, pairs: 1, wallets: null, closedByMoney: null, middles: 1 }} className={SMALL} />linked pair, through a third</span> : null}
      {direct ? <span className={item}><CountGlyph counts={{ loops: 0, pairs: 1, wallets: null, closedByMoney: null, middles: 0 }} className={SMALL} />linked pair, direct</span> : null}
    </div>
  );
}

/**
 * Rings as rows: its name and mark, a few of its wallets, its pattern, then
 * what its flagged sales add up to, under a key to the marks. Each row opens
 * the ring. Below `sm` the table is too wide for the screen, so each ring is
 * a card there instead, as a trade is on Trades: both draw the same cells and
 * the breakpoint shows one.
 */
export function RingsTable({ rows, base, chainId, total, from, head }: { rows: readonly RingLine[]; base: string; chainId: number; total?: number; from?: string; head?: React.ReactNode }) {
  // Each ring's cells, made once: the table row and the card both draw these.
  const rings = rows.map((r) => {
    const href = carry(`${base}/r/${r.anchor}`, { from });
    return {
      key: r.anchor,
      name: <HoverCard src={cardSrc(base, 'ring', r.anchor)}><RingLink base={base} ring={r} ctx={{ from }} className="font-medium text-foreground hover:underline" /></HoverCard>,
      wallets: (
        <>
          {r.sample.map((a, i) => <span key={a}>{i > 0 ? ' · ' : ''}<HoverCard src={cardSrc(base, 'wallet', a)}><Link href={walletHref(chainId, a, base)} prefetch={false} className="inline-flex items-center gap-1.5 font-mono hover:underline"><KindIcon kind="wallet" className={INLINE_ICON} />{short(a)}</Link></HoverCard></span>)}
          {r.wallets > r.sample.length ? <Link href={href} prefetch={false} className="hover:underline"> +{num(r.wallets - r.sample.length)}</Link> : null}
        </>
      ),
      pattern: ringPattern(r.pattern, r.wallets),
      glyph: <CountGlyph counts={glyphOf(r)} className={SMALL} />,
      // Its first tokens by name, each opening its token; the rest are one link to the ring's list of them.
      tokens: r.tokens === 0 ? '0' : (
        <>
          {r.tokenSample.map((t, i) => <span key={t}>{i > 0 ? ', ' : ''}<TokenLink base={base} tokenId={t} /></span>)}
          {r.tokens > r.tokenSample.length ? <Link href={`${href}#tokens`} prefetch={false} className="hover:underline"> +{num(r.tokens - r.tokenSample.length)}</Link> : null}
        </>
      ),
      sales: <Link href={tradesHref(base, { ring: r.anchor })} prefetch={false} className="hover:underline">{num(r.sales)}</Link>,
      eth: <Link href={tradesHref(base, { ring: r.anchor, sort: 'price', dir: 'desc' })} prefetch={false} className="hover:underline">{eth(r.volumeWei, '')}</Link>,
      // A card names its counts, having no column heads to.
      tokensWord: r.tokens === 1 ? 'token' : 'tokens',
      salesWord: r.sales === 1 ? 'sale' : 'sales',
    };
  });
  return (
    <div className="rounded-lg border bg-card">
      {head}
      <RingsKey rows={rows} />
      <ul aria-label="Rings" className="divide-y text-sm sm:hidden">
        {rings.map((r) => (
          <li key={r.key} data-ring-card className="space-y-1 px-3 py-2">
            <div>{r.name}</div>
            {r.pattern === '' ? null : <div className="flex items-center gap-2 text-xs">{r.glyph}{r.pattern}</div>}
            <div className="text-xs text-muted-foreground">{r.wallets}</div>
            <p className="flex flex-wrap gap-x-3 tabular-nums">
              <span>{r.tokensWord} {r.tokens}</span>
              <span>{r.sales} {r.salesWord}</span>
              <span>{r.eth} ETH</span>
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 font-medium">Ring</th>
              <th className="px-3 py-2 font-medium">Pattern</th>
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
                <td className="px-3 py-2 text-xs">{r.pattern === '' ? null : <span className="inline-flex items-center gap-2">{r.glyph}{r.pattern}</span>}</td>
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

/** One wallet of a ring as its page lists it: its role, its sides of the ring's sales, and what they came to (`money`: what it paid or was paid, in the money hue). Null says none. */
export type RingMember = { address: string; traded: boolean; role: string; sales: string | null; eth: string | null; money: boolean };

// One grid for the head and every row, from sm: mark, wallet, role, sales, ETH.
const COLS = 'sm:grid-cols-[1rem_minmax(0,9rem)_minmax(0,1fr)_minmax(0,9rem)_minmax(0,11rem)]';

/**
 * Who is in a ring, each wallet once: its mark (solid for one that traded,
 * dashed in the money hue for one money alone joins), its address, its role,
 * its sides of the ring's counted sales and what they came to; one in between
 * says what it paid or was paid instead. Wide, a row under one head; on a
 * phone, a card of two lines, the counts under the wallet.
 */
export function RingMembers({ members, chainId, base, from }: { members: readonly RingMember[]; chainId: number; base: string; from: string }) {
  return (
    <div className="rounded-lg border bg-card text-sm">
      {/* Each cell says what it is ("2 sold", "paid 1 ETH"), so the head is for the eye. */}
      <div aria-hidden className={cn('hidden gap-x-3 border-b px-4 py-2 text-xs text-muted-foreground sm:grid', COLS)}>
        <span /><span>Wallet</span><span>Role</span><span>Sales</span><span className="text-right">ETH</span>
      </div>
      <ul aria-label="Members" className="divide-y">
        {members.map((m) => (
          <li key={m.address} data-member={m.address} className={cn('grid grid-cols-[1rem_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 px-4 py-2 sm:gap-x-3', COLS)}>
            <svg viewBox="0 0 16 16" aria-hidden className="size-4"><WalletMark x={8} y={8} r={6} traded={m.traded} /></svg>
            <HoverCard src={cardSrc(base, 'wallet', m.address)}>
              <Link href={carry(walletHref(chainId, m.address, base), { from })} prefetch={false} className="font-mono hover:underline">{short(m.address)}</Link>
            </HoverCard>
            <span className="text-muted-foreground">{m.role}</span>
            {/* On a phone a wallet with none of a column says nothing there; wide, its cell says "—". */}
            <span className={cn('col-start-2 tabular-nums sm:col-start-auto', m.sales === null && 'max-sm:hidden')}>{m.sales ?? '—'}</span>
            <span className={cn('tabular-nums sm:text-right', m.sales === null && 'col-start-2 sm:col-start-auto', m.money && 'text-flow', m.eth === null && 'max-sm:hidden')}>{m.eth ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
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
        <RingLink key={r.anchor} base={base} ring={r} className="chip font-medium hover:bg-muted">Part of {ringName(r)} ›</RingLink>
      ))}
      {lines.length > CHIPS ? <span className="text-xs text-muted-foreground">and {plural(lines.length - CHIPS, 'more ring')}</span> : null}
    </>
  );
}
