import { describe, expect, it } from 'vitest';
import type { Flow, LoopEdge, PairShape, TokenLine, Transfer, WalletLine, Witness } from '@washtrace/detect';
import { ownBecause } from '@/components/transfers';
import { middleWords, notFlaggedLines, partnersOf, railTxs, ringPattern, ringStory, tokenStory, tokenWhy, walletRoles, walletWhy, type RingEvidence, type WhyPart } from '@/lib/why';

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
  it('says each one\'s role here: seller and buyer, then in between, leaving out the mint and the page\'s own, and naming no one for money alone', () => {
    const roles = walletRoles(
      [transfer(ZERO, w('a'), 1, false), transfer(w('a'), w('b'), 2), transfer(w('b'), w('a'), 3)],
      [w('m')], w('z'),
    );
    expect(roles).toEqual([
      { address: w('a'), role: 'got it · seller · buyer' }, { address: w('b'), role: 'buyer · seller' },
      { address: w('m'), role: 'in between' },
    ]);
  });

  it('names the wallets on a Money loops back path in between: money passed through them, they funded or were paid by no one side', () => {
    const loop: Witness = { kind: 'scc+flow', wallets: [w('a'), w('b')], cycles: 1, via: [[w('b'), w('a')]], paths: [{ wallets: [w('b'), w('h'), w('i'), w('a')], txs: ['0x1', '0x2', '0x3'] }] };
    const sold = Object.assign(transfer(w('a'), w('b'), 2), { flags: { AU: loop } });
    // The token page passes the path's wallets beyond its holders as middles (drawingInputs).
    expect(walletRoles([sold], [w('h'), w('i')])).toEqual([
      { address: w('a'), role: 'seller' }, { address: w('b'), role: 'buyer' }, { address: w('h'), role: 'in between' }, { address: w('i'), role: 'in between' },
    ]);
  });

  it('gives a pair\'s middle the one role its shape says, whichever page lists it', () => {
    const on = (shape: PairShape | undefined) => [transfer(w('a'), w('b'), 2, true, '114', pair(shape, w('m')))];
    const roleOf = (r: { address: string; role: string }[]) => r.find((x) => x.address === w('m'))?.role;
    for (const [shape, role] of [['funder', 'funder'], ['payee', 'payee'], ['back', 'in between'], ['forward', 'in between'], [undefined, 'in between']] as const) {
      // The token page (transfers, middles), the trade page (transfers) and the ring page (drawn transfers, middles) agree.
      expect(roleOf(walletRoles(on(shape), [w('m')]))).toBe(role);
      expect(roleOf(walletRoles(on(shape), []))).toBe(role);
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
    const on = (shape: PairShape) => walletRoles([transfer(w('a'), w('b'), 2, true, '114', pair(shape, w('m')))], [], me).find((x) => x.address === w('m'))?.role;
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

describe('a ring\'s story (ringStory)', () => {
  const LINE = { wallets: 3, sales: 1, pattern: { loops: 0, pairs: 0, middles: 0, shapes: shapes() } };
  const M = '0x' + 'c'.repeat(40), N = '0x' + 'd'.repeat(40);
  const direct = (s: PairShape | null | undefined) => s === 'direct-back' || s === 'direct-forward' || s === 'both';
  // One sale of `token` in block 10, its pair's evidence payments in blocks `paid`.
  const pair = (shape: PairShape | null | undefined, paid: number[], o: { token?: string; middle?: string | null } = {}): RingEvidence =>
    ({ kind: 'pair', token: o.token ?? '114', shape, middle: o.middle === undefined ? (direct(shape) ? null : M) : o.middle, sale: 10, paid });
  const loop = (token: string, wallets = 2, cycles = 2): RingEvidence => ({ kind: 'loop', token, wallets, cycles });
  const one = (e: RingEvidence) => ringStory(LINE, [e]);

  it('says one pair by its shape, naming the token', () => {
    expect(one(pair('funder', [8, 9]))).toBe('One wallet paid both the seller and the buyer of #114, before the sale.');
    expect(one(pair('payee', [11, 12]))).toBe('The seller and the buyer of #114 both paid one wallet, after the sale.');
    expect(one(pair('back', [11, 12]))).toBe("The buyer's money went back to the seller of #114 through one wallet, after the sale.");
    expect(one(pair('forward', [8]))).toBe("The seller's money went to the buyer of #114 through one wallet, before the sale.");
    expect(one(pair('direct-back', [12]))).toBe('The buyer of #114 paid the seller back directly, after the sale.');
    expect(one(pair('direct-back', [8, 12]))).toBe('The buyer of #114 also paid the seller directly, outside the sale.');
    expect(one(pair('direct-forward', [8]))).toBe('The seller of #114 also paid the buyer directly, before the sale.');
    expect(one(pair('both', [8, 12]))).toBe('The seller and the buyer of #114 paid each other directly, outside the sale.');
    // With a time word, the time says it was no part of the sale; "outside the sale" only stands in for one.
    expect(one(pair('direct-back', [8]))).toBe('The buyer of #114 also paid the seller directly, before the sale.');
    expect(one(pair('both', [12]))).toBe('The seller and the buyer of #114 paid each other directly, after the sale.');
    expect(one(pair('direct-forward', [10]))).toBe('The seller of #114 also paid the buyer directly, outside the sale.');
  });

  it('says before or after only when every payment is in a block strictly before or after the sale\'s', () => {
    // A payment in the sale's own block has no order against it: washtrace reads no place for a payment in its block.
    expect(one(pair('funder', [10]))).toBe('One wallet paid both the seller and the buyer of #114.');
    expect(one(pair('funder', [9, 10]))).toBe('One wallet paid both the seller and the buyer of #114.');
    expect(one(pair('payee', [10, 11]))).toBe('The seller and the buyer of #114 both paid one wallet.');
    // Some before, some after: neither.
    expect(one(pair('back', [9, 11]))).toBe("The buyer's money went back to the seller of #114 through one wallet.");
    expect(one(pair('direct-back', [10]))).toBe('The buyer of #114 also paid the seller directly, outside the sale.');
    // No payment read: nothing to order.
    expect(one(pair('funder', []))).toBe('One wallet paid both the seller and the buyer of #114.');
  });

  it('says an old witness with no shape as it always did, never blank or undefined', () => {
    // Today's wording, with no time word: research §4 gives an old witness what it always said.
    expect(one(pair(null, [8]))).toBe('The seller and the buyer of #114 are joined by money through one wallet.');
    expect(one(pair(null, [12], { middle: null }))).toBe('The seller and the buyer of #114 are joined by money.');
    expect(one(pair(undefined, [10]))).toBe('The seller and the buyer of #114 are joined by money through one wallet.');
    expect(one(pair(null, [], { middle: null }))).toBe('The seller and the buyer of #114 are joined by money.');
  });

  it('says a loop by its token, its wallets and its cycles', () => {
    expect(ringStory(LINE, [loop('101')])).toBe('#101 went round 2 wallets and back to one that sold it, 2 cycles.');
    expect(ringStory(LINE, [loop('102', 3, 1)])).toBe('#102 went round 3 wallets and back to one that sold it.');
    expect(ringStory(LINE, [loop('101'), loop('102', 3)])).toBe('#101 and #102 went round among these wallets.');
  });

  it('says several pairs of one shape once: one wallet only when every pair has the same middle', () => {
    const same = ['114', '115', '117'].map((token) => pair('funder', [8], { token }));
    expect(ringStory(LINE, same)).toBe('One wallet paid both the sellers and the buyers of #114, #115 and #117, each before its sale.');
    expect(ringStory(LINE, [pair('payee', [11], { token: '114' }), pair('payee', [10], { token: '115' })])).toBe('The sellers and the buyers of #114 and #115 all paid one wallet.');
    const apart = [pair('funder', [8], { token: '114' }), pair('funder', [8], { token: '115', middle: N }), pair('funder', [12], { token: '117' })];
    expect(ringStory(LINE, apart)).toBe('In each of 3 sales of #114, #115 and #117, a third wallet paid both the seller and the buyer.');
    // Four sales of one token name it once; past three tokens the rest are counted.
    expect(ringStory(LINE, Array.from({ length: 4 }, () => pair('direct-back', [12])))).toBe('In each of 4 sales of #114, the buyer paid the seller back directly, after the sale.');
    expect(ringStory(LINE, ['1', '2', '3', '4', '5'].map((token) => pair('back', [11], { token, middle: token === '1' ? N : M }))))
      .toBe("In each of 5 sales of #1, #2, #3 and 2 more, the buyer's money went back to the seller through a third wallet, after the sale.");
  });

  it('counts mixed shapes by their tails, and puts loops first', () => {
    expect(ringStory(LINE, [pair('funder', [8]), pair('funder', [8], { token: '115' }), pair('direct-back', [12], { token: '116' })]))
      .toBe('3 of its sales are linked pairs: 2 both funded by a third, 1 paid back directly.');
    // An old pair counts as it does in the lists: through a middle wallet.
    expect(ringStory(LINE, [pair('funder', [8]), pair(null, [8], { token: '115' })])).toBe('2 of its sales are linked pairs: 1 both funded by a third, 1 through a middle wallet.');
    expect(ringStory(LINE, [pair('funder', [8], { token: '103' }), loop('101'), pair('funder', [8], { token: '104' }), loop('102', 3)]))
      .toBe('#101 and #102 went round among these wallets; 2 of its sales are linked pairs, both funded by a third.');
    expect(ringStory(LINE, [loop('101'), pair('payee', [12], { token: '103' }), pair('back', [12], { token: '104' })]))
      .toBe('#101 went round 2 wallets and back to one that sold it, 2 cycles; 2 of its sales are linked pairs, 1 both paid a third, 1 paid back through a third.');
    expect(ringStory(LINE, [loop('101'), pair(null, [8], { token: '103', middle: null })])).toBe('#101 went round 2 wallets and back to one that sold it, 2 cycles; 1 of its sales is a linked pair.');
  });

  it('never tells old pairs through a middle and old direct ones as one shape', () => {
    const mixed = [pair(null, [8]), pair(null, [8], { token: '115', middle: null })];
    expect(ringStory(LINE, mixed)).toBe('2 of its sales are linked pairs: 1 through a middle wallet.');
    expect(ringStory(LINE, [loop('101'), ...mixed])).toBe('#101 went round 2 wallets and back to one that sold it, 2 cycles; 2 of its sales are linked pairs, 1 through a middle wallet.');
    // Old pairs all through a middle, or all direct, are still one.
    expect(ringStory(LINE, [pair(null, [], { middle: null }), pair(null, [], { token: '115', middle: null })])).toBe('In each of 2 sales of #114 and #115, the seller and the buyer are joined by money.');
  });

  it('says a ring not drawn by its counts alone, with no time word', () => {
    const at = (wallets: number, sales: number, loops: number, pairs: number, middles: number, some: Partial<Record<PairShape, number>> = {}) =>
      ({ wallets, sales, pattern: { loops, pairs, middles, shapes: shapes(some) } });
    expect(ringStory(at(48, 42, 12, 30, 30, { funder: 30 }), null)).toBe('12 loops and 30 linked pairs among 48 wallets, 30 both funded by a third.');
    expect(ringStory(at(30, 1, 1, 0, 0), null)).toBe('1 loop among 30 wallets.');
    expect(ringStory(at(30, 30, 0, 30, 30, { funder: 20, back: 10 }), null)).toBe('30 linked pairs among 30 wallets, 20 both funded by a third, 10 paid back through a third.');
    // A pair on a loop's sale is a pair still: the pairs are counted as stored, never taken from the sales left over.
    expect(ringStory(at(30, 12, 12, 12, 12, { payee: 12 }), null)).toBe('12 loops and 12 linked pairs among 30 wallets, 12 both paid a third.');
    expect(ringStory(at(30, 0, 0, 0, 0), null)).toBe('None of its flagged trades is a counted sale.');
    // A drawing with no counted evidence says its counts too.
    expect(ringStory(at(3, 0, 0, 0, 0), [])).toBe('None of its flagged trades is a counted sale.');
  });
});

describe('a ring\'s pattern in a few words (ringPattern)', () => {
  const at = (wallets: number, loops: number, pairs: number, middles: number, some: Partial<Record<PairShape, number>> = {}) =>
    ringPattern({ loops, pairs, middles, shapes: shapes(some) }, wallets);
  it('names one shape bare, loops by their wallets, and anything mixed by its counts', () => {
    expect(at(3, 0, 2, 2, { funder: 2 })).toBe('Both funded by a third');
    expect(at(2, 0, 1, 0, { 'direct-back': 1 })).toBe('Paid back directly');
    expect(at(3, 4, 0, 0)).toBe('Round trips among 3 wallets');
    expect(at(3, 2, 3, 3, { funder: 3 })).toBe('2 loops and 3 linked pairs');
    expect(at(5, 0, 3, 3, { funder: 2, payee: 1 })).toBe('3 linked pairs');
    expect(at(5, 1, 1, 1, { funder: 1 })).toBe('1 loop and 1 linked pair');
  });
  it('says a ring saved before shapes as it always did', () => {
    expect(at(3, 0, 2, 2)).toBe('Through a middle wallet');
    expect(at(2, 0, 2, 0)).toBe('Joined by money');
    expect(at(3, 0, 2, 1)).toBe('2 linked pairs');
  });
  it('says nothing for a ring with neither', () => {
    expect(at(3, 0, 0, 0)).toBe('');
  });
});

describe('a token\'s own story in a ring (tokenStory)', () => {
  const M = '0x' + 'c'.repeat(40);
  const pair = (shape: PairShape | null, paid: number[], middle: string | null = M): RingEvidence => ({ kind: 'pair', token: '114', shape, middle, sale: 10, paid });
  const loop = (cycles = 2): RingEvidence => ({ kind: 'loop', token: '114', wallets: 2, cycles });
  it('says one pair without naming the token or the wallet, with its time only when proved', () => {
    expect(tokenStory([pair('funder', [8, 9])])).toBe('One wallet paid both the seller and the buyer, before the sale.');
    expect(tokenStory([pair('payee', [11])])).toBe('The seller and the buyer both paid one wallet, after the sale.');
    expect(tokenStory([pair('direct-back', [8, 12], null)])).toBe('The buyer also paid the seller directly, outside the sale.');
    expect(tokenStory([pair(null, [8])])).toBe('The seller and the buyer are joined by money through one wallet.');
  });
  it('says a loop by its wallets and cycles', () => {
    expect(tokenStory([loop()])).toBe('Went round 2 wallets and back to one that sold it, 2 cycles.');
    expect(tokenStory([loop(1), loop(3)])).toBe('Went round in 2 loops.');
  });
  it('says several pairs once, and a loop with its pairs', () => {
    expect(tokenStory([pair('funder', [8]), pair('funder', [8])])).toBe('In each of 2 sales, one wallet paid both the seller and the buyer, before the sale.');
    expect(tokenStory([pair('funder', [8]), pair('direct-back', [12], null)])).toBe('2 sales are linked pairs: 1 both funded by a third, 1 paid back directly.');
    expect(tokenStory([loop(), pair('funder', [8])])).toBe('Went round 2 wallets and back to one that sold it, 2 cycles. One wallet paid both the seller and the buyer, before the sale.');
  });
  it('says nothing without evidence', () => {
    expect(tokenStory([])).toBe('');
  });
});
