import { describe, expect, it } from 'vitest';
import { analyze } from '../src/methods.js';
import { Payments } from '../src/payments.js';
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
      expect(witness(p)).toEqual({ kind: 'pair', pair: [a, b], middle: null, flowTx: '0x1' });
    }
    // Through a middle: the tx is the one joining it to the side with fewer neighbours, smallest either way.
    const p = new Payments();
    p.add(x, a, '0x9');
    p.add(a, x, '0x3');
    p.add(x, b, '0x5');
    p.add(b, c, '0x7');
    expect(witness(p)).toEqual({ kind: 'pair', pair: [a, b], middle: x, flowTx: '0x3' });
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

  it('an empty Payments analyses as no flows did', () => {
    const ts = [...chain('1', a, b, a, b), ...chain('2', c, x)];
    const empty = analyze({ ...input(ts), payments: new Payments() });
    expect(empty).toEqual(analyze(input(ts, [])));
    expect(empty).toEqual(analyze(input(ts, [flow(a, a), flow(ZERO, c)])));
    expect(empty.truncatedSearches).toBe(0);
    expect([empty.totals.A.flagged, empty.totals.AU.flagged, empty.totals.AC.flagged]).toEqual([3, 3, 3]);
  });
});
