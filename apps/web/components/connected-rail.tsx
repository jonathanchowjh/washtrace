import Link from 'next/link';
import type { ReactNode } from 'react';
import { moneyFor, type Flow, type Transfer } from '@washtrace/detect';
import { NO_FILTER, type TradeQuery } from '@washtrace/detect/trades';
import { readerZone } from '@/lib/api';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { plural, short, tokenLabel } from '@/lib/format';
import { cardSrc, txHref, walletHref } from '@/lib/links';
import { lensContext, range, rangeEnds } from '@/lib/metrics';
import { store } from '@/lib/store';
import { HoverCard } from './hover-card';
import { KindIcon } from './kit';
import { ringName, ringsIn } from './rings';

/** One wallet on the rail, with what it did here. */
export type RailWallet = { address: string; role: string };
/** One transaction on the rail: a sale of a token, or a payment. */
export type RailTx = { hash: string; block: number; what: string };

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

const CHIP = 'inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs text-foreground hover:bg-muted';

/**
 * "Connected to", on a token, wallet, trade or ring page: what it is part of,
 * up the tree (the collection and its washed share, its rings, its token);
 * the wallets here, each with its role; and the transactions that tie them, by
 * block. Every chip opens its page, and a wallet's or ring's shows its card on
 * hover. Rendered in a Suspense of its own by the page: it reads the rings.
 */
export async function ConnectedRail({ chainId, address, of, token, wallets = [], txs = [], salesOf }: {
  chainId: number; address: string;
  /** What to find its rings by; none for a ring's own page. */
  of?: Parameters<typeof ringsIn>[2];
  /** The token a trade is of. */
  token?: string;
  wallets?: readonly RailWallet[]; txs?: readonly RailTx[];
  /** A page without its transactions to hand (a ring's): its first sales, by this filter, read here. */
  salesOf?: Partial<TradeQuery>;
}) {
  const c = await collectionOf(chainId, address);
  if (!c) return null;
  if (salesOf !== undefined && c.latest !== null) {
    const ctx = { money: moneyFor(chainId), zone: await readerZone(), ...lensContext(c.latest, await runsOf(c.id)) };
    txs = railTxs(await store().trades(c.id, { ...NO_FILTER, ...salesOf, sort: 'date', dir: 'asc' }, ctx, SHOWN + 1, 0), []);
  }
  const base = `/c/${chainId}/${address}`;
  const rings = of === undefined ? [] : await ringsIn(c.id, moneyFor(chainId), of);
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
        <li key="c"><Link href={base} className={CHIP}><KindIcon kind="collection" className="size-3.5" />{c.name ?? short(address)}{ends === null ? null : <span className="text-muted-foreground">{ends.same ? ends.high : `${ends.low}–${ends.high}`} washed</span>}</Link></li>,
        ...rings.slice(0, 3).map((r) => (
          <li key={r.anchor}><HoverCard src={cardSrc(base, 'ring', r.anchor)}><Link href={`${base}/r/${r.anchor}`} className={CHIP}><KindIcon kind="ring" className="size-3.5" />{ringName(r)}<span className="text-muted-foreground">{plural(r.wallets, 'wallet')}</span></Link></HoverCard></li>
        )),
        ...(token === undefined ? [] : [<li key="t"><HoverCard src={cardSrc(base, 'token', token)}><Link href={`${base}/t/${token}`} className={CHIP}><KindIcon kind="token" className="size-3.5" />#{tokenLabel(token)}</Link></HoverCard></li>]),
      ], 0)}
      {group('Wallets', wallets.slice(0, SHOWN).map((w) => (
        <li key={w.address}><HoverCard src={cardSrc(base, 'wallet', w.address)}><Link href={walletHref(chainId, w.address, base)} className={CHIP}><KindIcon kind="wallet" className="size-3.5" /><span className="font-mono">{short(w.address)}</span><span className="text-muted-foreground">{w.role}</span></Link></HoverCard></li>
      )), wallets.length - SHOWN)}
      {group('Transactions', txs.slice(0, SHOWN).map((t) => (
        <li key={t.hash}><Link href={txHref(chainId, t.hash, base)} className={CHIP}><KindIcon kind="transaction" className="size-3.5" />{t.what}<span className="font-mono text-muted-foreground">{short(t.hash)}</span></Link></li>
      )), txs.length - SHOWN)}
    </section>
  );
}
