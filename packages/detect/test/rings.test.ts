import { describe, expect, it } from 'vitest';
import { ringsOf } from '../src/rings.js';

describe('rings', () => {
  it('makes one ring of two loops that share a wallet, named by its smallest wallet', () => {
    const r = ringsOf([{ id: 0, wallets: ['0xc', '0xb'] }, { id: 1, wallets: ['0xb', '0xa'] }]);
    expect([...r]).toEqual([[0, '0xa'], [1, '0xa']]);
  });

  it('joins a linked pair\'s middle to its pair, and through it to another pair', () => {
    // Seller 0xd and buyer 0xe share money with 0xm; so do 0xf and 0xg.
    const r = ringsOf([{ id: 0, wallets: ['0xd', '0xe', '0xm'] }, { id: 1, wallets: ['0xf', '0xg', '0xm'] }]);
    expect(r.get(0)).toBe(r.get(1));
    expect(r.get(0)).toBe('0xd');
  });

  it('keeps wallets no witness joins in rings of their own', () => {
    const r = ringsOf([{ id: 0, wallets: ['0x1', '0x2'] }, { id: 1, wallets: ['0x3', '0x4'] }]);
    expect([r.get(0), r.get(1)]).toEqual(['0x1', '0x3']);
  });

  it('joins through a chain however long, in any order', () => {
    const chain = Array.from({ length: 50 }, (_, i) => ({ id: i, wallets: [`0x${String(i).padStart(3, '0')}`, `0x${String(i + 1).padStart(3, '0')}`] })).reverse();
    expect(new Set(ringsOf(chain).values())).toEqual(new Set(['0x000']));
  });

  it('puts a witness with no wallets in no ring', () => {
    expect(ringsOf([{ id: 0, wallets: [] }]).size).toBe(0);
  });
});
