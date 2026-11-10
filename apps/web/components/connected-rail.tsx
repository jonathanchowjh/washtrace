import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Flow, Transfer } from '@washtrace/detect';
import { NO_FILTER } from '@washtrace/detect/trades';
import { collectionOf, tradeContextOf, tradesOf, type Item } from '@/lib/collection-reads';
import { short, tokenLabel } from '@/lib/format';
import { cardSrc, txHref, walletHref } from '@/lib/links';
import { range, rangeEnds } from '@/lib/metrics';
import { store } from '@/lib/store';
import { HoverCard } from './hover-card';
import { KindIcon } from './kit';

/** One wallet on the rail, with what it did here. */
type RailWallet = { address: string; role: string };
/** One transaction on the rail: a sale of a token, or a payment. */
type RailTx = { hash: string; block: number; what: string };

// A group past this many lists the first; the page's own sections hold the rest.
const SHOWN = 6;
const ZERO = '0x' + '0'.repeat(40);

/**
 * Each wallet with its role here, in the order they first appear: the seller
 * and buyer of a sale (a transfer that was no sale: sent it, got it), then
 * those that only moved money between them, a funder paying one and a payee
 * paid by one, and AC's `middles`, in between. `self`, the page's own wallet,
 * is left out.
 */
export function walletRoles(transfers: readonly Transfer[], flows: readonly Flow[], middles: readonly string[], self?: string): RailWallet[] {
  const roles = new Map<string, string[]>();
  const add = (a: string, role: string) => {
    if (a === ZERO || a === self) return;
    const r = roles.get(a) ?? [];
    if (!r.includes(role)) r.push(role);
    roles.set(a, r);
  };
  for (const t of transfers) {
    add(t.from, t.marketplace ? 'seller' : 'sent it');
    add(t.to, t.marketplace ? 'buyer' : 'got it');
  }
  const held = new Set(transfers.flatMap((t) => [t.from, t.to]));
  for (const m of middles) add(m, 'in between');
  for (const f of flows) {
    if (held.has(f.to) && !held.has(f.from)) add(f.from, 'funder');
    if (held.has(f.from) && !held.has(f.to)) add(f.to, 'payee');
  }
  return [...roles].map(([address, r]) => ({ address, role: r.join(' · ') }));
}

/**
 * A wallet's page: those it traded with, by their side of the trade, then its
 * money partners not among them: a funder paid it, a payee was paid by it.
 */
export function partnersOf(transfers: readonly Transfer[], partners: readonly { address: string; sent: number; received: number }[], self: string): RailWallet[] {
  const traded = walletRoles(transfers, [], [], self);
  const seen = new Set(traded.map((w) => w.address));
  const money = partners.filter((p) => !seen.has(p.address) && p.address !== self)
    .map((p) => ({ address: p.address, role: p.sent > 0 && p.received > 0 ? 'funder · payee' : p.received > 0 ? 'funder' : 'payee' }));
  return [...traded, ...money];
}

/** The sales and payments that tie them, by block: one line a transaction, its sales named first. */
export function railTxs(transfers: readonly Transfer[], flows: readonly Flow[]): RailTx[] {
  const out = new Map<string, RailTx>();
  for (const t of transfers) {
    if (!out.has(t.txHash)) out.set(t.txHash, { hash: t.txHash, block: t.blockNumber, what: `${t.marketplace ? 'Sale' : 'Transfer'} of #${tokenLabel(t.tokenId)}` });
  }
  for (const f of flows) if (!out.has(f.txHash)) out.set(f.txHash, { hash: f.txHash, block: f.blockNumber, what: 'Payment' });
  return [...out.values()].sort((a, b) => a.block - b.block || a.hash.localeCompare(b.hash));
}

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
export async function ConnectedRail({ chainId, address, token, wallets = [], txs = [], salesOf }: {
  chainId: number; address: string;
  /** The token a trade is of. */
  token?: string;
  wallets?: readonly RailWallet[]; txs?: readonly RailTx[];
  /** A page without its transactions to hand (a ring's): this item's first sales, read here. */
  salesOf?: Item;
}) {
  const c = await collectionOf(chainId, address);
  if (!c) return null;
  if (salesOf !== undefined && c.latest !== null) {
    const ctx = await tradeContextOf(c);
    txs = railTxs(await store().trades(c.id, { ...NO_FILTER, ...tradesOf(salesOf), sort: 'date', dir: 'asc' }, ctx, SHOWN + 1, 0), []);
  }
  const base = `/c/${chainId}/${address}`;
  const share = c.latest === null ? null : range(c.latest.totals, 'sales');
  const ends = share === null ? null : rangeEnds(share);
  const group = (title: string, items: ReactNode[], more: number) => items.length === 0 ? null : (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <ul className="flex flex-wrap gap-1.5">{items}{more > 0 ? <li className="self-center text-xs text-muted-foreground">and {more} more below</li> : null}</ul>
    </div>
  );
  return (
    <section aria-label="Connected to" className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-[auto_1fr_1fr]">
      {group('Part of', [
        <li key="c"><Link href={base} prefetch={false} className={CHIP}><KindIcon kind="collection" className="size-3.5" />{c.name ?? short(address)}{ends === null ? null : <span className="text-muted-foreground">{ends.same ? ends.high : `${ends.low}–${ends.high}`} washed</span>}</Link></li>,
        ...(token === undefined ? [] : [<li key="t"><HoverCard src={cardSrc(base, 'token', token)}><Link href={`${base}/t/${token}`} prefetch={false} className={CHIP}><KindIcon kind="token" className="size-3.5" />#{tokenLabel(token)}</Link></HoverCard></li>]),
      ], 0)}
      {group('Wallets', wallets.slice(0, SHOWN).map((w) => (
        <li key={w.address}><HoverCard src={cardSrc(base, 'wallet', w.address)}><Link href={walletHref(chainId, w.address, base)} prefetch={false} className={CHIP}><KindIcon kind="wallet" className="size-3.5" /><span className="font-mono">{short(w.address)}</span><span className="text-muted-foreground">{w.role}</span></Link></HoverCard></li>
      )), wallets.length - SHOWN)}
      {group('Transactions', txs.slice(0, SHOWN).map((t) => (
        <li key={t.hash}><Link href={txHref(chainId, t.hash, base)} prefetch={false} className={CHIP}><KindIcon kind="transaction" className="size-3.5" />{t.what}<span className="font-mono text-muted-foreground">{short(t.hash)}</span></Link></li>
      )), txs.length - SHOWN)}
    </section>
  );
}

/**
 * The parent line of a trade or wallet page outside any collection's tabs,
 * drawn as the collection pages draw theirs (CollectionNav): above the head,
 * Collections, then the one watched collection it belongs to, "/" between.
 * One in several collections has no one parent: OpenUnder lists them.
 */
export function ParentLine({ home }: { home?: Home }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-4 text-xs text-muted-foreground">
      <Link href="/" className="hover:text-foreground hover:underline">Collections</Link>
      {home === undefined ? null : (
        <>
          <span aria-hidden>/</span>
          <Link href={home.base} prefetch={false} className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"><KindIcon kind="collection" />{home.name}</Link>
        </>
      )}
    </p>
  );
}

/** A watched collection a trade or wallet belongs to: its page, its name, and the item's page under its tabs. */
export type Home = { base: string; name: string; href: string };
