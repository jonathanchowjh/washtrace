import { describe, expect, it } from 'vitest';
import { collectionLinks, tokenLinks, venues, walletLinks } from '@/lib/links';

const A = '0x4e1f41613c9084fdb9e34e11fae9412427480e56';

describe('links', () => {
  it('sends an Ethereum collection to its explorer and the marketplaces it traded on', () => {
    expect(collectionLinks(1, A)).toEqual([
      { label: 'Etherscan', href: `https://etherscan.io/token/${A}` },
      { label: 'OpenSea', href: `https://opensea.io/contract/ethereum/${A}` },
      { label: 'LooksRare', href: `https://looksrare.org/collections/${A}` },
      { label: 'Blur', href: `https://blur.io/eth/collection/${A}` },
    ]);
  });

  it('names each chain as its explorer and OpenSea do, and leaves Ethereum-only marketplaces out elsewhere', () => {
    expect(tokenLinks(8453, A, '7')).toEqual([
      { label: 'Basescan', href: `https://basescan.org/nft/${A}/7` },
      { label: 'OpenSea', href: `https://opensea.io/item/base/${A}/7` },
    ]);
  });

  it('links nowhere for a chain with no public explorer, such as a local anvil', () => {
    expect(walletLinks(31337, A)).toEqual([]);
  });

  it('counts sales under the marketplace a reader knows, busiest first', () => {
    expect(venues([{ name: 'blur-v2', sales: 7 }, { name: 'seaport-1.1', sales: 4 }, { name: 'blur', sales: 5 }, { name: 'wyvern-1', sales: 3 }, { name: 'looksrare', sales: 2 }, { name: 'looksrare-v2', sales: 1 }]))
      .toEqual([{ name: 'Blur', sales: 12 }, { name: 'OpenSea', sales: 7 }, { name: 'LooksRare', sales: 3 }]);
  });
});
