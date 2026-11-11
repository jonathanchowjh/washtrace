import { describe, expect, it } from 'vitest';
import type { Flow, LoopEdge, PairShape, TokenLine, Transfer, WalletLine, Witness } from '@washtrace/detect';
import { ownBecause } from '@/components/transfers';
import { middleWords, notFlaggedLines, partnersOf, railTxs, tokenWhy, walletRoles, walletWhy, type WhyPart } from '@/lib/why';

// What the store reads: every shape has a count, zero for the shapes a row has none of.
const shapes = (some: Partial<Record<PairShape, number>> = {}): Record<PairShape, number> =>
  ({ funder: 0, payee: 0, back: 0, forward: 0, 'direct-back': 0, 'direct-forward': 0, both: 0, ...some });
const T: TokenLine = { tokenId: '7', caught: 4, trades: 4, volumeWei: '0', lastAt: null, loops: 0, pairs: 0, wallets: 0, closedByMoney: 0, laps: 0, middles: 0, shapes: shapes() };
const W: WalletLine = { address: '0x' + '1'.repeat(40), caught: 4, trades: 4, volumeWei: '0', firstAt: null, loops: 0, pairs: 0, partners: 0, shapes: shapes() };
const text = (parts: WhyPart[]) => parts.map((p) => p.text).join('');

describe('why a row is in a lens list', () => {
  it('says loops, pairs, wallets and tails in one form for every lens', () => {
    expect(text(tokenWhy('A', { ...T, loops: 1, pairs: 0, wallets: 3, laps: 2 }))).toBe('1 loop among 3 wallets, 2 cycles');
    expect(text(tokenWhy('A', { ...T, loops: 3, wallets: 4, laps: 3, closedByMoney: 2 }))).toBe('3 loops among 4 wallets, 2 closed by money');
    // A pair stored before shapes were recorded counts in no shape and says what it always did.
    expect(text(tokenWhy('A', { ...T, loops: 1, pairs: 1, wallets: 4, laps: 2, middles: 1 }))).toContain('2 cycles, 1 through a middle wallet');
    expect(text(walletWhy('A', { ...W, loops: 1, pairs: 1, partners: 3 }))).toBe('in 1 loop and 1 linked pair with 3 other wallets');
  });

  it('names a linked pair by its shape, bare for one pair and counted for several', () => {
    const one = (shape: PairShape, middles: number) => text(tokenWhy('AC', { ...T, pairs: 1, wallets: 3, middles, shapes: shapes({ [shape]: 1 }) }));
    expect(one('funder', 1)).toBe('1 linked pair among 3 wallets, both funded by a third');
    expect(one('payee', 1)).toContain(', both paid a third');
    expect(one('back', 1)).toContain(', paid back through a third');
    expect(one('forward', 1)).toContain(', paid through a third');
    expect(one('direct-back', 0)).toContain(', paid back directly');
    expect(one('direct-forward', 0)).toContain(', paid directly');
    expect(one('both', 0)).toContain(', paid each other directly');
    expect(text(tokenWhy('AC', { ...T, pairs: 3, wallets: 5, middles: 3, shapes: shapes({ funder: 2, back: 1 }) })))
      .toBe('3 linked pairs among 5 wallets, 2 both funded by a third, 1 paid back through a third');
    // One stored without a shape beside shaped ones keeps today's words.
    expect(text(tokenWhy('AC', { ...T, pairs: 2, wallets: 4, middles: 2, shapes: shapes({ funder: 1 }) }))).toContain(', 1 both funded by a third, 1 through a middle wallet');
  });

  it('leaves out the parts that are zero', () => {
    expect(text(tokenWhy('A', { ...T, pairs: 2, wallets: 3 }))).toBe('2 linked pairs among 3 wallets');
    expect(text(walletWhy('A', { ...W, loops: 2, partners: 1 }))).toBe('in 2 loops with 1 other wallet');
    expect(text(walletWhy('A', { ...W, pairs: 1 }))).toBe('in 1 linked pair');
    // An analysis that pointed its flags at no loop has nothing to say why.
    expect(tokenWhy('A', T)).toEqual([]);
    expect(walletWhy('A', W)).toEqual([]);
  });

  it('the counts open the loops and the wallets open the wallet group; the rest is words', () => {
    expect(tokenWhy('A', { ...T, loops: 1, wallets: 3, laps: 2 })).toEqual([
      { text: '1 loop', opens: 'loops' }, { text: ' among ' }, { text: '3 wallets', opens: 'wallets' }, { text: ', 2 cycles' },
    ]);
    expect(walletWhy('A', { ...W, loops: 1, partners: 2 })).toEqual([
      { text: 'in ' }, { text: '1 loop', opens: 'loops' }, { text: ' with ' }, { text: '2 other wallets', opens: 'wallets' },
    ]);
  });

  it('says a lens of yours in the same words, and a null count silences only its own part', () => {
    const own = { ...T, loops: 3, wallets: 4, closedByMoney: 2, middles: 1, laps: 3, pairs: 0 };
    expect(text(tokenWhy('L7', own))).toContain('2 closed by money, 1 through a middle wallet');
    expect(tokenWhy('L7', own)[0]).toEqual({ text: '3 loops', opens: 'loops' });
    expect(text(walletWhy('L7', { ...W, loops: 41, pairs: 0, partners: 6 }))).toBe('in 41 loops with 6 other wallets');
    expect(tokenWhy('L7', { ...T, loops: null, pairs: null, wallets: null, laps: null, closedByMoney: null, middles: null })).toEqual([]);
    // A built-in's row is never silenced by one missing count.
    expect(text(tokenWhy('AC', { ...T, loops: null, pairs: 2, wallets: 3 }))).toBe('2 linked pairs among 3 wallets');
    expect(text(walletWhy('AC', { ...W, loops: null, pairs: 1, partners: 2 }))).toBe('in 1 linked pair with 2 other wallets');
  });
});

const w = (c: string) => '0x' + c.repeat(40);
const ZERO = '0x' + '0'.repeat(40);
const pair = (shape: PairShape | undefined, middle: string): Witness => ({ kind: 'pair', pair: [w('a'), w('b')], middle, flowTx: '0x1', ...(shape === undefined ? {} : { shape }) });
const transfer = (from: string, to: string, block: number, sale = true, tokenId = '114', ac?: Witness) =>
  ({ txHash: `0x${block}`, logIndex: 0, blockNumber: block, blockTime: null, tokenId, from, to, marketplace: sale ? 'opensea' : null, flags: ac === undefined ? {} : { AC: ac } }) as unknown as Transfer;
const flow = (from: string, to: string, block: number) => ({ txHash: `0xf${block}`, kind: 'native', from, to, valueWei: '1', token: '', blockNumber: block, blockTime: 0 }) as Flow;

describe('the wallets on a Connected to rail', () => {
  it('says each one\'s role here: seller and buyer, then funder, payee and in between, leaving out the mint and the page\'s own', () => {
    const roles = walletRoles(
      [transfer(ZERO, w('a'), 1, false), transfer(w('a'), w('b'), 2), transfer(w('b'), w('a'), 3)],
      [flow(w('f'), w('a'), 2), flow(w('b'), w('p'), 3)], [w('m')], w('z'),
    );
    expect(roles).toEqual([
      { address: w('a'), role: 'got it · seller · buyer' }, { address: w('b'), role: 'buyer · seller' },
      { address: w('m'), role: 'in between' }, { address: w('f'), role: 'funder' }, { address: w('p'), role: 'payee' },
    ]);
  });

  it('gives a pair\'s middle the one role its shape says, whichever page lists it, with or without the money', () => {
    const on = (shape: PairShape | undefined) => [transfer(w('a'), w('b'), 2, true, '114', pair(shape, w('m')))];
    const moneyIn = [flow(w('m'), w('a'), 1), flow(w('m'), w('b'), 2)];
    const roleOf = (r: { address: string; role: string }[]) => r.find((x) => x.address === w('m'))?.role;
    for (const [shape, role] of [['funder', 'funder'], ['payee', 'payee'], ['back', 'in between'], ['forward', 'in between'], [undefined, 'in between']] as const) {
      // The token page (transfers, flows, middles), the trade page (transfers) and the ring page (drawn transfers, flows, middles) agree.
      expect(roleOf(walletRoles(on(shape), moneyIn, [w('m')]))).toBe(role);
      expect(roleOf(walletRoles(on(shape), [], []))).toBe(role);
      // A wallet's page, whose transfers carry the pair, agrees with the partner's money.
      expect(roleOf(partnersOf(on(shape), [{ address: w('m'), sent: 0, received: 1 }], w('a')))).toBe(role);
    }
  });

  it('on a wallet\'s page, a middle of its pairs has its pair\'s role on every page, though no transfer shown carries the pair', () => {
    const me = w('a');
    // Page 2, or a filter: the transfers shown are of another pair, so the middle is read from the pairs themselves.
    const shown = [transfer(me, w('c'), 7)];
    const partners = [{ address: w('m'), sent: 0, received: 1 }, { address: w('n'), sent: 1, received: 0 }];
    const pairs = [{ middle: w('m'), shape: 'back' as const }, { middle: w('n'), shape: 'funder' as const }, { middle: w('q'), shape: null }];
    const on = (shape: PairShape) => walletRoles([transfer(w('a'), w('b'), 2, true, '114', pair(shape, w('m')))], [], [], me).find((x) => x.address === w('m'))?.role;
    const roles = partnersOf(shown, partners, me, pairs);
    // The token page says "in between" for a back-shaped middle: so does this page, not "funder".
    expect(roles.find((x) => x.address === w('m'))?.role).toBe(on('back'));
    expect(roles.find((x) => x.address === w('n'))?.role).toBe('funder');
    // A middle with no money here is still listed; a partner that is no middle keeps money's word.
    expect(roles.find((x) => x.address === w('q'))?.role).toBe('in between');
    expect(partnersOf(shown, [{ address: w('d'), sent: 1, received: 0 }], me, pairs).find((x) => x.address === w('d'))?.role).toBe('payee');
  });

  it('on a wallet\'s page, lists those it traded with, then its money partners by who paid whom', () => {
    const me = w('a');
    expect(partnersOf([transfer(me, w('b'), 1)], [{ address: w('b'), sent: 1, received: 0 }, { address: w('c'), sent: 0, received: 2 }, { address: w('d'), sent: 1, received: 0 }], me))
      .toEqual([{ address: w('b'), role: 'buyer' }, { address: w('c'), role: 'funder' }, { address: w('d'), role: 'payee' }]);
  });

  it('lists each transaction once, by block, a sale before a payment in it', () => {
    expect(railTxs([transfer(w('a'), w('b'), 5), transfer(w('b'), w('a'), 2, false)], [flow(w('f'), w('a'), 3)]).map((x) => x.what))
      .toEqual(['Transfer of #114', 'Payment', 'Sale of #114']);
  });
});

describe('a never-traded middle\'s lead', () => {
  it('says what it did by the shape of its pairs, in the plural for several', () => {
    expect(middleWords([{ shape: 'funder' }])).toBe('Funded the seller and buyer of');
    expect(middleWords([{ shape: 'payee' }])).toBe('Was paid by the seller and buyer of');
    expect(middleWords([{ shape: 'back' }])).toContain("Passed the buyer's money back to the seller of");
    expect(middleWords([{ shape: 'forward' }])).toBe("Passed the seller's money to the buyer of");
    expect(middleWords([{ shape: 'forward' }, { shape: 'forward' }])).toBe("Passed the sellers' money to the buyers of");
    expect(middleWords([{ shape: 'funder' }, { shape: 'funder' }])).toBe('Funded the sellers and buyers of');
    // Pairs stored without a shape, or of different shapes, say only that it sat between them.
    expect(middleWords([{ shape: null }])).toBe('Is in between the seller and buyer of');
    expect(middleWords([{ shape: 'funder' }, { shape: 'payee' }])).toContain('in between');
  });
});

describe('why a lens of yours flagged one transfer (ownBecause)', () => {
  it('counts an other-token step of the way back as money, as an ETH one', () => {
    const [a, b, m] = ['a', 'b', 'd'].map((c) => '0x' + c.repeat(40)) as [string, string, string];
    const step = (from: string, to: string, kind: LoopEdge['kind'], token: string | null = null): LoopEdge =>
      ({ from, to, kind, tx: null, time: null, amountWei: null, tokenId: null, token });
    const path = [step(a, b, 'nft-token'), step(b, m, 'other-tokens', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), step(m, a, 'eth')];
    expect(ownBecause({ path, wallets: [a, b, m] })).toBe('Back to the seller through 1 wallet, 2 by money');
  });
});

describe('why a token was not flagged', () => {
  const a = '0x' + 'a'.repeat(40);
  const near = { cycles: 0, wallets: [a], minCycles: 2, custody: [] as { address: string; name: string }[] };

  it('says the token never comes back, or came back once or twice, against what Round trips needs', () => {
    expect(notFlaggedLines(near, [])[0]).toBe('Round trips: the token never comes back to a wallet that held it.');
    expect(notFlaggedLines({ ...near, cycles: 1 }, [])[0]).toBe('Round trips: it came back to 0xaaaa…aaaa once; a pattern needs 2 cycles.');
    expect(notFlaggedLines({ ...near, cycles: 2, minCycles: 3 }, [])[0]).toContain('2 times; a pattern needs 3 cycles.');
  });

  it('names the custodian, then the lenses that ran floor then ceiling then not counted, and a lens not run says so', () => {
    const lines = notFlaggedLines({ ...near, custody: [{ address: '0x29469395eaf6f95920e59f858042f0e28d98a20b', name: 'Blur Blend' }] }, []);
    expect(lines[1]).toBe('Its moves to 0x2946…a20b are loans held in custody (Blur Blend), not sales: no lens judges them.');
    expect(lines.slice(2).map((l) => l.split(':')[0])).toEqual(['Linked wallets', 'Money loops back']);
    expect(lines[2]).toBe('Linked wallets: no buyer and seller of it paid each other or share a money partner it reads.');
    expect(lines[3]).toBe('Money loops back: no money it reads went from a buyer of it back to the seller.');
    const partial = notFlaggedLines(near, ['AU']);
    expect(partial.join(' ')).not.toContain('Money loops back: ');
    expect(partial[partial.length - 1]).toContain('Money loops back');
    expect(partial[partial.length - 1]).toContain('did not run');
  });
});
