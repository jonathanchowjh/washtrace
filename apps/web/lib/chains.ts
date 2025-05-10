/** Display names. Its own file, free of imports, because a client component reads it. */
export const CHAINS: Readonly<Record<number, string>> = {
  1: 'Ethereum',
  10: 'OP Mainnet',
  137: 'Polygon',
  8453: 'Base',
  33139: 'ApeChain',
  42161: 'Arbitrum One',
  81457: 'Blast',
  31337: 'Local (anvil)',
};

export function chainName(id: number): string {
  return CHAINS[id] ?? `Chain ${id}`;
}
