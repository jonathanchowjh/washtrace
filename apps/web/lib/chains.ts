/**
 * Everything the console knows per chain: its display name, its block explorer,
 * and OpenSea's name for it in URLs. The one table, so adding a chain is one
 * entry. Its own file, free of imports, because a client component reads it.
 */
export interface Chain {
  name: string;
  explorer?: { name: string; host: string };
  opensea?: string;
}

export const CHAINS: Readonly<Record<number, Chain>> = {
  1: { name: 'Ethereum', explorer: { name: 'Etherscan', host: 'https://etherscan.io' }, opensea: 'ethereum' },
  10: { name: 'OP Mainnet', explorer: { name: 'Etherscan', host: 'https://optimistic.etherscan.io' }, opensea: 'optimism' },
  137: { name: 'Polygon', explorer: { name: 'Polygonscan', host: 'https://polygonscan.com' }, opensea: 'matic' },
  8453: { name: 'Base', explorer: { name: 'Basescan', host: 'https://basescan.org' }, opensea: 'base' },
  33139: { name: 'ApeChain', explorer: { name: 'Apescan', host: 'https://apescan.io' }, opensea: 'ape_chain' },
  42161: { name: 'Arbitrum One', explorer: { name: 'Arbiscan', host: 'https://arbiscan.io' }, opensea: 'arbitrum' },
  81457: { name: 'Blast', explorer: { name: 'Blastscan', host: 'https://blastscan.io' }, opensea: 'blast' },
  31337: { name: 'Local (anvil)' },
};

/** The chain's block explorer, or null for a chain with none (the local one). */
export function explorerOf(id: number): NonNullable<Chain['explorer']> | null {
  return CHAINS[id]?.explorer ?? null;
}

export function chainName(id: number): string {
  return CHAINS[id]?.name ?? `Chain ${id}`;
}
