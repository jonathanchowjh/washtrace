/**
 * Where else to look at a collection, a token or a wallet. Marketplaces are
 * linked by contract address, never by their own slug, so a link needs
 * nothing the chain does not already say.
 */

import { VENUES, venueOf } from '@washtrace/detect/trades';
import { CHAINS } from './chains';

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
  const e = CHAINS[chainId]?.explorer;
  return e ? `${e.host}/tx/${hash}` : null;
}

/** The address (a wallet or a contract) on its chain's explorer, or null for a chain with none. */
export function explorerAddress(chainId: number, address: string): string | null {
  const e = CHAINS[chainId]?.explorer;
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

/** Marketplace contracts by the name a reader knows them by: every Seaport, and Wyvern before it, is OpenSea's. */
export function venueName(venue: string): string {
  const key = venueOf(venue);
  return Object.hasOwn(VENUES, key) ? VENUES[key]!.name : venue;
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
