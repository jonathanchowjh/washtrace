import { describe, expect, it } from 'vitest';
import { AddressGraph, ZERO, cycles, tarjan, tokenGraph } from '../src/graph.js';
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
    expect(g.hops).toEqual([{ from: a, to: b, ref: 1 }]);
    expect(g.moves).toBe(1);
  });

  it('bridges a gap from the last receiver to the next sender (paper §4.3)', () => {
    const g = graphOf([transfer('1', ZERO, a), transfer('1', b, c)]);
    expect(g.hops).toEqual([{ from: a, to: b, ref: null }, { from: b, to: c, ref: 1 }]);
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
    expect(g.hops).toEqual([{ from: a, to: b, ref: 2 }]);
  });
});
