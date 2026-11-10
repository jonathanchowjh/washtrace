import { moneyFor, type CollectionRow, type TokenSort, type WalletSort } from '@washtrace/detect';
import { lensKeyOf, readerZone } from './api';
import { runsOf } from './collection-reads';
import { short, tokenLabel } from './format';
import { txHref, walletHref, withFrom } from './links';
import { lensContext, ownLenses } from './metrics';
import { pageOf } from './params';
import { store } from './store';
import { TRADES_PAGE, holdsNothing, parseView } from './trades-url';
import { LIST_PAGE, RINGS_PAGE, listView } from './views';

/**
 * Stepping through a list from one of its items: ‹ and › (and J and K) open
 * the item before and after it, past the edge of its page too. An item opened
 * from a list carries `from`, the list's own path and query under the
 * collection (`tokens?method=A&page=2`), so the step reads that same page.
 * The item is found on it by what it is, not by its place, because a new
 * analysis can reorder a list: one no longer on its page steps nowhere, and
 * its page offers the way back to the list.
 */

export type ListKind = 'tokens' | 'wallets' | 'rings' | 'trades';
const KINDS: readonly ListKind[] = ['tokens', 'wallets', 'rings', 'trades'];

/** A `from`: the list's kind and its query; null for anything else. */
export function fromOf(raw: string | string[] | undefined): { kind: ListKind; params: URLSearchParams } | null {
  if (typeof raw !== 'string') return null;
  const [path, query = ''] = raw.split('?', 2);
  const kind = KINDS.find((k) => k === path);
  return kind === undefined ? null : { kind, params: new URLSearchParams(query) };
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

const SIZE: Record<ListKind, number> = { tokens: LIST_PAGE, wallets: LIST_PAGE, rings: RINGS_PAGE, trades: TRADES_PAGE };
const NOUN: Record<ListKind, string> = { tokens: 'tokens', wallets: 'wallets', rings: 'rings', trades: 'trades' };

/** One page of the list a `from` names, as items, and the list's total. */
async function pageOfList(c: CollectionRow, kind: ListKind, params: URLSearchParams, page: number): Promise<{ items: Item[]; total: number }> {
  const s = store();
  const base = `/c/${c.chainId}/${c.address}`;
  const runs = await runsOf(c.id);
  const own = ownLenses(runs);
  const zone = await readerZone();
  const ctx = { money: moneyFor(c.chainId), zone, ...lensContext(c.latest, runs) };
  const offset = (page - 1) * SIZE[kind];
  const from = (p: number) => fromParam(kind, params, p);
  if (kind === 'tokens' || kind === 'wallets') {
    const method = lensKeyOf(params.get('method'), own);
    if (!ctx.ran.includes(method)) return { items: [], total: 0 };
    const lv = listView(kind, { sort: params.get('sort') ?? undefined, find: params.get('q') ?? undefined });
    const o = { sort: lv.sort, find: lv.find, limit: LIST_PAGE, offset };
    if (kind === 'tokens') {
      const r = await s.lensTokens(c.id, method, { ...o, sort: o.sort as TokenSort }, ctx);
      return { total: r.total, items: r.rows.map((t) => ({ id: t.tokenId, label: `#${tokenLabel(t.tokenId)}`, href: withFrom(`${base}/t/${t.tokenId}`, from(page)) })) };
    }
    const r = await s.lensWallets(c.id, method, { ...o, sort: o.sort as WalletSort }, ctx);
    return { total: r.total, items: r.rows.map((w) => ({ id: w.address, label: short(w.address), href: withFrom(walletHref(c.chainId, w.address, base), from(page)) })) };
  }
  if (kind === 'rings') {
    const r = await s.rings(c.id, ctx, RINGS_PAGE, offset);
    return { total: r.total, items: r.rows.map((x) => ({ id: x.anchor, label: `Ring ${x.rank}`, href: withFrom(`${base}/r/${x.anchor}`, from(page)) })) };
  }
  const { q } = parseView(Object.fromEntries(params), zone, new Set(Object.keys(own)));
  if (holdsNothing(q, ctx.ran) !== null) return { items: [], total: 0 };
  const [rows, { total }] = await Promise.all([s.trades(c.id, q, ctx, TRADES_PAGE, offset), s.tradeCount(c.id, q, ctx)]);
  // A transaction with two transfers in the list is one stop.
  const seen = new Set<string>();
  const items = rows.flatMap((t) => (seen.has(t.txHash) ? [] : (seen.add(t.txHash), [{ id: t.txHash, label: `#${tokenLabel(t.tokenId)}`, href: withFrom(txHref(c.chainId, t.txHash, base), from(page)) }])));
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
  const pages = Math.max(1, Math.ceil(here.total / size));
  // Past an edge of the page, the neighbour is the last of the page before or the first of the page after.
  const [before, after] = await Promise.all([
    i === 0 && page > 1 ? pageOfList(c, kind, params, page - 1) : null,
    i === here.items.length - 1 && page < pages ? pageOfList(c, kind, params, page + 1) : null,
  ]);
  const base = `/c/${c.chainId}/${c.address}`;
  const back = `${base}/${fromParam(kind, params, page)}`;
  return {
    prev: i > 0 ? here.items[i - 1]! : before?.items.at(-1) ?? null,
    next: i < here.items.length - 1 ? here.items[i + 1]! : after?.items[0] ?? null,
    at: (page - 1) * size + i + 1,
    total: here.total,
    back: { href: back, label: `All ${here.total} ${NOUN[kind]}` },
  };
}
