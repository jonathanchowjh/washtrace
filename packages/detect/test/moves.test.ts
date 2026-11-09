import { describe, expect, it } from 'vitest';
import { MOVE_KIND, Moves } from '../src/moves.js';

describe('Moves', () => {
  const build = () => {
    const m = new Moves();
    // Out of time order: a->b at 30, b->c at 10, a->c at 20, c->a at 40, a->b again at 10.
    m.add('a', 'b', MOVE_KIND.eth, 30, 3, 1.5, false);
    m.add('b', 'c', MOVE_KIND.weth, 10, 1, 0.5, true);
    m.add('a', 'c', MOVE_KIND.internal, 20, 2, 2, false);
    m.add('c', 'a', MOVE_KIND.eth, 40, 4, 3, false);
    m.add('a', 'b', MOVE_KIND.eth, 10, 1, 0.25, true);
    m.seal();
    return m;
  };
  const id = (m: Moves, s: string) => m.id(s)!;

  it('sorts the edges by time, carrying every column with its edge', () => {
    const m = build();
    expect(Array.from(m.time)).toEqual([10, 10, 20, 30, 40]);
    // The two time-10 edges keep the order they were added in.
    expect(Array.from(m.amountEth)).toEqual([0.5, 0.25, 2, 1.5, 3]);
    expect(Array.from(m.kind)).toEqual([MOVE_KIND.weth, MOVE_KIND.eth, MOVE_KIND.internal, MOVE_KIND.eth, MOVE_KIND.eth]);
    expect(Array.from(m.block)).toEqual([1, 1, 2, 3, 4]);
    expect(Array.from(m.sale)).toEqual([1, 1, 0, 0, 0]);
    expect(m.size).toBe(5);
  });

  it('lists the edges leaving and entering a wallet by time, ascending', () => {
    const m = build();
    const a = id(m, 'a'), c = id(m, 'c');
    expect(Array.from(m.out(a))).toEqual([1, 2, 3]);
    expect(Array.from(m.into(a))).toEqual([4]);
    expect(Array.from(m.into(c))).toEqual([0, 2]);
    expect(Array.from(m.out(a), (e) => m.time[e]!)).toEqual([10, 20, 30]);
    expect(Array.from(m.out(99))).toEqual([]);
  });

  it('numbers wallets by first sight, and names them back', () => {
    const m = build();
    expect(m.wallets).toBe(3);
    expect([0, 1, 2].map((w) => m.name(w))).toEqual(['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) expect(m.name(m.id(name)!)).toBe(name);
    expect(m.id('d')).toBeUndefined();
    expect(Array.from(m.from, (n) => m.name(n))).toEqual(['b', 'a', 'a', 'a', 'c']);
  });

  // Past one block of edges (2,097,152), both ways a store can hand them over.
  const MANY = (1 << 21) + 5;

  it('keeps edges that came in time order as read, across its blocks', () => {
    const m = new Moves();
    for (let i = 0; i < MANY; i++) m.add(i % 2 ? 'a' : 'b', 'c', i % 3, (i / 7) | 0, i, i / 4, i % 5 === 0);
    m.seal();
    expect(m.size).toBe(MANY);
    for (const i of [0, 1, (1 << 21) - 1, 1 << 21, MANY - 1]) {
      expect([m.time[i], m.block[i], m.kind[i], m.amountEth[i], m.sale[i], m.name(m.from[i]!)]).toEqual([(i / 7) | 0, i, i % 3, i / 4, i % 5 === 0 ? 1 : 0, i % 2 ? 'a' : 'b']);
    }
    expect(m.into(m.id('c')!)).toHaveLength(MANY);
    expect(m.out(m.id('a')!)[0]).toBe(1);
  });

  it('sorts edges that did not, across its blocks, ties in the order added', () => {
    const m = new Moves();
    // Times running backwards in pairs, so every time is a tie of two.
    const timeOf = (i: number) => (MANY - i) >> 1;
    for (let i = 0; i < MANY; i++) m.add('a', 'b', MOVE_KIND.eth, timeOf(i), i, 1, i === MANY - 1);
    m.seal();
    const order = Array.from({ length: MANY }, (_, i) => i).sort((p, q) => timeOf(p) - timeOf(q) || p - q);
    expect(m.size).toBe(MANY);
    for (const k of [0, 1, 2, (1 << 21) - 1, 1 << 21, MANY - 1]) expect([m.block[k], m.time[k]]).toEqual([order[k], timeOf(order[k]!)]);
    expect(m.sale[order.indexOf(MANY - 1)]).toBe(1);
    expect(m.out(0)).toHaveLength(MANY);
  });

  it('numbers and names back many wallets, past every table it outgrows', () => {
    const m = new Moves();
    const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
    for (let i = 0; i < 100_000; i++) m.add(addr(i), addr(i + 1), MOVE_KIND.eth, i, i, 1, false);
    m.seal();
    expect(m.wallets).toBe(100_001);
    for (const i of [0, 1, 511, 512, 65_535, 99_999, 100_000]) {
      expect(m.id(addr(i))).toBe(i);
      expect(m.name(i)).toBe(addr(i));
    }
    expect(m.id(addr(100_001))).toBeUndefined();
    expect(m.id('0x')).toBeUndefined();
  });

  it('holds an amount as a 32-bit float', () => {
    const m = new Moves();
    m.add('a', 'b', MOVE_KIND.eth, 1, 1, 0.1, false);
    m.seal();
    expect(m.amountEth[0]).toBe(Math.fround(0.1));
  });

  it('refuses a second seal, and an edge after the first, keeping what it holds', () => {
    const m = build();
    expect(() => m.seal()).toThrow('Moves is already sealed: seal() is called once.');
    expect(() => m.add('a', 'b', MOVE_KIND.eth, 50, 5, 1, false)).toThrow('Moves is sealed');
    expect(m.size).toBe(5);
    expect(Array.from(m.time)).toEqual([10, 10, 20, 30, 40]);
    expect(Array.from(m.out(m.id('a')!))).toEqual([1, 2, 3]);
  });

  it('seals with no edges', () => {
    const m = new Moves();
    m.seal();
    expect(m.size).toBe(0);
    expect(Array.from(m.out(0))).toEqual([]);
  });
});
