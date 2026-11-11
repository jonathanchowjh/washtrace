/**
 * Where else to look at a collection, a token or a wallet. Marketplaces are
 * linked by contract address, never by their own slug, so a link needs
 * nothing the chain does not already say.
 */

import { venueName, venueOf } from '@washtrace/detect/trades';
import { CHAINS, explorerOf } from './chains';

export type Link = { label: string; href: string };

/** The collection on its explorer, on OpenSea, and on Ethereum on LooksRare and Blur, where most of its wash trading paid. */
export function collectionLinks(chainId: number, address: string): Link[] {
  const { explorer: e, opensea: os } = CHAINS[chainId] ?? {};
  return [
    ...(e ? [{ label: e.name, href: `${e.host}/token/${address}` }] : []),
    ...(os ? [{ label: 'OpenSea', href: `https://opensea.io/contract/${os}/${address}` }] : []),
    ...(chainId === 1 ? [
      { label: 'LooksRare', href: `https://looksrare.org/collections/${address}` },
      { label: 'Blur', href: `https://blur.io/eth/collection/${address}` },
    ] : []),
  ];
}

/** The transaction on its chain's explorer, or null for a chain with none: a link there is left out, never sent to another chain's explorer. */
export function explorerTx(chainId: number, hash: string): string | null {
  const e = explorerOf(chainId);
  return e ? `${e.host}/tx/${hash}` : null;
}

/** The address (a wallet or a contract) on its chain's explorer, or null for a chain with none. */
export function explorerAddress(chainId: number, address: string): string | null {
  const e = explorerOf(chainId);
  return e ? `${e.host}/address/${address}` : null;
}

export function tokenLinks(chainId: number, address: string, tokenId: string): Link[] {
  const { explorer: e, opensea: os } = CHAINS[chainId] ?? {};
  return [
    ...(e ? [{ label: e.name, href: `${e.host}/nft/${address}/${tokenId}` }] : []),
    ...(os ? [{ label: 'OpenSea', href: `https://opensea.io/item/${os}/${address}/${tokenId}` }] : []),
    ...(chainId === 1 ? [
      { label: 'LooksRare', href: `https://looksrare.org/collections/${address}/${tokenId}` },
      { label: 'Blur', href: `https://blur.io/eth/asset/${address}/${tokenId}` },
    ] : []),
  ];
}

export function walletLinks(chainId: number, address: string): Link[] {
  const { explorer: e, opensea: os } = CHAINS[chainId] ?? {};
  return [
    ...(e ? [{ label: e.name, href: `${e.host}/address/${address}` }] : []),
    ...(os ? [{ label: 'OpenSea', href: `https://opensea.io/${address}` }] : []),
    ...(chainId === 1 ? [{ label: 'Blur', href: `https://blur.io/eth/portfolio/${address}` }] : []),
  ];
}

/** Sales per marketplace under its reader's name, busiest first. `key` is the name Trades filters it by (a VENUES key, or the raw string no venue lists). */
export function venues(marketplaces: readonly { name: string; sales: number }[]): { key: string; name: string; sales: number }[] {
  const by = new Map<string, { key: string; sales: number }>();
  for (const m of marketplaces) {
    const name = venueName(m.name);
    by.set(name, { key: venueOf(m.name), sales: (by.get(name)?.sales ?? 0) + m.sales });
  }
  return [...by].map(([name, v]) => ({ key: v.key, name, sales: v.sales })).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
}

/** The collections list with its view: the tab, the Find text, and the sort. Empty parts are left out, so the plain list is `/`. */
export function homeHref(q: { tab?: string; find?: string; sort?: string; dir?: string }): string {
  const p = new URLSearchParams();
  for (const k of ['tab', 'find', 'sort', 'dir'] as const) if (q[k]) p.set(k, q[k]);
  const s = p.toString();
  return s ? `/?${s}` : '/';
}

/**
 * A collection's Tokens or Wallets list under one lens: its order, Find and
 * page left out at their defaults. The lens is always named, so the list a
 * link opens never shifts with the default.
 */
export function listHref(base: string, kind: 'tokens' | 'wallets', o: { method: string; sort?: string; q?: string | null; page?: number }): string {
  const p = [`method=${encodeURIComponent(o.method)}`];
  if (o.sort !== undefined && o.sort !== 'caught') p.push(`sort=${encodeURIComponent(o.sort)}`);
  if (o.q != null) p.push(`q=${encodeURIComponent(o.q)}`);
  if ((o.page ?? 1) > 1) p.push(`page=${o.page}`);
  return `${base}/${kind}?${p.join('&')}`;
}

/**
 * A wallet's page. `within`, a collection's base, opens the one under that
 * collection's tabs instead, so a reader who came from it stays in it.
 */
export function walletHref(chainId: number, address: string, within?: string | null): string {
  return within ? `${within}/w/${address}` : `/w/${chainId}/${address}`;
}

/** A transaction's page; with `within`, the one under that collection's tabs. */
export function txHref(chainId: number, hash: string, within?: string | null): string {
  return within ? `${within}/tx/${hash}` : `/tx/${chainId}/${hash}`;
}

/**
 * A lens's tab on the collection's Methods page (`base`, the collection's):
 * with `lens`, its editor (`new`, `copy-<key>`, `edit-<key>`); with
 * `evidence`, scrolled to the lens's panel.
 */
export function lensTabHref(base: string, method: string, o: { lens?: string; evidence?: boolean } = {}): string {
  return `${base}/methods?method=${encodeURIComponent(method)}${o.lens === undefined ? '' : `&lens=${o.lens}`}${o.evidence ? '#evidence' : ''}`;
}

/** The hover card's read for one wallet, token or ring of the collection at `base` (its `/c/<chain>/<address>`). */
export function cardSrc(base: string, of: 'wallet' | 'token' | 'ring', value: string): string {
  return `/api/collections/${base.slice('/c/'.length)}/card?${of}=${encodeURIComponent(value)}`;
}

/** What a link out of a page keeps of how the reader got there: the lens, and the list (lib/step.ts) it was opened from. */
export type Context = { method?: string; from?: string };

/**
 * `href` with `ctx` added to its query, before any #hash: `method` unless the
 * link names one, then `from`. A Trades link is left alone: Trades reads
 * `from` as its date filter, so a list's `from` there would silently drop it.
 */
export function carry(href: string, ctx: Context): string {
  const [path = '', hash] = href.split('#', 2);
  const [where = '', query = ''] = path.split('?', 2);
  if (/\/trades$/.test(where)) return href;
  const add: string[] = [];
  if (ctx.method !== undefined && !new URLSearchParams(query).has('method')) add.push(`method=${encodeURIComponent(ctx.method)}`);
  if (ctx.from !== undefined) add.push(`from=${encodeURIComponent(ctx.from)}`);
  if (add.length === 0) return href;
  return `${path}${path.includes('?') ? '&' : '?'}${add.join('&')}${hash === undefined ? '' : `#${hash}`}`;
}
