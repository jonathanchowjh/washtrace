import { describe, expect, it } from 'vitest';
import { analyze } from '../src/methods.js';
import { LAB, LAB_MIXED, MONEY, chain, flow, input, transfer, w } from './fixtures.js';
import type { Analysis, Method } from '../src/types.js';

const a = w('a'), b = w('b'), c = w('c'), x = w('x');

function flaggedBy(result: ReturnType<typeof analyze>): Record<Method, number> {
  return { A: result.totals.A.flagged, AU: result.totals.AU.flagged, AC: result.totals.AC.flagged };
}

describe('SCC A', () => {
  it('does not flag one round trip: honest collectors sell and buy back', () => {
    expect(flaggedBy(analyze(input(chain('1', a, b, a))))).toEqual({ A: 0, AU: 0, AC: 0 });
  });

  it('flags every leg of a component with two cycles', () => {
    const r = analyze(input(chain('1', a, b, a, b)));
    expect(flaggedBy(r)).toEqual({ A: 3, AU: 3, AC: 3 });
    expect(r.flags.find((f) => f.method === 'A')!.witness).toEqual({ kind: 'scc', wallets: expect.arrayContaining([a, b]), cycles: 2 });
  });

  it('flags a three-wallet ring traded around twice', () => {
    expect(analyze(input(chain('1', a, b, c, a, b, c, a))).totals.A.flagged).toBe(6);
  });

  it('does not flag a token that only moves forward', () => {
    expect(analyze(input(chain('1', a, b, c))).totals.A.flagged).toBe(0);
  });
});

/**
 * Paper Figure 8: one sale A → B with no cycle in the asset graph, closed
 * by money of depth at most two. AU finds the directed cycles 1 and 2; AC
 * finds all six.
 */
describe('Figure 8', () => {
  const sale = () => chain('1', a, b);
  const cases: [string, () => ReturnType<typeof flow>[], boolean][] = [
    ['1: B pays A back', () => [flow(b, a)], true],
    ['2: B pays A back through X', () => [flow(b, x), flow(x, a)], true],
    ['3: A pays B', () => [flow(a, b)], false],
    ['4: X funds both', () => [flow(x, a), flow(x, b)], false],
    ['5: A pays B through X', () => [flow(a, x), flow(x, b)], false],
    ['6: both pay X', () => [flow(a, x), flow(b, x)], false],
  ];
  for (const [name, flows, au] of cases) {
    it(`cycle ${name}: AU ${au ? 'finds it' : 'does not'}, AC does`, () => {
      const r = analyze(input(sale(), flows()));
      expect(r.totals.A.flagged).toBe(0);
      expect(r.totals.AU.flagged).toBe(au ? 1 : 0);
      expect(r.totals.AC.flagged).toBe(1);
    });
  }

  it('AU follows money further than AC: a directed path of four', () => {
    const r = analyze(input(sale(), [flow(b, w('p')), flow(w('p'), w('q')), flow(w('q'), w('r')), flow(w('r'), a)]));
    expect(flaggedBy(r)).toEqual({ A: 0, AU: 1, AC: 0 });
  });

  it('AU stops at the reach depth', () => {
    const hops = [b, w('p'), w('q'), a];
    const flows = hops.slice(1).map((to, i) => flow(hops[i]!, to));
    expect(analyze(input(sale(), flows, { rules: { reachDepth: 2 } })).totals.AU.flagged).toBe(0);
    expect(analyze(input(sale(), flows, { rules: { reachDepth: 3 } })).totals.AU.flagged).toBe(1);
  });
});

describe('corrections since 2023', () => {
  it('does not read the payment leg of a sale as money closing the cycle', () => {
    // A WETH bid: B's WETH moves straight to A in the sale's own transaction.
    const ts = chain('1', a, b);
    const r = analyze(input(ts, [flow(b, a, { txHash: ts[1]!.txHash, kind: 'token' })]));
    expect(flaggedBy(r)).toEqual({ A: 0, AU: 0, AC: 0 });
  });

  it('does not join two customers through an exchange', () => {
    // X funded 25 of the collection's wallets: it is a hub, not a middle.
    const others = Array.from({ length: 24 }, (_, i) => w(`c${i}`));
    const ts = [...chain('1', a, b), ...others.flatMap((o, i) => chain(String(100 + i), o, w(`d${i}`)))];
    const r = analyze(input(ts, [flow(x, a), flow(x, b), ...others.map((o) => flow(x, o))]));
    expect(r.totals.AC.flagged).toBe(0);
  });

  it('still joins two wallets one funder set up', () => {
    expect(analyze(input(chain('1', a, b), [flow(x, a), flow(x, b)])).totals.AC.flagged).toBe(1);
  });

  it('never routes through a known contract', () => {
    const r = analyze(input(chain('1', a, b), [flow(x, a), flow(x, b)], { contracts: new Set([x]) }));
    expect(r.totals.AC.flagged).toBe(0);
  });

  it('reports AU and AC unavailable without a funding source, never as clean', () => {
    const r = analyze(input(chain('1', a, b), [flow(b, a)], { fundingAvailable: false }));
    expect(r.totals.AU).toMatchObject({ available: false, flagged: 0 });
    expect(r.totals.AC).toMatchObject({ available: false, flagged: 0 });
    expect(r.totals.A.available).toBe(true);
  });
});

describe('totals', () => {
  it('counts sales, volume and the flagged share of each', () => {
    const sale = { marketplace: 'seaport-1.6', priceWei: '1000000000000000000', currency: '' };
    const ts = [
      transfer('1', '0x0000000000000000000000000000000000000000', a),
      transfer('1', a, b, sale), transfer('1', b, a, sale), transfer('1', a, b, sale),
      ...chain('2', c, x),
    ];
    const t = analyze(input(ts)).totals.A;
    expect(t).toMatchObject({ transfers: 4, flagged: 3, sales: 3, flaggedSales: 3, wallets: 2, tokens: 1 });
    expect(t.volumeWei).toBe('3000000000000000000');
    expect(t.flaggedVolumeWei).toBe('3000000000000000000');
  });

  it('states the missing-data share', () => {
    const ts = [transfer('1', '0x0000000000000000000000000000000000000000', a), transfer('1', b, c)];
    expect(analyze(input(ts)).missingData).toBe(0.5);
  });
});

/**
 * The store returns rows in no particular order: with no ORDER BY, a seq
 * scan's order moves between runs. The same rows must give the same answer,
 * witnesses included.
 */
describe('the same data, the same answer', () => {
  /** A seeded shuffle (mulberry32), so a failure names the order that broke it. */
  function shuffled<T>(xs: readonly T[], seed: number): T[] {
    const out = [...xs];
    let s = seed;
    const next = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];

  it('reaches the same wallets when a search is cut short at visitCap, whatever the flows\' order', () => {
    // B paid eight wallets and A. A search stopped after three finds A or not by which it meets first.
    const ts = [...chain('1', a, b), ...chain('2', c, x)];
    const fs = [...Array.from({ length: 8 }, (_, i) => flow(b, w(`p${i}`))), flow(b, a), flow(x, w('q')), flow(x, c)];
    const run = (flows: typeof fs) => analyze(input(ts, flows, { rules: { visitCap: 3 } }));
    const want = run(fs);
    expect(want.truncatedSearches).toBeGreaterThan(0);
    for (const seed of seeds) expect(JSON.stringify(run(shuffled(fs, seed))), `seed ${seed}`).toBe(JSON.stringify(want));
  });

  it('names the same transaction and middle when two join a pair, whatever the flows\' order', () => {
    // B paid A back twice; X and Y each funded both C and D, X twice.
    const d = w('d'), y = w('y');
    const ts = [...chain('1', a, b), ...chain('2', c, d)];
    const fs = [flow(b, a), flow(b, a), flow(x, c), flow(x, c), flow(x, d), flow(y, c), flow(y, d)];
    const want = analyze(input(ts, fs));
    expect(want.totals.AC.flagged).toBe(2);
    for (const seed of seeds) expect(JSON.stringify(analyze(input(ts, shuffled(fs, seed)))), `seed ${seed}`).toBe(JSON.stringify(want));
  });

  it('gives the same flags in the same order, whatever the transfers\' order', () => {
    const ts = [...chain('1', a, b, a, b), ...chain('2', c, x, c, x), ...chain('3', a, c)];
    const fs = [flow(c, a)];
    const want = analyze(input(ts, fs));
    expect(want.totals.A.flagged).toBe(6);
    for (const seed of seeds) expect(JSON.stringify(analyze(input(shuffled(ts, seed), fs))), `seed ${seed}`).toBe(JSON.stringify(want));
  });
});

describe('uncounted', () => {
  it('reports the transfers no hop stands for, and leaves flags and totals as they were', () => {
    const k = w('k');
    const mint = transfer('1', '0x0000000000000000000000000000000000000000', a);
    const park = transfer('1', a, k);
    const unpark = transfer('1', k, a);
    const sold = transfer('1', a, b);
    const ts = [sold, unpark, mint, park];
    const r = analyze(input(ts, [], { custodians: new Set([k]) }));
    expect(r.uncounted).toEqual([mint, park, unpark].map((t) => ({ txHash: t.txHash, logIndex: t.logIndex })));
    expect(r.totals.A.transfers).toBe(1);
    expect(r.flags).toEqual([]);
    // Counted and uncounted together are every transfer there was.
    expect(r.uncounted.length + r.totals.A.transfers).toBe(ts.length);
  });
});

describe('uncounted on a fixture with flags', () => {
  it('leaves the flags and totals as they were, and is the complement of the counted transfers', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    const sale = { marketplace: 'seaport-1.6', priceWei: '1000000000000000000', currency: '' };
    const mint = transfer('1', zero, a);
    const ts = [mint, transfer('1', a, b, sale), transfer('1', b, a, sale), transfer('1', a, b, sale)];
    const r = analyze(input(ts));
    expect(r.flags).toHaveLength(9);
    expect(flaggedBy(r)).toEqual({ A: 3, AU: 3, AC: 3 });
    expect(r.totals.A).toMatchObject({ transfers: 3, sales: 3, flaggedSales: 3 });
    expect(r.uncounted).toEqual([{ txHash: mint.txHash, logIndex: 0 }]);
  });
});

/** The lab fixtures are hand-built; later tasks trust them, so they must be what `analyze` makes of their transfers. */
describe('the lab fixtures match the engine', () => {
  const keys = (a: Analysis, m: Method) => a.flags.filter((f) => f.method === m).map((f) => f.txHash).sort();
  const same = (made: Analysis, fixture: Analysis) => {
    expect(made.uncounted).toEqual(fixture.uncounted);
    for (const m of ['A', 'AU', 'AC'] as const) expect(keys(made, m), m).toEqual(keys(fixture, m));
    expect(made.totals).toEqual(fixture.totals);
  };

  it('LAB, with no funding', () => {
    same(analyze(input(LAB.transfers, [], { fundingAvailable: false, money: MONEY })), LAB.analysis);
  });

  it('LAB_MIXED, funded so Q4 is closed by money through W13', () => {
    const [w11, w12, w13] = [w('w11'), w('w12'), w('w13')];
    const flows = [flow(w13, w11, { txHash: '0xlab_x1' }), flow(w13, w12)];
    same(analyze(input(LAB_MIXED.transfers, flows, { money: MONEY })), LAB_MIXED.analysis);
  });
});
