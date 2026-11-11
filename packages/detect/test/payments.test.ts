import { describe, expect, it } from 'vitest';
import { analyze } from '../src/methods.js';
import { Payments, evidenceLegs, evidencePayments, useOf } from '../src/payments.js';
import { ZERO } from '../src/graph.js';
import { chain, flow, input, w } from './fixtures.js';

const a = w('a'), b = w('b'), c = w('c'), x = w('x');

/** mulberry32: a seeded PRNG, so a failure names the seed that broke it. */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('Payments', () => {
  it('numbers each wallet once, in the order first seen', () => {
    const p = new Payments();
    p.add(b, a, '0x1');
    p.add(a, c, '0x2');
    p.add(c, b, '0x3');
    p.add(b, a, '0x4');
    expect(p.size).toBe(4);
    expect(p.names).toEqual([b, a, c]);
    expect([p.number(a), p.number(b), p.number(c), p.number(x)]).toEqual([1, 0, 2, undefined]);
    expect([...p.ends]).toEqual([0, 1, 1, 2, 2, 0, 0, 1]);
    expect([0, 1, 2, 3].map((i) => p.tx(i))).toEqual(['0x1', '0x2', '0x3', '0x4']);
  });

  it('grows past its first capacity', () => {
    const p = new Payments();
    for (let i = 0; i < 5000; i++) p.add(w(`f${i}`), w(`t${i % 7}`), `0x${i}`);
    expect(p.size).toBe(5000);
    expect(p.names).toHaveLength(5007);
    expect(p.tx(4999)).toBe('0x4999');
    expect(p.names[p.ends[2 * 4999 + 1]!]).toBe(w('t1'));
  });

  it('from() drops sale legs, self-payments, zero values and mint or burn legs', () => {
    const ts = chain('1', a, b);
    const flows = [
      flow(b, a, { txHash: ts[1]!.txHash, kind: 'token' }),
      flow(a, a),
      flow(a, b, { valueWei: '0' }),
      flow(ZERO, a),
      flow(b, ZERO),
      flow(x, c, { txHash: '0xkept' }),
    ];
    const p = Payments.from(flows, ts);
    expect(p.size).toBe(1);
    expect(p.names).toEqual([x, c]);
    expect(p.tx(0)).toBe('0xkept');
  });
});

describe('an analysis over Payments', () => {
  it('keeps the smallest tx of a pair across both directions', () => {
    const ts = chain('1', a, b);
    const witness = (p: Payments) => analyze({ ...input(ts), payments: p }).flags.find((f) => f.method === 'AC')!.witness;
    const orders: [string, string, string][][] = [[[a, b, '0x2'], [b, a, '0x1']], [[b, a, '0x2'], [a, b, '0x1']], [[a, b, '0x1'], [b, a, '0x2']]];
    for (const [first, second] of orders) {
      const p = new Payments();
      p.add(...first!);
      p.add(...second!);
      expect(witness(p)).toEqual({ kind: 'pair', pair: [a, b], middle: null, flowTx: '0x1', shape: 'both' });
    }
    // Through a middle: the tx is the one joining it to the side with fewer neighbours, smallest either way.
    const p = new Payments();
    p.add(x, a, '0x9');
    p.add(a, x, '0x3');
    p.add(x, b, '0x5');
    p.add(b, c, '0x7');
    expect(witness(p)).toEqual({ kind: 'pair', pair: [a, b], middle: x, flowTx: '0x3', shape: 'forward' });
  });

  it('an analysis of payments added in any order is deep-equal', () => {
    const next = random(42);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    const wallets = Array.from({ length: 40 }, (_, i) => w(`m${i}`));
    const ts = Array.from({ length: 30 }, (_, i) => chain(String(i), ...Array.from({ length: 2 + Math.floor(next() * 4) }, () => pick(wallets)))).flat();
    const pays: [string, string, string][] = [];
    while (pays.length < 200) {
      const from = pick(wallets), to = pick(wallets);
      // Hashes from a small pool, so a pair is joined by several and two pairs can share one.
      if (from !== to) pays.push([from, to, `0xflow${Math.floor(next() * 120)}`]);
    }
    const run = (order: readonly [string, string, string][]) => {
      const p = new Payments();
      for (const [from, to, tx] of order) p.add(from, to, tx);
      return analyze({ ...input(ts), payments: p, rules: { visitCap: 6, hubDegree: 8 } });
    };
    const want = run(pays);
    expect(want.truncatedSearches).toBeGreaterThan(0);
    expect(want.totals.AU.flagged).toBeGreaterThan(want.totals.A.flagged);
    expect(want.flags.some((f) => f.witness.kind === 'pair' && f.witness.middle !== null)).toBe(true);
    for (let i = 0; i < 20; i++) expect(run(shuffled(pays, next)), `order ${i}`).toEqual(want);
  });

  it('a pair paid both ways keeps both directions for reach', () => {
    // The pair b, x is kept as x → b (0x1, the smaller hash), but the way back from b to a runs b → x → a.
    const sale = chain('1', a, b);
    const run = (withBack: boolean) => {
      const p = new Payments();
      p.add(b, x, '0x9');
      if (withBack) p.add(x, b, '0x1');
      p.add(x, a, '0x5');
      return analyze({ ...input(sale), payments: p });
    };
    const without = run(false);
    expect(without.totals.AU.flagged).toBe(1);
    expect(run(true)).toEqual(without);
  });

  it('an empty Payments analyses as no flows did', () => {
    const ts = [...chain('1', a, b, a, b), ...chain('2', c, x)];
    const empty = analyze({ ...input(ts), payments: new Payments() });
    expect(empty).toEqual(analyze(input(ts, [])));
    expect(empty).toEqual(analyze(input(ts, [flow(a, a), flow(ZERO, c)])));
    expect(empty.truncatedSearches).toBe(0);
    expect([empty.totals.A.flagged, empty.totals.AU.flagged, empty.totals.AC.flagged]).toEqual([3, 3, 3]);
  });
});

describe('evidencePayments', () => {
  const pair = (seller: string, buyer: string, middle: string | null) => ({ AC: { kind: 'pair' as const, pair: [seller, buyer] as [string, string], middle, flowTx: '0x1', shape: 'funder' as const } });
  const sale = (more: object = {}) => ({ ...chain('1', a, b)[1]!, flags: pair(a, b, c), ...more });

  it('keeps a funder\'s two legs', () => {
    const legs = [flow(c, a), flow(c, b)];
    expect(evidencePayments([...legs, flow(a, x)], [sale()])).toEqual(legs);
  });

  it('drops the price leg of a WETH-bid sale, which pays seller from buyer in the sale\'s own transaction', () => {
    const t = sale({ flags: pair(a, b, null) });
    const price = flow(b, a, { txHash: t.txHash });
    const real = flow(b, a);
    expect(evidencePayments([price, real], [t])).toEqual([real]);
  });

  it('keeps zero values and self-payments out, as the engine does', () => {
    expect(evidencePayments([flow(c, a, { valueWei: '0' }), flow(c, c)], [sale()])).toEqual([]);
  });

  it('keeps a pair with no stored shape legs too', () => {
    const old = { ...chain('1', a, b)[1]!, flags: { AC: { kind: 'pair' as const, pair: [a, b] as [string, string], middle: c, flowTx: '0x1' } } };
    const legs = [flow(c, a), flow(b, c)];
    expect(evidencePayments(legs, [old])).toEqual(legs);
  });

  it('keeps the payment back that closes a Money loops back loop, and not another among its wallets', () => {
    const loop = { ...chain('1', a, b)[1]!, flags: { AU: { kind: 'scc+flow' as const, wallets: [a, b], cycles: 1, via: [[b, a]] as [string, string][] } } };
    const back = flow(b, a), other = flow(a, b);
    expect(evidencePayments([other, back], [loop])).toEqual([back]);
    expect(evidencePayments([flow(b, a, { valueWei: '0' })], [loop])).toEqual([]);
  });

  it('keeps each step of a Money loops back path, and no other payment among its wallets', () => {
    const sale = chain('1', a, b)[1]!;
    const loop = { ...sale, flags: { AU: { kind: 'scc+flow' as const, wallets: [a, b], cycles: 1, via: [[b, a]] as [string, string][],
      paths: [{ wallets: [b, x, a], txs: ['0x1', '0x2'] }] } } };
    const steps = [flow(b, x), flow(x, a)];
    expect(evidencePayments([flow(a, x), ...steps, flow(x, b), flow(x, a, { txHash: sale.txHash }), flow(x, a, { valueWei: '0' })], [loop])).toEqual(steps);
  });

  it('keeps a direct payment back for every money edge, past the four with paths', () => {
    const [h0, h1, h2, h3, h4, h5] = [w('h0'), w('h1'), w('h2'), w('h3'), w('h4'), w('h5')];
    const via: [string, string][] = [[h1, h0], [h2, h1], [h3, h2], [h4, h3], [h5, h4]];
    const loop = { ...chain('1', h0, h1)[1]!, flags: { AU: { kind: 'scc+flow' as const, wallets: [h0, h1, h2, h3, h4, h5], cycles: 1, via,
      paths: via.slice(0, 4).map(([from, to]) => ({ wallets: [from, to], txs: ['0x1'] })) } } };
    const backs = via.map(([from, to]) => flow(from, to));
    expect(evidencePayments(backs, [loop])).toEqual(backs);
  });

  it('draws no money for a ring of loops alone', () => {
    const loop = { ...chain('1', a, b)[1]!, flags: { A: { kind: 'scc' as const, wallets: [a, b], cycles: 2 } } };
    expect(evidencePayments([flow(a, b), flow(b, a), flow(c, a)], [loop])).toEqual([]);
  });
});

describe('evidenceLegs', () => {
  it('names each leg a lens may use once, the way evidencePayments keeps them: a pair either way, a loop’s way back and its path’s steps one way', () => {
    const [s1, s2] = chain('1', a, b).slice(1, 3);
    const pair = { ...s1!, flags: { AC: { kind: 'pair' as const, pair: [a, b] as [string, string], middle: c, flowTx: '0x1' } } };
    const loop = { ...s2!, flags: {
      A: { kind: 'scc' as const, wallets: [a, b], cycles: 2 },
      AU: { kind: 'scc+flow' as const, wallets: [a, b], cycles: 1, via: [[b, a]] as [string, string][], paths: [{ wallets: [b, x, a], txs: ['0x2', '0x3'] }] },
    } };
    const legs = evidenceLegs([pair, loop, pair]);
    expect(legs.map(([f, t]) => `${f}>${t}`).sort()).toEqual([`${a}>${c}`, `${c}>${a}`, `${b}>${c}`, `${c}>${b}`, `${b}>${a}`, `${b}>${x}`, `${x}>${a}`].sort());
    // Every payment along them that may be evidence is kept, and none off them.
    const along = legs.map(([f, t]) => flow(f, t));
    expect(evidencePayments([...along, flow(a, b), flow(x, b)], [pair, loop])).toEqual(along);
    // Round trips names none.
    expect(evidenceLegs([{ ...s1!, flags: { A: { kind: 'scc' as const, wallets: [a, b], cycles: 2 } } }])).toEqual([]);
  });
});

describe('useOf', () => {
  const pair = (middle: string | null, flowTx = '0x1') => ({ kind: 'pair' as const, pair: [a, b] as [string, string], middle, flowTx, shape: 'funder' as const });
  const loop = (more: object = {}) => ({ kind: 'scc+flow' as const, wallets: [a, b], cycles: 1, via: [[b, a]] as [string, string][], ...more });

  it('says Linked wallets uses every leg of its pair, and which one it names', () => {
    expect(useOf(pair(c), flow(c, a, { txHash: '0x1' }))).toEqual({ method: 'AC', named: true });
    expect(useOf(pair(c), flow(c, b, { txHash: '0x2' }))).toEqual({ method: 'AC', named: false });
    expect(useOf(pair(c), flow(b, c, { txHash: '0x2' }))).toEqual({ method: 'AC', named: false });
    expect(useOf(pair(null), flow(a, b, { txHash: '0x1' }))).toEqual({ method: 'AC', named: true });
  });

  it('uses a pair through a middle for its legs only, not the payment between its seller and buyer', () => {
    expect(useOf(pair(c), flow(a, b))).toBeNull();
    expect(useOf(pair(c), flow(a, x))).toBeNull();
  });

  it('says Money loops back uses a payment back, and names the money back it is on', () => {
    expect(useOf(loop(), flow(b, a))).toEqual({ method: 'AU', back: [b, a] });
    expect(useOf(loop(), flow(a, b))).toBeNull();
  });

  it('says Money loops back uses each payment between two wallets of a step, whatever its hash, and names the ends of the path', () => {
    const paths = [{ wallets: [b, x, a], txs: ['0x1', '0x2'] }];
    expect(useOf(loop({ paths }), flow(b, x, { txHash: '0x9' }))).toEqual({ method: 'AU', back: [b, a] });
    expect(useOf(loop({ paths }), flow(x, a, { txHash: '0x8' }))).toEqual({ method: 'AU', back: [b, a] });
    expect(useOf(loop({ paths }), flow(x, b))).toBeNull();
  });

  it('says a loop saved before paths were recorded uses its direct payments back only, and a loop of Round trips none', () => {
    expect(useOf(loop(), flow(b, x))).toBeNull();
    expect(useOf({ kind: 'scc', wallets: [a, b], cycles: 2 }, flow(b, a))).toBeNull();
  });
});
