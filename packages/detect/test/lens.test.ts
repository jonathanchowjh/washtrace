import { describe, expect, it } from 'vitest';
import { ZERO } from '../src/graph.js';
import { SEARCH_CAP, runLens } from '../src/lens.js';
import { COPIES, DEFAULT_RULE, type EdgeKind, type LensRule } from '../src/lens-rule.js';
import { contractsFor } from '../src/marketplaces.js';
import { analyze } from '../src/methods.js';
import { MOVE_KIND, Moves } from '../src/moves.js';
import { previewStored } from '../src/lens-thread.js';
import type { LensInput, Store } from '../src/store.js';
import type { Flow, Transfer } from '../src/types.js';
import { LAB, LAB_MIXED, MONEY, WETH, chain, flow, input, transfer, w } from './fixtures.js';

/**
 * A lens input built the way `Store.lensInput` builds one, less its SQL
 * filters by kind and floor: every flow is loaded, so these tests see the
 * engine drop what a rule leaves out on its own.
 */
function lensInputOf(
  transfers: Transfer[], flows: Flow[] = [], more: Partial<Pick<LensInput, 'contracts' | 'custodians' | 'money' | 'truncated'>> = {},
): LensInput {
  const tradeTxs: string[] = [];
  const tradeAt = new Map<string, number>();
  for (const t of transfers) if (!tradeAt.has(t.txHash)) tradeAt.set(t.txHash, tradeTxs.push(t.txHash) - 1);
  const money = more.money ?? new Set(['']);
  const moves = new Moves();
  for (const f of flows) {
    if (BigInt(f.valueWei) <= 0n || f.from === f.to || f.from === ZERO || f.to === ZERO) continue;
    const kind = f.kind === 'native' ? MOVE_KIND.eth : f.kind === 'internal' ? MOVE_KIND.internal
      : f.token !== '' && money.has(f.token) ? MOVE_KIND.weth : -1;
    if (kind < 0) continue;
    moves.add(f.from, f.to, kind, f.blockTime, f.blockNumber, Number(f.valueWei) / 1e18, tradeAt.has(f.txHash));
  }
  moves.seal();
  return { transfers, through: null, moves, contracts: new Set(), custodians: new Set(), money, truncated: new Set(), tradeTxs, ...more };
}

const a = w('a'), b = w('b'), c = w('c'), d = w('d'), x = w('x'), y = w('y'), m = w('m'), f = w('f');
const DAY = 86_400;
const T0 = 1_000_000_000;

/** A token minted to A, then sold A → B at T0. */
function sale(more: Partial<Transfer> = {}): Transfer[] {
  return [
    transfer('1', ZERO, a, { blockTime: T0 - 10 * DAY }),
    transfer('1', a, b, { marketplace: 'blur', priceWei: '1000', currency: '', blockTime: T0, ...more }),
  ];
}

/** Only ETH payments, along, closing at the seller: each test changes one field. */
function ethOnly(change: (r: LensRule) => void = () => {}): LensRule {
  const r = structuredClone(DEFAULT_RULE);
  for (const k of Object.keys(r.edges) as EdgeKind[]) r.edges[k] = { use: false, direction: 'along', max: null, minWei: null, repeats: 'each' };
  r.edges.eth = { use: true, direction: 'along', max: null, minWei: null, repeats: 'each' };
  Object.assign(r, {
    hops: { min: 0, max: 6 }, closes: 'seller', window: null, order: 'any',
    never: { marketplaces: false, over: null, addresses: [] }, judges: 'sales', minCycles: 1,
  } satisfies Partial<LensRule>);
  change(r);
  return r;
}

const run = (rule: LensRule, ts: Transfer[], flows: Flow[] = [], more: Parameters<typeof lensInputOf>[2] = {}) =>
  runLens(rule, lensInputOf(ts, flows, more));
const caught = (...args: Parameters<typeof run>) => run(...args).flags.length;
const legs = (path: { from: string; to: string; kind: string }[]) => path.map((e) => [e.from, e.to, e.kind]);

describe('Round trips copies exactly', () => {
  const keys = (fs: readonly { txHash: string; logIndex: number }[]) => fs.map((x) => `${x.txHash}:${x.logIndex}`).sort();
  const FIELDS = ['transfers', 'flagged', 'sales', 'flaggedSales', 'volumeWei', 'flaggedVolumeWei', 'wallets', 'tokens'] as const;
  const pick = (t: Record<(typeof FIELDS)[number], unknown>) => Object.fromEntries(FIELDS.map((k) => [k, t[k]]));
  const sell = { marketplace: 'seaport-1.6', priceWei: '1000000000000000000', currency: '' };
  const k = w('k');
  const others = Array.from({ length: 24 }, (_, i) => w(`c${i}`));

  // Every transfer set methods.test.ts runs analyze on, and the lab fixtures.
  const cases: [string, () => Transfer[], { custodians?: Set<string>; money?: ReadonlySet<string> }?][] = [
    ['one round trip', () => chain('1', a, b, a)],
    ['two cycles', () => chain('1', a, b, a, b)],
    ['a ring traded round twice', () => chain('1', a, b, c, a, b, c, a)],
    ['a token that only moves forward', () => chain('1', a, b, c)],
    ['one sale', () => chain('1', a, b)],
    ['an exchange and 24 customers', () => [...chain('1', a, b), ...others.flatMap((o, i) => chain(String(100 + i), o, w(`d${i}`)))]],
    ['sales and volume', () => [transfer('1', ZERO, a), transfer('1', a, b, sell), transfer('1', b, a, sell), transfer('1', a, b, sell), ...chain('2', c, x)]],
    ['missing data', () => [transfer('1', ZERO, a), transfer('1', b, c)]],
    ['two tokens', () => [...chain('1', a, b), ...chain('2', c, x)]],
    ['two pairs', () => [...chain('1', a, b), ...chain('2', c, d)]],
    ['three tokens, two washed', () => [...chain('1', a, b, a, b), ...chain('2', c, x, c, x), ...chain('3', a, c)]],
    ['custody and a sale', () => {
      const mint = transfer('1', ZERO, a), park = transfer('1', a, k), unpark = transfer('1', k, a), sold = transfer('1', a, b);
      return [sold, unpark, mint, park];
    }, { custodians: new Set([k]) }],
    ['a mint and three sales', () => [transfer('1', ZERO, a), transfer('1', a, b, sell), transfer('1', b, a, sell), transfer('1', a, b, sell)]],
    ['a self-transfer inside a loop', () => [...chain('1', a, b, a, b), transfer('1', b, b)]],
    ['LAB', () => LAB.transfers, { money: MONEY }],
    ['LAB, shuffled', () => [...LAB.transfers].reverse(), { money: MONEY }],
    ['LAB_MIXED', () => LAB_MIXED.transfers, { money: MONEY }],
  ];
  for (const [name, make, more = {}] of cases) {
    it(name, () => {
      const ts = make();
      const built = analyze(input(ts, [], more));
      const lens = runLens(structuredClone(COPIES.A.rule), lensInputOf(ts, [], more));
      expect(keys(lens.flags)).toEqual(keys(built.flags.filter((x) => x.method === 'A')));
      expect(pick(lens.totals)).toEqual(pick(built.totals.A));
      expect(lens.totals).toMatchObject({ truncated: 0, untimed: 0 });
    });
  }

  it('on random collections: gaps, self-transfers, custody and sales mixed', () => {
    // A seeded generator (mulberry32), so a failure names the seed that broke it.
    const random = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pool = [a, b, c, d, x, ZERO, k];
    let flagging = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
      // Some transfers share a transaction, as a bundle's or a round trip's in one call do.
      const ts = Array.from({ length: 4 + Math.floor(next() * 20) }, (_, i) =>
        transfer(pickOf(['1', '2', '3']), pickOf(pool), pickOf(pool), {
          ...(next() < 0.6 ? sell : {}), ...(next() < 0.3 ? { txHash: `0xbundle${seed}_${Math.floor(next() * 3)}`, logIndex: i } : {}),
        }));
      const more = { custodians: new Set([k]), money: MONEY };
      const built = analyze(input(ts, [], more));
      const lens = runLens(structuredClone(COPIES.A.rule), lensInputOf(ts, [], more));
      expect(keys(lens.flags), `seed ${seed}`).toEqual(keys(built.flags.filter((x) => x.method === 'A')));
      expect(pick(lens.totals), `seed ${seed}`).toEqual(pick(built.totals.A));
      if (lens.totals.flagged > 0) flagging += 1;
    }
    // Not a vacuous match: most of the collections have something flagged.
    expect(flagging).toBeGreaterThan(100);
  });

  it('flags LAB as its fixture says Round trips does', () => {
    const lens = runLens(structuredClone(COPIES.A.rule), lensInputOf(LAB.transfers, [], { money: MONEY }));
    expect(keys(lens.flags)).toEqual(keys(LAB.analysis.flags.filter((x) => x.method === 'A')));
    expect(pick(lens.totals)).toEqual(pick(LAB.analysis.totals.A));
  });
});

/** Review Focus 1's rule: every available money row on, either way, hops 0–6, closing at a funder, no window, no never. */
function everyMoneyRow(): LensRule {
  const r = structuredClone(DEFAULT_RULE);
  for (const k of ['eth', 'internal', 'weth'] as const) r.edges[k] = { use: true, direction: 'either', max: null, minWei: null, repeats: 'each' };
  Object.assign(r, {
    hops: { min: 0, max: 6 }, closes: 'seller-or-funder', window: null, order: 'any',
    never: { marketplaces: false, over: null, addresses: [] },
  } satisfies Partial<LensRule>);
  return r;
}

describe('an honest sale is never caught', () => {
  const seaport = w('5ea');

  it('on Seaport: native ETH in, internal ETH out, both in the sale', () => {
    const ts = sale({ marketplace: 'seaport-1.6' });
    const tx = ts[1]!.txHash;
    const legsOf = [flow(b, seaport, { txHash: tx, blockTime: T0 }), flow(seaport, a, { txHash: tx, kind: 'internal', blockTime: T0 })];
    expect(caught(everyMoneyRow(), ts, legsOf)).toBe(0);
  });

  it("on a WETH bid: the buyer's WETH straight to the seller in the sale", () => {
    const ts = sale();
    const bid = flow(b, a, { txHash: ts[1]!.txHash, kind: 'token', token: WETH, blockTime: T0 });
    expect(caught(everyMoneyRow(), ts, [bid], { money: MONEY })).toBe(0);
  });

  it('is caught once a payment from the buyer reaches the seller in another transaction', () => {
    const ts = sale({ marketplace: 'seaport-1.6' });
    const tx = ts[1]!.txHash;
    const flows = [
      flow(b, seaport, { txHash: tx, blockTime: T0 }), flow(seaport, a, { txHash: tx, kind: 'internal', blockTime: T0 }),
      flow(b, a, { blockTime: T0 + DAY }),
    ];
    const r = run(everyMoneyRow(), ts, flows);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]!).toMatchObject({ txHash: tx, logIndex: 0 });
    expect(legs(r.flags[0]!.path)).toEqual([[a, b, 'nft-token'], [b, a, 'eth']]);
    expect(r.flags[0]!.path[0]).toMatchObject({ tx, time: T0, amountWei: '1000', tokenId: '1' });
    // The payment's hash is read later, from its ends, kind and block.
    expect(r.flags[0]!.path[1]).toMatchObject({ tx: null, time: T0 + DAY });
    expect(r.moneyEdges).toEqual([{ flag: 0, edge: 1, from: b, to: a, kind: 'eth', block: flows[2]!.blockNumber }]);
    expect(r.flags[0]!.wallets).toEqual([a, b]);
  });

  it("on two sales into the same buyer's WETH offers: neither sale's payment closes the other (Ruling K)", () => {
    const ts = [
      transfer('1', ZERO, a, { blockTime: T0 - 10 * DAY }), transfer('2', ZERO, a, { blockTime: T0 - 10 * DAY }),
      transfer('1', a, b, { marketplace: 'seaport-1.6', priceWei: '1000', currency: WETH, blockTime: T0 }),
      transfer('2', a, b, { marketplace: 'seaport-1.6', priceWei: '1000', currency: WETH, blockTime: T0 + DAY }),
    ];
    const offers = [
      flow(b, a, { txHash: ts[2]!.txHash, kind: 'token', token: WETH, blockTime: T0 }),
      flow(b, a, { txHash: ts[3]!.txHash, kind: 'token', token: WETH, blockTime: T0 + DAY }),
    ];
    expect(caught(everyMoneyRow(), ts, offers, { money: MONEY })).toBe(0);
  });

  describe('when a marketplace once paid the seller and the buyer once paid it (Ruling J)', () => {
    const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
    const ts = () => sale({ marketplace: 'seaport-1.6' });
    const valueWei = '20000000000000000'; // 0.02 ETH: over DEFAULT_RULE's floor
    const flows = (tx: string) => [
      flow(b, SEAPORT, { txHash: tx, blockTime: T0, valueWei }), flow(SEAPORT, a, { txHash: tx, kind: 'internal', blockTime: T0, valueWei }),
      // The seller's earlier sale elsewhere, and the buyer's earlier purchase elsewhere.
      flow(SEAPORT, a, { kind: 'internal', blockTime: T0 - 5 * DAY, valueWei }), flow(b, SEAPORT, { blockTime: T0 - 3 * DAY, valueWei }),
    ];
    const contracts = contractsFor(1);
    const withNever = (never: LensRule['never']) => Object.assign(everyMoneyRow(), { never });
    const judge = (rule: LensRule) => { const t = ts(); return caught(rule, t, flows(t[1]!.txHash), { contracts }); };

    it('it is a funder only when never lets it be a middle', () => {
      expect(judge(withNever({ marketplaces: false, over: null, addresses: [] }))).toBe(1);
    });
    it('not with marketplaces barred', () => {
      expect(judge(withNever({ marketplaces: true, over: null, addresses: [] }))).toBe(0);
    });
    it('not when hand-listed', () => {
      expect(judge(withNever({ marketplaces: false, over: null, addresses: [SEAPORT] }))).toBe(0);
    });
    it('not past over', () => {
      expect(judge(withNever({ marketplaces: false, over: 0, addresses: [] }))).toBe(0);
    });
    it('not under DEFAULT_RULE closing at a funder', () => {
      expect(judge(Object.assign(structuredClone(DEFAULT_RULE), { closes: 'seller-or-funder' }))).toBe(0);
    });
  });

  it("in a ring of priced sales of three tokens, under DEFAULT_RULE; tokens handed on for free still close it (I4, Ruling CC)", () => {
    const priced = (tokenId: string, from: string, to: string, at: number) =>
      transfer(tokenId, from, to, { marketplace: 'blur', priceWei: '500000000000000000', currency: '', blockTime: at });
    const mints = () => ['1', '2', '3'].map((t, i) => transfer(t, ZERO, [a, b, c][i]!, { blockTime: T0 - 60 * DAY }));
    // A sells #1 to B, B sells #2 to C, C sells #3 to A: each paid a price, so no token is value handed back.
    const ring = [...mints(), priced('1', a, b, T0), priced('2', b, c, T0 + 2 * DAY), priced('3', c, a, T0 + 5 * DAY)];
    expect(caught(structuredClone(DEFAULT_RULE), ring)).toBe(0);
    const free = [...mints(), priced('1', a, b, T0), transfer('2', b, c, { blockTime: T0 + 2 * DAY }), transfer('3', c, a, { blockTime: T0 + 5 * DAY })];
    const r = run(structuredClone(DEFAULT_RULE), free);
    expect(r.flags.map((x) => legs(x.path))).toEqual([[[a, b, 'nft-token'], [b, c, 'nft-collection'], [c, a, 'nft-collection']]]);
  });

  describe("under DEFAULT_RULE, when buyer and seller use one exchange that pays many of this collection's wallets (C2, Ruling BB)", () => {
    const X = w('c0ffee');
    const eth = (n: number) => String(BigInt(Math.round(n * 100)) * 10n ** 16n);
    // The 200 others traded this collection's tokens too (a mint alone is no trade): to this collection, that is what makes X an exchange.
    const crowd = Array.from({ length: 200 }, (_, i) => w(`d${i}`));
    const ts = () => [...sale(), ...crowd.flatMap((o, i) => chain(String(100 + i), w('dea1'), o))];
    const paysCrowd = () => crowd.map((o, i) => flow(X, o, { valueWei: eth(0.5), blockTime: T0 - DAY - i }));
    const judge = (flows: Flow[], more: Parameters<typeof lensInputOf>[2] = {}) =>
      caught(structuredClone(DEFAULT_RULE), ts(), flows, { contracts: contractsFor(1), ...more });

    it('two withdrawals from it are not a way back', () => {
      const withdrawals = () => [flow(X, a, { valueWei: eth(1), blockTime: T0 - 5 * DAY }), flow(X, b, { valueWei: eth(2), blockTime: T0 - 3 * DAY })];
      expect(judge([...withdrawals(), ...paysCrowd()])).toBe(0);
      // The same two payments through a wallet linked to no one else is a loop.
      expect(judge(withdrawals())).toBe(1);
    });

    it('nor is a withdrawal by the buyer and a deposit by the seller', () => {
      const legs = () => [flow(X, b, { valueWei: eth(2), blockTime: T0 - 3 * DAY }), flow(a, X, { valueWei: eth(0.6), blockTime: T0 + 2 * DAY })];
      expect(judge([...legs(), ...paysCrowd()])).toBe(0);
      expect(judge(legs())).toBe(1);
    });

    it('a wallet whose funding history was cut short is never a middle, as the built-ins treat it', () => {
      const withdrawals = () => [flow(X, a, { valueWei: eth(1), blockTime: T0 - 5 * DAY }), flow(X, b, { valueWei: eth(2), blockTime: T0 - 3 * DAY })];
      expect(judge(withdrawals(), { truncated: new Set([X]) })).toBe(0);
      expect(judge(withdrawals(), { truncated: new Set([w('ffff')]) })).toBe(1);
    });
  });
});

describe('each rule field', () => {
  it('direction: an along row never walks an edge backwards, an either row does', () => {
    const back = () => [flow(a, b)];
    expect(caught(ethOnly(), sale(), back())).toBe(0);
    const r = run(ethOnly((r) => { r.edges.eth.direction = 'either'; }), sale(), back());
    // The edge is recorded as it happened: A paid B.
    expect(legs(r.flags[0]!.path)).toEqual([[a, b, 'nft-token'], [a, b, 'eth']]);
  });

  it("nft-collection: another token's hop closes the loop, but never one in the trade's own transaction", () => {
    const nftOther = (direction: 'along' | 'either') => ethOnly((r) => {
      r.edges.eth.use = false;
      r.edges['nft-collection'] = { use: true, direction, max: null, minWei: null, repeats: 'each' };
    });
    const r = run(nftOther('along'), [...sale(), transfer('2', b, a, { blockTime: T0 + DAY })]);
    expect(legs(r.flags[0]!.path)).toEqual([[a, b, 'nft-token'], [b, a, 'nft-collection']]);
    expect(r.flags[0]!.path[1]).toMatchObject({ tokenId: '2', time: T0 + DAY });
    expect(r.moneyEdges).toEqual([]);
    // A bundle: token 2 went A → B in the same sale. Walked backwards, it would close every bundle.
    const ts = sale();
    expect(caught(nftOther('either'), [...ts, transfer('2', a, b, { txHash: ts[1]!.txHash, logIndex: 1, blockTime: T0 })])).toBe(0);
    expect(caught(nftOther('either'), [...ts, transfer('2', a, b, { blockTime: T0 + DAY })])).toBe(1);
  });

  it('max: two ETH edges in a loop are past a max of 1', () => {
    const back = () => [flow(b, x), flow(x, a)];
    expect(caught(ethOnly((r) => { r.edges.eth.max = 1; }), sale(), back())).toBe(0);
    expect(caught(ethOnly((r) => { r.edges.eth.max = 2; }), sale(), back())).toBe(1);
  });

  it('minWei: an edge below it does not count, though the input holds it', () => {
    const back = () => [flow(b, a, { valueWei: '1000' })];
    expect(caught(ethOnly((r) => { r.edges.eth.minWei = '2000'; }), sale(), back())).toBe(0);
    expect(caught(ethOnly((r) => { r.edges.eth.minWei = '1000'; }), sale(), back())).toBe(1);
  });

  it('minWei: an edge right at it counts, though Moves holds 0.7 ETH a little under 0.7', () => {
    const seven = '700000000000000000';
    expect(Math.fround(0.7)).toBeLessThan(0.7);
    expect(caught(ethOnly((r) => { r.edges.eth.minWei = seven; }), sale(), [flow(b, a, { valueWei: seven })])).toBe(1);
  });

  it('hops: the wallets passed through, between min and max', () => {
    const twoMiddles = () => [flow(b, x), flow(x, y), flow(y, a)];
    expect(caught(ethOnly((r) => { r.hops = { min: 0, max: 1 }; }), sale(), twoMiddles())).toBe(0);
    expect(caught(ethOnly((r) => { r.hops = { min: 0, max: 2 }; }), sale(), twoMiddles())).toBe(1);
    expect(caught(ethOnly((r) => { r.hops = { min: 0, max: 6 }; }), sale(), [flow(b, a)])).toBe(1);
    expect(caught(ethOnly((r) => { r.hops = { min: 1, max: 6 }; }), sale(), [flow(b, a)])).toBe(0);
  });

  it('window: an edge counts within its days, on its side', () => {
    const late = () => [flow(b, a, { blockTime: T0 + 31 * DAY })];
    expect(caught(ethOnly((r) => { r.window = { days: 30, side: 'after' }; }), sale(), late())).toBe(0);
    expect(caught(ethOnly((r) => { r.window = { days: 31, side: 'after' }; }), sale(), late())).toBe(1);
    const early = () => [flow(b, a, { blockTime: T0 - DAY })];
    expect(caught(ethOnly((r) => { r.window = { days: 30, side: 'after' }; }), sale(), early())).toBe(0);
    expect(caught(ethOnly((r) => { r.window = { days: 30, side: 'before' }; }), sale(), early())).toBe(1);
    expect(caught(ethOnly((r) => { r.window = { days: 30, side: 'either' }; }), sale(), early())).toBe(1);
  });

  it('order: in loop order each edge is no earlier than the one before it', () => {
    const backwards = () => [flow(b, x, { blockTime: T0 + 2 * DAY }), flow(x, a, { blockTime: T0 + DAY })];
    expect(caught(ethOnly((r) => { r.order = 'loop'; }), sale(), backwards())).toBe(0);
    expect(caught(ethOnly((r) => { r.order = 'any'; }), sale(), backwards())).toBe(1);
    const forwards = () => [flow(b, x, { blockTime: T0 + DAY }), flow(x, a, { blockTime: T0 + 2 * DAY })];
    expect(caught(ethOnly((r) => { r.order = 'loop'; }), sale(), forwards())).toBe(1);
    // Starting from the trade: money paid before it is out of loop order.
    expect(caught(ethOnly((r) => { r.order = 'loop'; }), sale(), [flow(b, a, { blockTime: T0 - DAY })])).toBe(0);
  });

  it('never: a marketplace contract, a busy wallet or a listed one is never a middle', () => {
    const through = () => [flow(b, m), flow(m, a)];
    const contracts = new Set([m]);
    expect(caught(ethOnly((r) => { r.never.marketplaces = true; }), sale(), through(), { contracts })).toBe(0);
    expect(caught(ethOnly((r) => { r.never.marketplaces = false; }), sale(), through(), { contracts })).toBe(1);

    // M is linked by money to three of this collection's wallets, B, A and X, however many payments: Y holds none of its tokens,
    // and the payment inside one of its sales (Ruling K) links no one.
    const judged = (over: number) => {
      const ts = [...sale(), ...chain('9', m, x), ...chain('8', c, d)];
      const flows = [...through(), flow(m, x), flow(m, x), flow(x, m), flow(y, m), flow(m, c, { txHash: ts.at(-1)!.txHash })];
      return caught(ethOnly((r) => { r.never.over = over; }), ts, flows);
    };
    expect(judged(2)).toBe(0);
    expect(judged(3)).toBe(1);

    expect(caught(ethOnly((r) => { r.never.addresses = [m]; }), sale(), through())).toBe(0);
  });

  it('never: the seller and the buyer are never checked', () => {
    const rule = ethOnly((r) => { r.never = { marketplaces: true, over: 0, addresses: [a, b] }; });
    expect(caught(rule, sale(), [flow(b, a)], { contracts: new Set([a, b]) })).toBe(1);
  });

  it("judges: 'sales' skips a change of owner that is not a sale, 'owners' judges it", () => {
    const gift = () => [transfer('1', ZERO, a, { blockTime: T0 - DAY }), transfer('1', a, b, { blockTime: T0 })];
    expect(caught(ethOnly((r) => { r.judges = 'sales'; }), gift(), [flow(b, a)])).toBe(0);
    expect(caught(ethOnly((r) => { r.judges = 'owners'; }), gift(), [flow(b, a)])).toBe(1);
  });

  it('minCycles: one lap is one loop; a second A → B makes two only when repeats count each', () => {
    const nftOnly = (cycles: number, repeats: 'each' | 'once') => {
      const r = structuredClone(COPIES.A.rule);
      r.edges['nft-token'].repeats = repeats;
      r.minCycles = cycles;
      return r;
    };
    expect(caught(nftOnly(1, 'each'), chain('1', a, b, a))).toBe(2);
    expect(caught(nftOnly(2, 'each'), chain('1', a, b, a))).toBe(0);
    expect(caught(nftOnly(2, 'each'), chain('1', a, b, a, b))).toBe(3);
    expect(caught(nftOnly(2, 'once'), chain('1', a, b, a, b))).toBe(0);
  });

  it('minCycles counts the loop found with the money that closes it', () => {
    // One lap of the token and B paying A back: two loops among A and B.
    const rule = ethOnly((r) => {
      r.edges['nft-token'] = { use: true, direction: 'along', max: null, minWei: null, repeats: 'each' };
      r.judges = 'owners';
      r.minCycles = 2;
    });
    expect(caught(rule, chain('1', a, b), [flow(b, a)])).toBe(0);
    expect(caught(rule, chain('1', a, b, a), [flow(b, a)])).toBeGreaterThan(0);
  });

  describe('closes at a funder (D12)', () => {
    // At most one ETH edge back, so B → F → A by ETH alone is not a loop: only F's funding of A can close it.
    const oneEth = (closes: LensRule['closes']) => ethOnly((r) => { r.edges.eth.max = 1; r.closes = closes; });

    it('closes at a wallet that paid the seller before the trade', () => {
      const flows = [flow(f, a, { blockTime: T0 - DAY }), flow(b, f, { blockTime: T0 + DAY })];
      expect(caught(oneEth('seller'), sale(), flows)).toBe(0);
      const r = run(oneEth('seller-or-funder'), sale(), flows);
      expect(r.flags).toHaveLength(1);
      expect(legs(r.flags[0]!.path)).toEqual([[a, b, 'nft-token'], [b, f, 'eth'], [f, a, 'funds']]);
      expect(r.flags[0]!.wallets).toEqual([a, b, f]);
      expect(r.moneyEdges.map((e) => [e.edge, e.from, e.to, e.kind])).toEqual([[1, b, f, 'eth'], [2, f, a, 'eth']]);
    });

    it('does not count a payment to the seller after the trade', () => {
      const flows = [flow(f, a, { blockTime: T0 + 2 * DAY }), flow(b, f, { blockTime: T0 + DAY })];
      expect(caught(oneEth('seller-or-funder'), sale(), flows)).toBe(0);
    });

    describe('the buyer is a funder too, with no wallet between (Ruling MM)', () => {
      // Loop order, so a payment before the trade is no way back: only the buyer's funding of the seller can close it.
      const inOrder = (change: (r: LensRule) => void = () => {}) => ethOnly((r) => { r.order = 'loop'; r.closes = 'seller-or-funder'; change(r); });
      const paidFirst = () => [flow(b, a, { blockTime: T0 - DAY })];

      it('closes a trade whose buyer paid the seller before it, as funds B -> A', () => {
        expect(caught(ethOnly((r) => { r.order = 'loop'; }), sale(), paidFirst())).toBe(0);
        const flows = paidFirst();
        const r = run(inOrder(), sale(), flows);
        expect(r.flags).toHaveLength(1);
        expect(legs(r.flags[0]!.path)).toEqual([[a, b, 'nft-token'], [b, a, 'funds']]);
        expect(r.flags[0]!.path[1]).toMatchObject({ tx: null, time: T0 - DAY, amountWei: null, tokenId: null });
        expect(r.flags[0]!.wallets).toEqual([a, b]);
        expect(r.moneyEdges).toEqual([{ flag: 0, edge: 1, from: b, to: a, kind: 'eth', block: flows[0]!.blockNumber }]);
      });

      it('needs hops.min 0: it passes no wallet', () => {
        expect(caught(inOrder((r) => { r.hops = { min: 1, max: 6 }; }), sale(), paidFirst())).toBe(0);
      });

      it("not by a payment inside one of this collection's transactions (Ruling K)", () => {
        const ts = sale();
        // The mint's transaction: no sale, but it moves one of the collection's tokens.
        expect(caught(inOrder(), ts, [flow(b, a, { blockTime: T0 - DAY, txHash: ts[0]!.txHash })])).toBe(0);
        expect(caught(inOrder(), ts, [flow(b, a, { blockTime: T0 - DAY, txHash: ts[1]!.txHash })])).toBe(0);
      });

      it('not by a payment after the trade or at it, nor one outside the window, nor of a kind the rule has off', () => {
        // No ETH edge may be walked, so only the funding can close it: the funding edge counts against no row's max.
        const funding = (change: (r: LensRule) => void = () => {}) => inOrder((r) => { r.edges.eth.max = 0; change(r); });
        expect(caught(funding(), sale(), paidFirst())).toBe(1);
        expect(caught(funding(), sale(), [flow(b, a, { blockTime: T0 + DAY })])).toBe(0);
        expect(caught(funding(), sale(), [flow(b, a, { blockTime: T0 })])).toBe(0);
        expect(caught(funding((r) => { r.window = { days: 1, side: 'before' }; }), sale(), [flow(b, a, { blockTime: T0 - 2 * DAY })])).toBe(0);
        expect(caught(funding((r) => { r.window = { days: 3, side: 'before' }; }), sale(), [flow(b, a, { blockTime: T0 - 2 * DAY })])).toBe(1);
        expect(caught(funding((r) => { r.window = { days: 30, side: 'after' }; }), sale(), paidFirst())).toBe(0);
        expect(caught(funding(), sale(), [flow(b, a, { blockTime: T0 - DAY, kind: 'internal' })])).toBe(0);
      });

      it('under minCycles 2 the funding alone is one loop, so it is refused and the search goes on', () => {
        // X handed A the token before the sale, so A -> B -> X -> A by money after it makes two loops with the token's own X -> A.
        const ts = [transfer('1', ZERO, x, { blockTime: T0 - 20 * DAY }), transfer('1', x, a, { blockTime: T0 - 5 * DAY }), ...sale().slice(1)];
        const twoLoops = (cycles: number) => inOrder((r) => {
          r.edges['nft-token'] = { use: true, direction: 'along', max: null, minWei: null, repeats: 'each' };
          r.minCycles = cycles;
        });
        const back = () => [flow(b, x, { blockTime: T0 + DAY }), flow(x, a, { blockTime: T0 + 2 * DAY })];
        // With one loop enough, the buyer's funding closes it at once.
        expect(run(twoLoops(1), ts, paidFirst()).flags.map((f) => legs(f.path))).toEqual([[[a, b, 'nft-token'], [b, a, 'funds']]]);
        // With two needed it is refused; with no way back for the search, nothing is caught.
        expect(caught(twoLoops(2), ts, paidFirst())).toBe(0);
        // The search then finds the way back through X, which makes the two loops.
        const r = run(twoLoops(2), ts, [...paidFirst(), ...back()]);
        expect(r.flags.map((f) => legs(f.path))).toEqual([[[a, b, 'nft-token'], [b, x, 'eth'], [x, a, 'eth']]]);
      });

      it('never as a middle would: the buyer is not checked against never (Ruling J)', () => {
        const barred = inOrder((r) => { r.never = { marketplaces: true, over: 0, addresses: [b] }; });
        expect(caught(barred, sale(), paidFirst(), { contracts: new Set([b]) })).toBe(1);
      });
    });
  });
});

describe('who funded the seller (D12), read through runLens', () => {
  // A third transfer: another sale of this collection, by another seller, in a transaction of its own.
  const ts = [...sale(), transfer('7', c, d, { marketplace: 'blur', blockTime: T0 - 2 * DAY })];
  const candidates = [f, ...['f1', 'f2', 'f3', 'f4'].map(w)];
  /**
   * The wallets among `candidates` that close the trade as its seller's
   * funder: each is given one ETH edge from the buyer, inside any window, and
   * the rule allows one ETH edge, so only its funding of A can close the loop.
   */
  const funders = (flows: Flow[], change: (r: LensRule) => void = () => {}) => {
    const rule = ethOnly((r) => { r.edges.eth.max = 1; r.closes = 'seller-or-funder'; change(r); });
    const at = rule.window?.side === 'after' ? T0 + DAY / 2 : T0 - DAY / 2;
    return candidates.filter((v) => {
      const r = run(rule, ts, [...flows, flow(b, v, { blockTime: at })]);
      return r.flags.some((x) => x.path.at(-1)?.kind === 'funds' && x.path.at(-1)?.from === v);
    }).sort();
  };

  it('is the wallets that paid the seller, by an enabled kind, before the trade', () => {
    expect(funders([flow(f, a, { blockTime: T0 - DAY })])).toEqual([f]);
    expect(funders([flow(f, a, { blockTime: T0 + DAY })])).toEqual([]);
    expect(funders([flow(f, a, { blockTime: T0 })])).toEqual([]);
    expect(funders([flow(f, a, { blockTime: T0 - DAY, kind: 'internal' })])).toEqual([]);
    expect(funders([flow(f, a, { blockTime: T0 - DAY, valueWei: '10' })], (r) => { r.edges.eth.minWei = '11'; })).toEqual([]);
  });

  it("never counts a payment in the trade's own transaction, nor in any other of this collection's sales (Ruling K)", () => {
    expect(funders([flow(f, a, { blockTime: T0 - DAY, txHash: ts[1]!.txHash })])).toEqual([]);
    expect(funders([flow(f, a, { blockTime: T0 - DAY, txHash: ts[2]!.txHash })])).toEqual([]);
  });

  it('reads only the payments inside the window, among many', () => {
    const [f1, f2, f3, f4] = ['f1', 'f2', 'f3', 'f4'].map(w) as [string, string, string, string];
    const many = [
      flow(f1, a, { blockTime: T0 - 31 * DAY }), flow(f2, a, { blockTime: T0 - 30 * DAY }), flow(f3, a, { blockTime: T0 - DAY }),
      flow(f4, a, { blockTime: T0 + DAY }), flow(f1, a, { blockTime: T0 - 50 * DAY }), flow(f3, a, { blockTime: T0 - 2 * DAY }),
    ];
    expect(funders(many, (r) => { r.window = { days: 30, side: 'before' }; })).toEqual([f2, f3].sort());
    expect(funders(many)).toEqual([f1, f2, f3].sort());
  });

  it("keeps to the window's before side", () => {
    const old = [flow(f, a, { blockTime: T0 - 40 * DAY })];
    expect(funders(old, (r) => { r.window = { days: 30, side: 'either' }; })).toEqual([]);
    expect(funders(old, (r) => { r.window = { days: 40, side: 'before' }; })).toEqual([f]);
    expect(funders([flow(f, a, { blockTime: T0 - DAY })], (r) => { r.window = { days: 30, side: 'after' }; })).toEqual([]);
  });
});

describe('the search cap', () => {
  it(`stops after ${SEARCH_CAP} edges read, counts the search truncated and catches nothing`, () => {
    const xs = Array.from({ length: 200 }, (_, i) => w(`x${i}`));
    const flows = [flow(b, xs[0]!)];
    for (const p of xs) for (const q of xs) if (p !== q) flows.push(flow(p, q));
    const r = run(ethOnly(), sale(), flows);
    expect(r.flags).toEqual([]);
    expect(r.totals.truncated).toBe(1);
  });

  it('counts every edge it examines, so a wide middle cannot run on uncounted (Ruling L)', () => {
    // 100 middles of 100 dead ends each: 100 wallets reached, but 10,100 edges read.
    const xs = Array.from({ length: 100 }, (_, i) => w(`x${i}`));
    const flows = xs.flatMap((p, i) => [flow(b, p), ...Array.from({ length: 100 }, (_, j) => flow(p, w(`z${i}_${j}`)))]);
    const r = run(ethOnly((r) => { r.hops = { min: 0, max: 1 }; }), sale(), flows);
    expect(r.flags).toEqual([]);
    expect(r.totals.truncated).toBe(1);
  });

  it('does not count a search that found its loop before the cap as truncated', () => {
    const xs = Array.from({ length: 200 }, (_, i) => w(`x${i}`));
    // The way back is the buyer's earliest payment, so it is found first.
    const flows = [flow(b, a, { blockTime: 1 }), flow(b, xs[0]!, { blockTime: 2 })];
    for (const p of xs) for (const q of xs) if (p !== q) flows.push(flow(p, q, { blockTime: 3 }));
    const r = run(ethOnly(), sale(), flows);
    expect(r.flags).toHaveLength(1);
    expect(r.totals.truncated).toBe(0);
  });
});

describe('"any" length: the token\'s own hops, breadth first', () => {
  const nftAny = (change: (r: LensRule) => void) => {
    const r = structuredClone(COPIES.A.rule);
    r.minCycles = 1;
    change(r);
    return r;
  };
  const hop = (from: string, to: string, time: number | null) => transfer('1', from, to, { blockTime: time });
  const tradeOf = (r: ReturnType<typeof run>, t: Transfer) => r.flags.find((x) => x.txHash === t.txHash);

  it('either way: a hop walked against its arrow closes what the arrows cannot inside the window', () => {
    // C → A twice, both far outside the window; A → C inside it, which read backwards is C → A.
    const ts = [hop(a, c, T0 - DAY), hop(c, a, T0 - 100 * DAY), hop(a, b, T0), hop(b, c, T0 + DAY), hop(c, a, T0 + 100 * DAY)];
    const window = { days: 30, side: 'either' } as const;
    expect(tradeOf(run(nftAny((r) => { r.window = window; }), ts), ts[2]!)).toBeUndefined();
    const r = run(nftAny((r) => { r.window = window; r.edges['nft-token'].direction = 'either'; }), ts);
    expect(legs(tradeOf(r, ts[2]!)!.path)).toEqual([[a, b, 'nft-token'], [b, c, 'nft-token'], [a, c, 'nft-token']]);
  });

  it('a window passes no bridge and no untimed hop', () => {
    const windowed = nftAny((r) => { r.window = { days: 30, side: 'either' }; });
    // A → B, then A → C: the bridge B → A is the only way back.
    const bridged = [hop(a, b, T0), hop(a, c, T0 + DAY)];
    expect(caught(windowed, bridged)).toBe(0);
    expect(caught(nftAny(() => {}), bridged)).toBe(1);
    const untimed = [hop(a, b, T0), hop(b, a, null)];
    expect(tradeOf(run(windowed, untimed), untimed[0]!)).toBeUndefined();
    const timed = [hop(a, b, T0), hop(b, a, T0 + DAY)];
    expect(tradeOf(run(windowed, timed), timed[0]!)).toBeDefined();
  });

  it('loop order: a wallet reached again earlier, by a longer way, is searched again from there', () => {
    // B → X late; B → Y → X early. Only the early arrival at X can take X → A in order.
    const ts = [hop(a, b, T0), hop(b, x, T0 + 10 * DAY), hop(b, y, T0 + DAY), hop(y, x, T0 + 2 * DAY), hop(x, a, T0 + 5 * DAY)];
    const r = run(nftAny((r) => { r.order = 'loop'; }), ts);
    expect(legs(tradeOf(r, ts[0]!)!.path)).toEqual([[a, b, 'nft-token'], [b, y, 'nft-token'], [y, x, 'nft-token'], [x, a, 'nft-token']]);
    // Any order: the shortest way, through the late hop.
    const any = run(nftAny(() => {}), ts);
    expect(legs(tradeOf(any, ts[0]!)!.path)).toEqual([[a, b, 'nft-token'], [b, x, 'nft-token'], [x, a, 'nft-token']]);
  });

  it("the row's max is how deep it goes", () => {
    const ring = () => chain('1', a, b, c, a);
    expect(caught(nftAny((r) => { r.edges['nft-token'].max = 1; }), ring())).toBe(0);
    expect(caught(nftAny((r) => { r.edges['nft-token'].max = 2; }), ring())).toBe(3);
  });
});

describe('totals', () => {
  it('counts a trade with no block time under a windowed rule as untimed, never caught', () => {
    const rule = ethOnly((r) => { r.window = { days: 30, side: 'either' }; });
    const r = run(rule, sale({ blockTime: null }), [flow(b, a)]);
    expect(r.flags).toEqual([]);
    expect(r.totals.untimed).toBe(1);
    // Without a window, it is judged.
    expect(run(ethOnly(), sale({ blockTime: null }), [flow(b, a)]).totals).toMatchObject({ flagged: 1, untimed: 0 });
  });

  it('only judges the sampled trades and counts only them', () => {
    // Three priced sales, each closed by the buyer paying the seller back; a free hand-on between them.
    const t1 = sale();
    const t2 = [transfer('2', ZERO, c, { blockTime: T0 - DAY }), transfer('2', c, d, { marketplace: 'blur', priceWei: '2000', currency: '', blockTime: T0 })];
    const t3 = [transfer('3', ZERO, x, { blockTime: T0 - DAY }), transfer('3', x, y, { marketplace: 'blur', priceWei: '4000', currency: '', blockTime: T0 }), transfer('3', y, m, { blockTime: T0 + 1 })];
    const ts = [...t1, ...t2, ...t3];
    const flows = [flow(b, a), flow(d, c), flow(m, y)];
    const key = (t: Transfer) => `${t.txHash}:${t.logIndex}`;
    const all = run(ethOnly(), ts, flows);
    expect(all.flags).toHaveLength(2);
    expect(all.totals).toMatchObject({ transfers: 4, sales: 3, flaggedSales: 2 });
    // The sample: the first sale, caught, and the third, not; the second is never judged.
    const only = new Set([key(t1[1]!), key(t3[1]!)]);
    const shares: number[] = [];
    const some = runLens(ethOnly(), lensInputOf(ts, flows), (s) => shares.push(s), only);
    expect(some.flags.map((f) => `${f.txHash}:${f.logIndex}`)).toEqual([key(t1[1]!)]);
    expect(some.totals).toMatchObject({ transfers: 2, flagged: 1, sales: 2, flaggedSales: 1, volumeWei: '5000', flaggedVolumeWei: '1000', wallets: 2, tokens: 1, truncated: 0, untimed: 0 });
    expect(shares.at(-1)).toBe(1);
    // Judging every change of owner, a hand-on outside the sample is still not judged: y → m closes by m's payment, but is not in it.
    const owners = runLens(ethOnly((r) => { r.judges = 'owners'; }), lensInputOf(ts, flows), undefined, only);
    expect(owners.flags.map((f) => `${f.txHash}:${f.logIndex}`)).toEqual([key(t1[1]!)]);
    expect(owners.totals.transfers).toBe(2);
    // An empty sample judges nothing.
    expect(runLens(ethOnly(), lensInputOf(ts, flows), undefined, new Set()).totals).toMatchObject({ transfers: 0, sales: 0, flagged: 0 });
  });

  it('reports progress in non-decreasing shares, ending at 1', () => {
    const ts = Array.from({ length: 150 }, (_, i) => transfer(String(i), a, b, { marketplace: 'blur', priceWei: '1', currency: '' }));
    const shares: number[] = [];
    runLens(ethOnly(), lensInputOf(ts), (s) => shares.push(s));
    expect(shares.length).toBeGreaterThan(1);
    expect(shares).toEqual([...shares].sort((p, q) => p - q));
    expect(shares.at(-1)).toBe(1);
  });
});

describe('judged, the sampled sales the lens actually judged', () => {
  const k = w('k');
  const sell = { marketplace: 'blur', priceWei: '1000', currency: '', blockTime: T0 };
  /** Three sales of one token, the last into a custodian, which the token graph folds away. */
  const sales = () => {
    const first = transfer('1', a, b, sell), second = transfer('1', b, c, sell), custody = transfer('1', c, k, sell);
    return { first, second, custody, all: [transfer('1', ZERO, a), first, second, custody] };
  };
  const keyOf = (t: Transfer) => `${t.txHash}:${t.logIndex}`;

  it('judged leaves out a sampled sale the token graph folds away, such as a sale into a custodian', () => {
    const { first, second, custody, all } = sales();
    const only = new Set([first, second, custody].map(keyOf));
    const ran = runLens(ethOnly(), lensInputOf(all, [], { custodians: new Set([k]) }), undefined, only);
    expect(only.size).toBe(3);
    expect(ran.judged).toBe(2);
    expect(ran.hops).toBe(2);
  });

  it('judged leaves out a sampled sale an untimed trade cannot be judged under a window, and counts it with none', () => {
    const untimed = transfer('1', a, b, { ...sell, blockTime: null });
    const all = [transfer('1', ZERO, a), untimed];
    const only = new Set([keyOf(untimed)]);
    expect(runLens(ethOnly((r) => { r.window = { days: 3, side: 'either' }; }), lensInputOf(all), undefined, only).judged).toBe(0);
    // Round trips has no window, so it still judges that sale: it has a hop.
    expect(runLens(ethOnly((r) => { r.window = { days: 3, side: 'either' }; }), lensInputOf(all), undefined, only).hops).toBe(1);
    expect(runLens(ethOnly(), lensInputOf(all), undefined, only).judged).toBe(1);
  });

  it('a preview carries it, and Round trips caught is counted of the sample as drawn', async () => {
    const { first, second, custody, all } = sales();
    const keys = [first, second, custody].map(keyOf);
    const store = {
      previewSample: async () => keys,
      lensInput: async () => lensInputOf(all, [], { custodians: new Set([k]) }),
      roundTripsCaught: async () => 0,
    } as unknown as Store;
    const result = await previewStored(store, { storeUrl: '', previewId: 1, collectionId: 1, chainId: 1, rule: ethOnly(), through: null });
    expect(result).toMatchObject({ sampled: 3, judged: 2, hops: 2 });
  });

  it('an untimed sale is out of the preview\'s base, so its atLeast is not a floor for it, as the line Preview shows reads', async () => {
    const untimed = transfer('1', a, b, { ...sell, blockTime: null });
    const store = {
      previewSample: async () => [keyOf(untimed)],
      lensInput: async () => lensInputOf([transfer('1', ZERO, a), untimed]),
      roundTripsCaught: async () => 0,
    } as unknown as Store;
    const result = await previewStored(store, { storeUrl: '', previewId: 1, collectionId: 1, chainId: 1, rule: ethOnly((r) => { r.window = { days: 3, side: 'either' }; }), through: null });
    expect(result).toMatchObject({ judged: 0, hops: 1, untimed: 1, truncated: 0, atLeast: false });
  });
});
