/**
 * Where else to look at a collection, a token or a wallet. Marketplaces are
 * linked by contract address, never by their own slug, so a link needs
 * nothing the chain does not already say.
 */

export type Link = { label: string; href: string };

/** Each chain's block explorer. The one table of them: format's explorer() reads it too. */
export const EXPLORERS: Readonly<Record<number, { name: string; host: string }>> = {
  1: { name: 'Etherscan', host: 'https://etherscan.io' },
  10: { name: 'Etherscan', host: 'https://optimistic.etherscan.io' },
  137: { name: 'Polygonscan', host: 'https://polygonscan.com' },
  8453: { name: 'Basescan', host: 'https://basescan.org' },
  42161: { name: 'Arbiscan', host: 'https://arbiscan.io' },
  81457: { name: 'Blastscan', host: 'https://blastscan.io' },
  33139: { name: 'Apescan', host: 'https://apescan.io' },
};

/** OpenSea's name for each chain in its URLs. */
const OPENSEA: Readonly<Record<number, string>> = {
  1: 'ethereum', 10: 'optimism', 137: 'matic', 8453: 'base', 42161: 'arbitrum', 81457: 'blast', 33139: 'ape_chain',
};

/** The collection on its explorer, on OpenSea, and on Ethereum on LooksRare and Blur, where most of its wash trading paid. */
export function collectionLinks(chainId: number, address: string): Link[] {
  const e = EXPLORERS[chainId];
  const os = OPENSEA[chainId];
  return [
    ...(e ? [{ label: e.name, href: `${e.host}/token/${address}` }] : []),
    ...(os ? [{ label: 'OpenSea', href: `https://opensea.io/contract/${os}/${address}` }] : []),
    ...(chainId === 1 ? [
      { label: 'LooksRare', href: `https://looksrare.org/collections/${address}` },
      { label: 'Blur', href: `https://blur.io/eth/collection/${address}` },
    ] : []),
  ];
}

export function tokenLinks(chainId: number, address: string, tokenId: string): Link[] {
  const e = EXPLORERS[chainId];
  const os = OPENSEA[chainId];
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
  const e = EXPLORERS[chainId];
  return [
    ...(e ? [{ label: e.name, href: `${e.host}/address/${address}` }] : []),
    ...(OPENSEA[chainId] ? [{ label: 'OpenSea', href: `https://opensea.io/${address}` }] : []),
    ...(chainId === 1 ? [{ label: 'Blur', href: `https://blur.io/eth/portfolio/${address}` }] : []),
  ];
}

/** Marketplace contracts by the name a reader knows them by: every Seaport, and Wyvern before it, is OpenSea's. */
export function venueName(venue: string): string {
  if (venue.startsWith('seaport') || venue.startsWith('wyvern')) return 'OpenSea';
  if (venue.startsWith('blur')) return 'Blur';
  if (venue.startsWith('looksrare')) return 'LooksRare';
  if (venue === 'x2y2') return 'X2Y2';
  return venue;
}

/** Sales per marketplace under its reader's name, busiest first. */
export function venues(marketplaces: readonly { name: string; sales: number }[]): { name: string; sales: number }[] {
  const by = new Map<string, number>();
  for (const m of marketplaces) by.set(venueName(m.name), (by.get(venueName(m.name)) ?? 0) + m.sales);
  return [...by].map(([name, sales]) => ({ name, sales })).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
}
