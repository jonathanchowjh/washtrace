import { describe, expect, it } from 'vitest';
import { hitRow, kindsFor, parseSearch, scopeOf, scopeOfPath, searchArgs, tooShort } from '@/lib/search';

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

describe('tooShort', () => {
  it('says how much more a start of an address or a bare token number needs, as parseSearch reads them', () => {
    expect(tooShort('0x18')).toBe('Too short to search wallets: type at least 4 characters after 0x.');
    expect(tooShort(' 0X1 ')).toBe('Too short to search wallets: type at least 4 characters after 0x.');
    expect(tooShort('10')).toBe('Too short for a token number: type 3 digits, or #10.');
    // Each is just past what parseSearch reads as a prefix or a token.
    expect(parseSearch('0x18').kind).toBe('text');
    expect(parseSearch('10').kind).toBe('text');
  });

  it('is null for what was read in full: a prefix, a token, a hashed number, a name', () => {
    expect(['0x1832', '101', '#10', 'terra', '0xzz'].map(tooShort)).toEqual([null, null, null, null, null]);
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

describe('where a trade hit opens', () => {
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), TX = '0x' + 'c'.repeat(64);
  const none = { collections: [], tokens: [], wallets: [], trades: [], more: { collections: false, tokens: false, wallets: false, trades: false } };
  const hit = (address: string, tokenId = '1') => ({ chainId: 1, txHash: TX, address, name: null, tokenId });

  it('under its collection\'s tabs when every transfer of it found is there; else its own page, as /go sends it', async () => {
    const { tradeHref } = await import('@/lib/search');
    const one = { ...none, trades: [hit(A), hit(A, '2')] };
    expect(tradeHref(one, one.trades[0]!)).toBe(`/c/1/${A}/tx/${TX}`);
    const two = { ...none, trades: [hit(A), hit(B)] };
    expect(two.trades.map((h) => tradeHref(two, h))).toEqual([`/tx/1/${TX}`, `/tx/1/${TX}`]);
    // Past one page of hits the rest could be anywhere.
    const cut = { ...one, more: { ...none.more, trades: true } };
    expect(tradeHref(cut, cut.trades[0]!)).toBe(`/tx/1/${TX}`);
  });
});

describe('a search\'s scope', () => {
  const A = '0x' + 'a'.repeat(40);
  it('reads chain:address, and nothing else', () => {
    expect(scopeOf(`1:${A.toUpperCase().replace('0X', '0x')}`)).toEqual({ chainId: 1, address: A });
    expect([scopeOf('1'), scopeOf(`x:${A}`), scopeOf(`1:${A}:2`), scopeOf(null)]).toEqual([null, null, null, null]);
  });

  it('is the collection a console path is under', () => {
    expect(scopeOfPath(`/c/1/${A}/t/7`)).toEqual({ chainId: 1, address: A });
    expect([scopeOfPath('/'), scopeOfPath(`/w/1/${A}`)]).toEqual([null, null]);
  });

  it('opens a wallet hit under the collection\'s tabs, on its own chain only', () => {
    const hits = { collections: [], tokens: [], trades: [], wallets: [{ chainId: 1, address: A, transfers: 1 }, { chainId: 10, address: A, transfers: 1 }], more: { collections: false, tokens: false, wallets: false, trades: false } };
    const scope = { chainId: 1, address: '0x' + 'c'.repeat(40) };
    expect([hitRow(hits, 'wallets', 0, scope).href, hitRow(hits, 'wallets', 1, scope).href]).toEqual([`/c/1/${scope.address}/w/${A}`, `/w/10/${A}`]);
  });

  it('opens a wallet found by its full address on its own page when it never traded in the scope', () => {
    const hits = { collections: [], tokens: [], trades: [], wallets: [{ chainId: 1, address: A, transfers: 1, here: false }], more: { collections: false, tokens: false, wallets: false, trades: false } };
    expect(hitRow(hits, 'wallets', 0, { chainId: 1, address: '0x' + 'c'.repeat(40) }).href).toBe(`/w/1/${A}`);
  });
});

describe('the order of a search\'s kinds', () => {
  it('leads with the kind typed', () => {
    expect(kindsFor(parseSearch('#7'))[0]).toBe('tokens');
    expect(kindsFor(parseSearch('0x' + 'd'.repeat(64)))[0]).toBe('trades');
    expect(kindsFor(parseSearch('0xabcdef'))[0]).toBe('wallets');
    expect(kindsFor(parseSearch('terra'))).toEqual(['collections', 'tokens', 'wallets', 'trades']);
  });
});
