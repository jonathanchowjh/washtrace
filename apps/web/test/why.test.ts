import { describe, expect, it } from 'vitest';
import type { TokenLine, WalletLine } from '@washtrace/detect';
import { tokenWhy, walletWhy, type WhyPart } from '@/lib/why';

const T: TokenLine = { tokenId: '7', caught: 4, trades: 4, volumeWei: '0', lastAt: null, loops: 0, pairs: 0, wallets: 0, closedByMoney: 0, laps: 0, middles: 0 };
const W: WalletLine = { address: '0x' + '1'.repeat(40), caught: 4, trades: 4, volumeWei: '0', firstAt: null, loops: 0, pairs: 0, partners: 0 };
const text = (parts: WhyPart[]) => parts.map((p) => p.text).join('');

describe('why a row is in a lens list', () => {
  it('says loops, pairs, wallets and tails in one form for every lens', () => {
    expect(text(tokenWhy({ ...T, loops: 1, pairs: 0, wallets: 3, laps: 2 }))).toBe('1 loop among 3 wallets, 2 laps');
    expect(text(tokenWhy({ ...T, loops: 3, wallets: 4, laps: 3, closedByMoney: 2 }))).toBe('3 loops among 4 wallets, 2 closed by money');
    expect(text(tokenWhy({ ...T, loops: 1, pairs: 1, wallets: 4, laps: 2, middles: 1 }))).toBe('1 loop and 1 linked pair among 4 wallets, 2 laps, 1 through a middle wallet');
    expect(text(walletWhy({ ...W, loops: 1, pairs: 1, partners: 3 }))).toBe('in 1 loop and 1 linked pair with 3 wallets');
  });

  it('leaves out the parts that are zero', () => {
    expect(text(tokenWhy({ ...T, pairs: 2, wallets: 3 }))).toBe('2 linked pairs among 3 wallets');
    expect(text(walletWhy({ ...W, loops: 2, partners: 1 }))).toBe('in 2 loops with 1 wallet');
    expect(text(walletWhy({ ...W, pairs: 1 }))).toBe('in 1 linked pair');
    // An analysis that pointed its flags at no loop has nothing to say why.
    expect(tokenWhy(T)).toEqual([]);
    expect(walletWhy(W)).toEqual([]);
  });

  it('the counts open the loops and the wallets open the wallet group; the rest is words', () => {
    expect(tokenWhy({ ...T, loops: 1, wallets: 3, laps: 2 })).toEqual([
      { text: '1 loop', opens: 'loops' }, { text: ' among ' }, { text: '3 wallets', opens: 'wallets' }, { text: ', 2 laps' },
    ]);
    expect(walletWhy({ ...W, loops: 1, partners: 2 })).toEqual([
      { text: 'in ' }, { text: '1 loop', opens: 'loops' }, { text: ' with ' }, { text: '2 wallets', opens: 'wallets' },
    ]);
  });
});
