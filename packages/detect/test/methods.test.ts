import { describe, expect, it } from 'vitest';
import { analyze } from '../src/methods.js';
import { chain, flow, input, transfer, w } from './fixtures.js';
import type { Method } from '../src/types.js';

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
