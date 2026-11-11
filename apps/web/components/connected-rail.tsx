import Link from 'next/link';
import type { ReactNode } from 'react';
import { NO_FILTER } from '@washtrace/detect/trades';
import { collectionOf, tradeContextOf, tradesOf, type Item } from '@/lib/collection-reads';
import { plural, short, tokenLabel } from '@/lib/format';
import { railTxs, type RailTx, type RailWallet } from '@/lib/why';
import { cardSrc, carry, txHref, walletHref, type Context } from '@/lib/links';
import { range, rangeEnds } from '@/lib/metrics';
import { store } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';
import { HoverCard } from './hover-card';
import { KindIcon } from './kit';

// A group past this many lists the first; the page's own sections hold the rest, or Trades a ring's.
const SHOWN = 6;

const CHIP = 'chip max-w-full hover:bg-muted';

/**
 * "Connected to", on a token, wallet, trade or ring page: what it is part of,
 * up the tree (the collection and its washed share, a trade's token); the
 * wallets here, each with its role; and the transactions that tie them, by
 * block, which a page passes only when no table of its own lists them. Every
 * chip opens its page, and a wallet's or token's shows its card on hover. Its
 * rings are the header's chips, so they are not said twice. Rendered in a
 * Suspense of its own by the page: it reads the collection.
 */
export async function ConnectedRail({ chainId, address, token, ctx = {}, wallets = [], txs = [], salesOf }: {
  chainId: number; address: string;
  /** The token a trade is of. */
  token?: string;
  /** What its chips carry on: the lens the page was opened under. */
  ctx?: Context;
  wallets?: readonly RailWallet[]; txs?: readonly RailTx[];
  /** A page without its transactions to hand (a ring's): this item's first sales, read here, the rest linked on Trades. */
  salesOf?: Item;
}) {
  const c = await collectionOf(chainId, address);
  if (!c) return null;
  const base = `/c/${chainId}/${address}`;
  // The page lists none of these below, so past the first the rail says how many trades there are and opens them on Trades.
  let onTrades: ReactNode = null;
  if (salesOf !== undefined && c.latest !== null) {
    const ctx = await tradeContextOf(c);
    const q = { ...NO_FILTER, ...tradesOf(salesOf), sort: 'date', dir: 'asc' } as const;
    const [rows, { total }] = await Promise.all([store().trades(c.id, q, ctx, SHOWN, 0), store().tradeCount(c.id, q, ctx)]);
    txs = railTxs(rows, []);
    if (total > rows.length) onTrades = <li className="self-center text-xs"><Link href={tradesHref(base, tradesOf(salesOf))} prefetch={false} className="text-muted-foreground hover:text-foreground hover:underline">All {plural(total, 'trade')}, on Trades ›</Link></li>;
  }
  const share = c.latest === null ? null : range(c.latest.totals, 'sales');
  const ends = share === null ? null : rangeEnds(share);
  const below = (more: number) => more > 0 ? <li className="self-center text-xs text-muted-foreground">and {more} more below</li> : null;
  const group = (title: string, items: ReactNode[], more: ReactNode) => items.length === 0 ? null : (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <ul className="flex flex-wrap gap-1.5">{items}{more}</ul>
    </div>
  );
  return (
    <section aria-label="Connected to" className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-[auto_1fr_1fr]">
      {group('Part of', [
        <li key="c"><Link href={base} prefetch={false} className={CHIP}><KindIcon kind="collection" className="size-3.5" />{c.name ?? short(address)}{ends === null ? null : <span className="text-muted-foreground">{ends.same ? ends.high : `${ends.low}–${ends.high}`} washed</span>}</Link></li>,
        ...(token === undefined ? [] : [<li key="t"><HoverCard src={cardSrc(base, 'token', token)}><Link href={carry(`${base}/t/${token}`, ctx)} prefetch={false} className={CHIP}><KindIcon kind="token" className="size-3.5" />#{tokenLabel(token)}</Link></HoverCard></li>]),
      ], null)}
      {group('Wallets', wallets.slice(0, SHOWN).map((w) => (
        <li key={w.address}><HoverCard src={cardSrc(base, 'wallet', w.address)}><Link href={carry(walletHref(chainId, w.address, base), ctx)} prefetch={false} className={CHIP}><KindIcon kind="wallet" className="size-3.5" /><span className="font-mono">{short(w.address)}</span><span className="text-muted-foreground">{w.role}</span></Link></HoverCard></li>
      )), below(wallets.length - SHOWN))}
      {group('Transactions', txs.slice(0, SHOWN).map((t) => (
        <li key={t.hash}><Link href={carry(txHref(chainId, t.hash, base), ctx)} prefetch={false} className={CHIP}><KindIcon kind="transaction" className="size-3.5" />{t.what}<span className="font-mono text-muted-foreground">{short(t.hash)}</span></Link></li>
      )), salesOf === undefined ? below(txs.length - SHOWN) : onTrades)}
    </section>
  );
}

/**
 * The parent line of a trade or wallet page outside any collection's tabs,
 * drawn as the collection pages draw theirs (CollectionNav): above the head,
 * Collections, then the one watched collection it belongs to, "/" between.
 * One in several collections has no one parent: OpenUnder lists them. `leaf`
 * names the page itself, as the collection pages' parent line ends in it.
 */
export function ParentLine({ home, leaf }: { home?: Home; leaf: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-4 text-xs text-muted-foreground">
      <Link href="/" className="hover:text-foreground hover:underline">Collections</Link>
      {home === undefined ? null : (
        <>
          <span aria-hidden>/</span>
          <Link href={home.base} prefetch={false} className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"><KindIcon kind="collection" />{home.name}</Link>
        </>
      )}
      <span aria-hidden>/</span>
      <span className="font-mono">{leaf}</span>
    </p>
  );
}

/** A watched collection a trade or wallet belongs to: its page, its name, and the item's page under its tabs. */
export type Home = { base: string; name: string; href: string };

/**
 * The way from a trade or wallet page outside any collection's tabs into
 * them: one button for its one collection, or each collection as a link.
 */
export function OpenUnder({ homes }: { homes: readonly Home[] }) {
  if (homes.length === 0) return null;
  if (homes.length === 1) return <Link href={homes[0]!.href} prefetch={false} className="btn inline-flex items-center gap-1.5 text-sm"><KindIcon kind="collection" />Open in {homes[0]!.name} →</Link>;
  return (
    <nav aria-label="Its collections" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      <span>Open in</span>
      {homes.map((h) => <Link key={h.base} href={h.href} prefetch={false} className={CHIP}><KindIcon kind="collection" className="size-3.5" />{h.name}</Link>)}
    </nav>
  );
}
