import { describe, expect, it } from 'vitest';
import { parseSearch, searchArgs } from '@/lib/search';

describe('parseSearch', () => {
  it('reads what was typed', () => {
    expect(parseSearch(' 0x' + 'A'.repeat(64))).toEqual({ kind: 'tx', tx: '0x' + 'a'.repeat(64) });
    expect(parseSearch('0x' + 'B'.repeat(40))).toEqual({ kind: 'address', address: '0x' + 'b'.repeat(40) });
    expect(parseSearch('0x3A1f')).toEqual({ kind: 'prefix', prefix: '0x3a1f' });
    expect(parseSearch('#12')).toEqual({ kind: 'token', tokenId: '12', text: '12' });
    expect(parseSearch('1234')).toEqual({ kind: 'token', tokenId: '1234', text: '1234' });
    expect(parseSearch('12')).toEqual({ kind: 'text', text: '12' });
    expect(parseSearch('bored ape')).toEqual({ kind: 'text', text: 'bored ape' });
    expect(parseSearch('x')).toEqual({ kind: 'empty' });
  });

  it('never throws on junk: a half-hex, a stray #, hex of the wrong length, blanks', () => {
    expect(parseSearch('')).toEqual({ kind: 'empty' });
    expect(parseSearch('   ')).toEqual({ kind: 'empty' });
    expect(parseSearch('#')).toEqual({ kind: 'empty' });
    expect(parseSearch('0x')).toEqual({ kind: 'text', text: '0x' });
    expect(parseSearch('0xabc')).toEqual({ kind: 'text', text: '0xabc' });
    expect(parseSearch('0x' + 'a'.repeat(50))).toEqual({ kind: 'text', text: '0x' + 'a'.repeat(50) });
    expect(parseSearch('#hello')).toEqual({ kind: 'text', text: 'hello' });
    expect(parseSearch('1'.repeat(200)).kind).toBe('text');
  });
});

describe('searchArgs', () => {
  it('drops an unknown kind and clamps a bad page to 1', () => {
    expect(searchArgs({ kind: 'nope', page: '-2' })).toEqual({ only: undefined, page: 1 });
    expect(searchArgs({ kind: 'wallets', page: 'abc' })).toEqual({ only: 'wallets', page: 1 });
    expect(searchArgs({ kind: 'trades', page: '3' })).toEqual({ only: 'trades', page: 3 });
    expect(searchArgs({})).toEqual({ only: undefined, page: 1 });
  });

  it('reads a huge or fractional page as the first, and ignores a page with no kind', () => {
    expect(searchArgs({ kind: 'wallets', page: '100000000000000000000' })).toEqual({ only: 'wallets', page: 1 });
    expect(searchArgs({ kind: 'wallets', page: '1000001' })).toEqual({ only: 'wallets', page: 1 });
    expect(searchArgs({ kind: 'wallets', page: '2.5' })).toEqual({ only: 'wallets', page: 1 });
    expect(searchArgs({ kind: 'wallets', page: '1000000' })).toEqual({ only: 'wallets', page: 1_000_000 });
    expect(searchArgs({ page: '3' })).toEqual({ only: undefined, page: 1 });
  });
});
