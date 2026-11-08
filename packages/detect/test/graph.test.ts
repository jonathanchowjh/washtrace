import { describe, expect, it } from 'vitest';
import { AddressGraph, ZERO, cycles, parkedOf, tarjan, tokenGraph } from '../src/graph.js';
import { transfer, w } from './fixtures.js';

const a = w('a'), b = w('b'), c = w('c'), escrow = w('e5c');

function graphOf(ts: ReturnType<typeof transfer>[], custodians: string[] = []) {
  return tokenGraph(ts, ts.map((_, i) => i), new Set(custodians));
}

describe('tarjan', () => {
  it('finds a cycle and leaves a tail out of it', () => {
    // 0 → 1 → 2 → 0, and 2 → 3
    const found = tarjan([[1], [2], [0, 3], []]).map((cc) => [...cc].sort());
    expect(found).toContainEqual([0, 1, 2]);
    expect(found).toContainEqual([3]);
  });

  it('survives a path deeper than the call stack', () => {
    // A token traded along 200,000 wallets is a 200,000-deep search.
    const n = 200_000;
    const adjacent = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : [0]));
    expect(tarjan(adjacent)).toHaveLength(1);
  });
});

describe('cycles', () => {
  it('is one for a round trip and two for a second leg, as the paper counts', () => {
    expect(cycles(2, 2)).toBe(1);
    expect(cycles(2, 3)).toBe(2);
    expect(cycles(1, 1)).toBe(1); // a self-loop
    expect(cycles(1, 0)).toBe(0);
  });

  it('counts parallel edges inside a component', () => {
    const g = new AddressGraph();
    g.edge(a, b, 0, false);
    g.edge(b, a, 1, false);
    g.edge(a, b, 2, false);
    expect(g.components()).toEqual([expect.objectContaining({ cycles: 2 })]);
  });
});

describe('tokenGraph', () => {
  it('starts at the minter, with no edge from the zero address', () => {
    const g = graphOf([transfer('1', ZERO, a), transfer('1', a, b)]);
    expect(g.hops).toEqual([{ from: a, to: b, ref: 1, parked: null }]);
    expect(g.moves).toBe(1);
  });

  it('bridges a gap from the last receiver to the next sender (paper §4.3)', () => {
    const g = graphOf([transfer('1', ZERO, a), transfer('1', b, c)]);
    expect(g.hops).toEqual([{ from: a, to: b, ref: null, parked: null }, { from: b, to: c, ref: 1, parked: null }]);
    expect(g.gaps).toBe(1);
  });

  it('reads a loan through an escrow as no change of owner', () => {
    // A → Blend → A, twice: two loans, not two round trips.
    const g = graphOf([
      transfer('1', ZERO, a), transfer('1', a, escrow), transfer('1', escrow, a),
      transfer('1', a, escrow), transfer('1', escrow, a),
    ], [escrow]);
    expect(g.hops).toEqual([]);
    expect(g.gaps).toBe(0);
  });

  it('reads custody that ends with someone else as one hop to them', () => {
    // A defaults and the lender B takes the token.
    const g = graphOf([transfer('1', ZERO, a), transfer('1', a, escrow), transfer('1', escrow, b)], [escrow]);
    expect(g.hops).toEqual([{ from: a, to: b, ref: 2, parked: a }]);
  });

  it('a move out of custody to another wallet is a step with parked = the depositor', () => {
    // A trades to B, B borrows against it, and the lender C takes it: the step is B → C, held for B.
    const g = graphOf([transfer('1', ZERO, a), transfer('1', a, b), transfer('1', b, escrow), transfer('1', escrow, c)], [escrow]);
    expect(g.hops).toEqual([{ from: a, to: b, ref: 1, parked: null }, { from: b, to: c, ref: 3, parked: b }]);
  });

  it('a repaid loan makes no step', () => {
    const g = graphOf([transfer('1', ZERO, a), transfer('1', a, b), transfer('1', b, escrow), transfer('1', escrow, b)], [escrow]);
    expect(g.hops).toEqual([{ from: a, to: b, ref: 1, parked: null }]);
    expect(g.moves).toBe(1);
  });

  it('a step with no custody has parked null, a bridge too', () => {
    const g = graphOf([transfer('1', ZERO, a), transfer('1', a, b), transfer('1', c, a)], [escrow]);
    expect(g.hops.map((h) => h.parked)).toEqual([null, null, null]);
  });
});

describe('parkedOf', () => {
  it('names who custody held the token for as each move takes it out, by its place in the input, whatever order it came in', () => {
    // In chain order: mint to A, A → escrow, escrow → B (a trade from A), B → escrow, escrow → B (repaid), escrow → C with nothing read in.
    const ts = [
      transfer('1', ZERO, a), transfer('1', a, escrow), transfer('1', escrow, b),
      transfer('1', b, escrow), transfer('1', escrow, b), transfer('1', escrow, c),
    ].map((t, i) => ({ ...t, blockNumber: 10 + i }));
    const shuffled = [ts[4]!, ts[0]!, ts[5]!, ts[2]!, ts[1]!, ts[3]!];
    // The repaid loan names the wallet it went back to; a move out with no move in before it has no one.
    expect(parkedOf(shuffled, new Set([escrow]))).toEqual([b, null, null, a, null, null]);
  });

  it('reads a burn then re-mint as custody through the zero address, as the graph does', () => {
    const ts = [transfer('1', ZERO, a), transfer('1', a, ZERO), transfer('1', ZERO, b)].map((t, i) => ({ ...t, blockNumber: 10 + i }));
    expect(parkedOf(ts, new Set())).toEqual([null, null, a]);
  });

  // The cases the Task 4 review probed by hand, each given in reverse chain order.
  const second = w('e5d');
  const both = new Set([escrow, second]);
  const chain = (ts: ReturnType<typeof transfer>[]) => ts.map((t, i) => ({ ...t, blockNumber: 10 + i })).reverse();

  it('escrow to escrow to B is still a move out for A, who put it in', () => {
    const ts = chain([transfer('1', ZERO, a), transfer('1', a, escrow), transfer('1', escrow, second), transfer('1', second, b)]);
    expect(parkedOf(ts, both)).toEqual([a, null, null, null]);
  });

  it('a mint straight into escrow, then out, names no one: no wallet put it in', () => {
    const ts = chain([transfer('1', ZERO, escrow), transfer('1', escrow, b)]);
    expect(parkedOf(ts, both)).toEqual([null, null]);
  });

  it('three loans by A back to back, the last defaulted to C, each name A', () => {
    const ts = chain([
      transfer('1', ZERO, a), transfer('1', a, escrow), transfer('1', escrow, a), transfer('1', a, escrow),
      transfer('1', escrow, a), transfer('1', a, escrow), transfer('1', escrow, c),
    ]);
    expect(parkedOf(ts, both)).toEqual([a, null, a, null, a, null, null]);
  });

  it('a bridge then custody names the sender the bridge reached, B', () => {
    // Mint to A, then B → escrow with A → B never read: the graph bridges A to B, so B put it in.
    const ts = chain([transfer('1', ZERO, a), transfer('1', b, escrow), transfer('1', escrow, c)]);
    expect(parkedOf(ts, both)).toEqual([b, null, null]);
  });
});
