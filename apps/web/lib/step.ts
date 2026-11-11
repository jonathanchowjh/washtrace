import { METHODS, type CollectionRow, type TokenSort, type WalletSort } from '@washtrace/detect';
import { isOwnKey } from '@washtrace/detect/trades';
import { lensKeyOf } from './api';
import { runsOf, tradeContextOf } from './collection-reads';
import { eth, localTime, ringName, short, tokenLabel } from './format';
import { carry, txHref, walletHref, type Context } from './links';
import { ownLenses } from './metrics';
import { addressOf, listView, pageOf, pages } from './params';
import { store } from './store';
import { TRADES_PAGE, holdsNothing, parseView } from './trades-url';
import { LIST_PAGE, RINGS_PAGE } from './views';

/**
 * Stepping through a list from one of its items: ‹ and › (and J and K) open
 * the item before and after it, past the edge of its page too. An item opened
 * from a list carries `from`, the list's own path and query under the
 * collection (`tokens?method=A&page=2`), so the step reads that same page.
 * The item is found on it by what it is, not by its place, because a new
 * analysis can reorder a list: one no longer on its page steps nowhere, and
 * its page offers the way back to the list.
 *
 * A ring's wallets or tokens are a list too, `ring?anchor=…&of=wallets`:
 * its page lists every one, so it is one page, and its way back is the ring.
 */

type ListKind = 'tokens' | 'wallets' | 'rings' | 'trades' | 'ring';
const KINDS: readonly ListKind[] = ['tokens', 'wallets', 'rings', 'trades', 'ring'];

/** A `from`: the list's kind and its query; null for anything else. */
export function fromOf(raw: string | string[] | undefined): { kind: ListKind; params: URLSearchParams } | null {
  if (typeof raw !== 'string') return null;
  const [path, query = ''] = raw.split('?', 2);
  const kind = KINDS.find((k) => k === path);
  return kind === undefined ? null : { kind, params: new URLSearchParams(query) };
}

/** The lens and the list a page was opened with, as its links carry them on: a `method` that is a lens and a `from` that names a list, nothing else. */
export function contextOf(q: Record<string, string | string[] | undefined>): Context {
  const one = (k: string) => { const v = q[k]; return Array.isArray(v) ? v[0] : v; };
  const method = one('method'), from = one('from');
  return {
    ...(method !== undefined && (METHODS.some((m) => m === method) || isOwnKey(method)) ? { method } : {}),
    ...(from !== undefined && fromOf(from) !== null ? { from } : {}),
  };
}

/** The `from` an item of list `kind` carries, its query being `params` with `page` set (left out on the first). */
export function fromParam(kind: ListKind, params: URLSearchParams, page: number): string {
  const p = new URLSearchParams(params);
  p.delete('page');
  if (page > 1) p.set('page', String(page));
  const q = p.toString();
  return q === '' ? kind : `${kind}?${q}`;
}

type Item = { id: string; label: string; href: string };
export type Step = { prev: Item | null; next: Item | null; at: number; total: number; back: { href: string; label: string } };
/** An item and its place in the list, counted as `total` is: a trade's is its first transfer's, as Trades counts transfers. */
type Listed = Item & { at: number };

const SIZE: Record<ListKind, number> = { tokens: LIST_PAGE, wallets: LIST_PAGE, rings: RINGS_PAGE, trades: TRADES_PAGE, ring: Number.MAX_SAFE_INTEGER };

/** One page of the list a `from` names, as items, and the list's total; a ring's also names its way back. */
async function pageOfList(c: CollectionRow, kind: ListKind, params: URLSearchParams, page: number): Promise<{ items: Listed[]; total: number; back?: { href: string; label: string } }> {
  const s = store();
  const base = `/c/${c.chainId}/${c.address}`;
  const runs = await runsOf(c.id);
  const own = ownLenses(runs);
  const ctx = await tradeContextOf(c);
  const zone = ctx.zone;
  const offset = (page - 1) * SIZE[kind];
  // An item carries the list it is opened from and the lens that list is read under.
  const method = params.get('method') ?? undefined;
  const carried = (p: number) => ({ method, from: fromParam(kind, params, p) });
  const placed = <T extends Item>(xs: T[]): (T & { at: number })[] => xs.map((x, i) => ({ ...x, at: offset + i + 1 }));
  if (kind === 'ring') {
    const anchor = addressOf(params.get('anchor') ?? '');
    const r = anchor === null ? null : await s.ring(c.id, anchor, ctx);
    if (r === null) return { items: [], total: 0 };
    const tokens = params.get('of') === 'tokens';
    // In the order its page lists them: those that traded, then those in between.
    const items = tokens
      ? r.tokens.map((t) => ({ id: t.tokenId, label: `#${tokenLabel(t.tokenId)}`, href: carry(`${base}/t/${t.tokenId}`, carried(1)) }))
      : [...r.wallets.filter((w) => w.traded), ...r.wallets.filter((w) => !w.traded)].map((w) => ({ id: w.address, label: short(w.address), href: carry(walletHref(c.chainId, w.address, base), carried(1)) }));
    return { items: placed(items), total: items.length, back: { href: `${base}/r/${anchor}`, label: `${ringName(r.line)}'s ${tokens ? 'tokens' : 'wallets'}` } };
  }
  if (kind === 'tokens' || kind === 'wallets') {
    const method = lensKeyOf(params.get('method'), own);
    if (!ctx.ran.includes(method)) return { items: [], total: 0 };
    const lv = listView(kind, { sort: params.get('sort') ?? undefined, find: params.get('q') ?? undefined });
    const o = { sort: lv.sort, find: lv.find, limit: LIST_PAGE, offset };
    if (kind === 'tokens') {
      const r = await s.lensTokens(c.id, method, { ...o, sort: o.sort as TokenSort }, ctx);
      return { total: r.total, items: placed(r.rows.map((t) => ({ id: t.tokenId, label: `#${tokenLabel(t.tokenId)}`, href: carry(`${base}/t/${t.tokenId}`, carried(page)) }))) };
    }
    const r = await s.lensWallets(c.id, method, { ...o, sort: o.sort as WalletSort }, ctx);
    return { total: r.total, items: placed(r.rows.map((w) => ({ id: w.address, label: short(w.address), href: carry(walletHref(c.chainId, w.address, base), carried(page)) }))) };
  }
  if (kind === 'rings') {
    const r = await s.rings(c.id, ctx, RINGS_PAGE, offset);
    return { total: r.total, items: placed(r.rows.map((x) => ({ id: x.anchor, label: ringName(x), href: carry(`${base}/r/${x.anchor}`, carried(page)) }))) };
  }
  const { q } = parseView(Object.fromEntries(params), zone, new Set(Object.keys(own)));
  if (holdsNothing(q, ctx.ran) !== null) return { items: [], total: 0 };
  const [rows, { total }] = await Promise.all([s.trades(c.id, q, ctx, TRADES_PAGE, offset), s.tradeCount(c.id, q, ctx)]);
  // A transaction with two transfers in the list is one stop, at its first transfer's place, as the list counts transfers.
  // Its neighbour is named by what the list is ordered by: its price on a list by price, else its day.
  const seen = new Set<string>();
  const items = rows.flatMap((t, i) => {
    if (seen.has(t.txHash)) return [];
    seen.add(t.txHash);
    const by = q.sort === 'price' ? (t.priceWei == null ? null : eth(t.priceWei)) : t.blockTime == null ? null : localTime(t.blockTime * 1000, 'date', zone, 'en-GB');
    return [{ id: t.txHash, label: `#${tokenLabel(t.tokenId)}${by === null ? '' : ` · ${by}`}`, href: carry(txHref(c.chainId, t.txHash, base), carried(page)), at: offset + i + 1 }];
  });
  return { total, items };
}

/** The steps from item `id` of the list `from` names, or null when it is not on that page any more. */
export async function stepOf(c: CollectionRow, from: NonNullable<ReturnType<typeof fromOf>>, id: string): Promise<Step | null> {
  const { kind, params } = from;
  const page = pageOf(params.get('page') ?? undefined);
  const size = SIZE[kind];
  const here = await pageOfList(c, kind, params, page);
  const i = here.items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const last = pages(here.total, size);
  // Past an edge of the page, the neighbour is the last of the page before or the first of the page after.
  const [before, after] = await Promise.all([
    i === 0 && page > 1 ? pageOfList(c, kind, params, page - 1) : null,
    i === here.items.length - 1 && page < last ? pageOfList(c, kind, params, page + 1) : null,
  ]);
  const base = `/c/${c.chainId}/${c.address}`;
  const back = `${base}/${fromParam(kind, params, page)}`;
  // A transaction whose transfers straddle the edge is on both pages: its other half is not a neighbour.
  return {
    prev: i > 0 ? here.items[i - 1]! : before?.items.findLast((x) => x.id !== id) ?? null,
    next: i < here.items.length - 1 ? here.items[i + 1]! : after?.items.find((x) => x.id !== id) ?? null,
    at: here.items[i]!.at,
    total: here.total,
    back: here.back ?? { href: back, label: `All ${here.total} ${kind}` },
  };
}
