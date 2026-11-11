import { describe, expect, it } from 'vitest';
import { MoneyGraph, RULES, analyze, tokenCycles } from '../src/methods.js';
import { ZERO } from '../src/graph.js';
import { CUSTODIANS, contractsFor } from '../src/marketplaces.js';
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

/** Money loops back records the way the money came back: each path's wallets, and the payment of each step. */
describe('Money loops back\'s paths', () => {
  const loopOf = (r: Analysis) => r.flags.find((f) => f.method === 'AU')?.witness;

  it('the demo\'s #113: the buyer paid the seller back through three wallets', () => {
    const [seller, buyer] = [w('chain-seller'), w('chain-buyer')];
    const way = [buyer, w('chain-hop-1'), w('chain-hop-2'), w('chain-hop-3'), seller];
    const flows = way.slice(1).map((to, i) => flow(way[i]!, to));
    expect(loopOf(analyze(input(chain('113', seller, buyer), flows)))).toEqual({
      kind: 'scc+flow', wallets: expect.arrayContaining([seller, buyer]), cycles: 1, via: [[buyer, seller]],
      paths: [{ wallets: way, txs: flows.map((f) => f.txHash) }],
    });
  });

  it('a payment straight back is a path of one step, named by its smallest hash that way round', () => {
    const flows = [flow(a, b, { txHash: '0x0' }), flow(b, a, { txHash: '0x9' }), flow(b, a, { txHash: '0x5' })];
    const loop = loopOf(analyze(input(chain('1', a, b), flows)));
    if (loop?.kind !== 'scc+flow') throw new Error('expected a loop closed by money');
    expect(loop.paths).toHaveLength(2);
    expect(loop.paths).toContainEqual({ wallets: [b, a], txs: ['0x5'] });
    expect(loop.paths).toContainEqual({ wallets: [a, b], txs: ['0x0'] });
  });

  it('keeps the first four of a loop\'s money edges', () => {
    const holders = [w('h0'), w('h1'), w('h2'), w('h3'), w('h4'), w('h5')];
    // Each holder paid the one before it back, so each reaches every one before it.
    const flows = holders.slice(1).map((from, i) => flow(from, holders[i]!));
    const loop = loopOf(analyze(input(chain('1', ...holders), flows)));
    if (loop?.kind !== 'scc+flow') throw new Error('expected a loop closed by money');
    expect(loop.via.length).toBeGreaterThan(4);
    expect(loop.paths).toHaveLength(4);
    expect(loop.paths!.map((p) => [p.wallets[0], p.wallets.at(-1)])).toEqual(loop.via.slice(0, 4));
    for (const p of loop.paths!) expect(p.txs).toHaveLength(p.wallets.length - 1);
  });

  it('the same paths whatever order the payments came in: of two ways, the one through the smaller address', () => {
    const y = w('y');
    const flows = [flow(b, y), flow(y, a), flow(b, x), flow(x, a)];
    const pathsOf = (fs: typeof flows) => {
      const loop = loopOf(analyze(input(chain('1', a, b), fs)));
      return loop?.kind === 'scc+flow' ? loop.paths : undefined;
    };
    expect(pathsOf(flows)).toEqual([{ wallets: [b, x, a], txs: [flows[2]!.txHash, flows[3]!.txHash] }]);
    expect(pathsOf([...flows].reverse())).toEqual(pathsOf(flows));
  });

  it('no paths when no money closes the loop', () => {
    const loop = loopOf(analyze(input(chain('1', a, b, a, b), [flow(a, x)])));
    expect(loop?.kind).toBe('scc');
    expect(loop).not.toHaveProperty('paths');
  });

  it('never goes through a hub, though the way round is longer', () => {
    // The hub's address is the smaller, so a search that crossed hubs would meet it first.
    const [hub, p, q] = [w('g'), w('p'), w('q')];
    const way = [flow(b, p), flow(p, q), flow(q, a)];
    // The search goes a level of the smaller side at a time: other payees of b make it turn back from a and meet
    // the hub there, other payers of a make it go on from b and meet the hub that way.
    const others = [[flow(b, w('d1')), flow(b, w('d2'))], [flow(w('e1'), a), flow(w('e2'), a), flow(w('e3'), a)]];
    for (const more of others) {
      const flows = [flow(b, hub), flow(hub, a), ...way, ...more];
      const loop = loopOf(analyze(input(chain('1', a, b), flows, { contracts: new Set([hub]) })));
      if (loop?.kind !== 'scc+flow') throw new Error('expected a loop closed by money');
      expect(loop.paths).toEqual([{ wallets: [b, p, q, a], txs: way.map((f) => f.txHash) }]);
    }
  });

  it('follows money exactly as far as reach does: reachDepth steps, and no more', () => {
    const way = [b, w('p'), w('q'), a];
    const flows = way.slice(1).map((to, i) => flow(way[i]!, to));
    const graph = (reachDepth: number) => {
      const i = input(chain('1', a, b), flows);
      return new MoneyGraph(i, new Set([a, b]), { ...RULES, reachDepth });
    };
    expect(graph(3).path(b, a)).toEqual({ wallets: way, txs: flows.map((f) => f.txHash) });
    expect(graph(2).path(b, a)).toBeNull();
    // As analyze records it: three steps is a loop with its path, and with reachDepth 2 no loop at all.
    const loopAt = (reachDepth: number) => loopOf(analyze(input(chain('1', a, b), flows, { rules: { reachDepth } })));
    expect(loopAt(3)).toMatchObject({ kind: 'scc+flow', paths: [{ wallets: way }] });
    expect(loopAt(2)).toBeUndefined();
  });

  it('searches a pair once per analysis, however many tokens it washed', () => {
    const graph = new MoneyGraph(input(chain('1', a, b), [flow(b, x), flow(x, a)]), new Set([a, b]), RULES);
    const search = graph.search.bind(graph);
    let searched = 0;
    graph.search = (from, to) => { searched += 1; return search(from, to); };
    const first = graph.path(b, a);
    expect(first).toMatchObject({ wallets: [b, x, a] });
    expect(graph.path(b, a)).toBe(first);
    expect(graph.path(a, b)).toBeNull();
    expect(graph.path(a, b)).toBeNull();
    expect(searched).toBe(2);
  });
});

/**
 * A linked pair's shape: which way the money went between the seller A, the
 * buyer B and their middle X. Of several that hold, back, then forward, then
 * funder, then payee.
 */
describe('a linked pair\'s shape', () => {
  const shapeOf = (flows: ReturnType<typeof flow>[]) => {
    const f = analyze(input(chain('1', a, b), flows)).flags.find((x) => x.method === 'AC');
    return f?.witness.kind === 'pair' ? f.witness.shape : undefined;
  };
  const cases: [string, () => ReturnType<typeof flow>[], string][] = [
    ['X funded both', () => [flow(x, a), flow(x, b)], 'funder'],
    ['both paid X', () => [flow(a, x), flow(b, x)], 'payee'],
    ['B paid A back through X', () => [flow(b, x), flow(x, a)], 'back'],
    ['A paid B through X', () => [flow(a, x), flow(x, b)], 'forward'],
    ['B paid A directly', () => [flow(b, a)], 'direct-back'],
    ['A paid B directly', () => [flow(a, b)], 'direct-forward'],
    ['A and B paid each other', () => [flow(a, b), flow(b, a)], 'both'],
  ];
  for (const [name, flows, shape] of cases) it(`${name}: ${shape}`, () => expect(shapeOf(flows())).toBe(shape));

  it('a direct payment wins over a middle', () => {
    expect(shapeOf([flow(b, a), flow(x, a), flow(x, b)])).toBe('direct-back');
  });

  it('of several that hold, back, then forward, then funder, then payee', () => {
    // Money both ways on both legs: every shape holds.
    expect(shapeOf([flow(x, a), flow(a, x), flow(x, b), flow(b, x)])).toBe('back');
    // X funded both, and A also paid X: forward and funder hold.
    expect(shapeOf([flow(x, a), flow(x, b), flow(a, x)])).toBe('forward');
    // X funded both, and B also paid X: back and funder hold.
    expect(shapeOf([flow(x, a), flow(x, b), flow(b, x)])).toBe('back');
    // Both paid X, and X also paid B: forward and payee hold.
    expect(shapeOf([flow(a, x), flow(b, x), flow(x, b)])).toBe('forward');
  });

  it('every way the money can go through a middle has one of the four', () => {
    // Each leg is X paid it, it paid X, or both: nine ways, none without a shape.
    const legs = (v: string) => [[flow(x, v)], [flow(v, x)], [flow(x, v), flow(v, x)]];
    const seen = new Set<string | undefined>();
    for (const sa of legs(a)) for (const sb of legs(b)) seen.add(shapeOf([...sa, ...sb]));
    expect([...seen].sort()).toEqual(['back', 'forward', 'funder', 'payee']);
  });

  it('the demo\'s #112, #114 and #116: paid back, funded, and both paid', () => {
    const [s2, b2, mule] = [w('f8-2-seller'), w('f8-2-buyer'), w('f8-2-mule')];
    const [s4, b4, funder] = [w('f8-4-seller'), w('f8-4-buyer'), w('f8-4-funder')];
    const [s6, b6, sink] = [w('f8-6-seller'), w('f8-6-buyer'), w('f8-6-sink')];
    const ts = [...chain('112', s2, b2), ...chain('114', s4, b4), ...chain('116', s6, b6)];
    const flows = [flow(b2, mule), flow(mule, s2), flow(funder, s4), flow(funder, b4), flow(s6, sink), flow(b6, sink)];
    const r = analyze(input(ts, flows));
    const witnessOf = (seller: string) => {
      const sale = ts.find((t) => t.from === seller)!;
      return r.flags.find((f) => f.method === 'AC' && f.txHash === sale.txHash)!.witness;
    };
    expect(witnessOf(s2)).toMatchObject({ kind: 'pair', pair: [s2, b2], middle: mule, shape: 'back' });
    expect(witnessOf(s4)).toMatchObject({ kind: 'pair', pair: [s4, b4], middle: funder, shape: 'funder' });
    expect(witnessOf(s6)).toMatchObject({ kind: 'pair', pair: [s6, b6], middle: sink, shape: 'payee' });
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

  it('analyze reproduces LAB.analysis with funding off', () => {
    same(analyze(input(LAB.transfers, [], { fundingAvailable: false, money: MONEY })), LAB.analysis);
  });

  it('LAB_MIXED, funded so Q4 is closed by money through W13', () => {
    const [w11, w12, w13] = [w('w11'), w('w12'), w('w13')];
    const flows = [flow(w13, w11, { txHash: '0xlab_x1' }), flow(w13, w12)];
    same(analyze(input(LAB_MIXED.transfers, flows, { money: MONEY })), LAB_MIXED.analysis);
  });
});

describe('tokenCycles', () => {
  const cyclesOf = (a: Analysis) => {
    const f = a.flags.find((x) => x.method === 'A');
    return f?.witness.kind === 'scc' ? f.witness.cycles : 0;
  };

  it('equals the count the analysis flags a looping token on', () => {
    const ts = chain('1', w('a'), w('b'), w('a'), w('b'), w('a'));
    const a = analyze(input(ts));
    expect(cyclesOf(a)).toBeGreaterThanOrEqual(2);
    expect(tokenCycles(ts, new Set()).cycles).toBe(cyclesOf(a));
  });

  it('counts one return as 1 cycle, below the minimum, so the analysis flags nothing', () => {
    const ts = chain('2', w('a'), w('b'), w('a'));
    const a = analyze(input(ts));
    expect(a.flags.filter((f) => f.method === 'A')).toEqual([]);
    const near = tokenCycles(ts, new Set());
    expect(near.cycles).toBe(1);
    expect(near.wallets).toEqual([w('a'), w('b')]);
  });

  it('is 0 when the token never comes back, and folds custody as the analysis does', () => {
    expect(tokenCycles(chain('3', w('a'), w('b'), w('c')), new Set()).cycles).toBe(0);
    const blend = w('e');
    const loan = [transfer('4', ZERO, w('a')), transfer('4', w('a'), blend), transfer('4', blend, w('a')), transfer('4', w('a'), w('b'))];
    expect(tokenCycles(loan, new Set([blend])).cycles).toBe(0);
  });
});

describe('CUSTODIANS', () => {
  it('names each escrow by address, and the contracts the engine skips still include it', () => {
    expect(CUSTODIANS['0x29469395eaf6f95920e59f858042f0e28d98a20b']).toBe('Blur Blend');
    for (const a of Object.keys(CUSTODIANS)) expect(contractsFor(1).has(a)).toBe(true);
  });
});
