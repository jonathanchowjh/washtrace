import { describe, expect, it } from 'vitest';
import { ZERO, type FlaggedTransfer } from '@washtrace/detect';
import { layout, verdictOf } from '@/lib/layout';

const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40), x = '0x' + 'c'.repeat(40);

function t(from: string, to: string, flags: FlaggedTransfer['flags'] = {}): FlaggedTransfer {
  return { txHash: '0x1', logIndex: 0, blockNumber: 1, blockTime: null, tokenId: '1', from, to, marketplace: null, priceWei: null, currency: null, flags };
}

describe('verdictOf', () => {
  it('ranks a cycle of the token above a link through money', () => {
    const scc = { kind: 'scc' as const, wallets: [a, b], cycles: 2 };
    const pair = { kind: 'pair' as const, pair: [a, b] as [string, string], middle: null, flowTx: '0x2' };
    expect(verdictOf(t(a, b, { A: scc, AC: scc }))).toBe('cycle');
    expect(verdictOf(t(a, b, { AC: pair }))).toBe('money');
    expect(verdictOf(t(a, b))).toBe('clean');
  });
});

describe('layout', () => {
  it('draws no node for the zero address and no edge for a mint', () => {
    const d = layout([t(ZERO, a), t(a, b)], [], []);
    expect(d.nodes.map((n) => n.id)).toEqual([a, b]);
    expect(d.edges.filter((e) => e.kind === 'asset')).toHaveLength(1);
  });

  it('keeps a middle off the line between two holders', () => {
    const d = layout([t(ZERO, a), t(a, b)], [], [x]);
    const [na, nb, nx] = d.nodes;
    // Holders left and right on one horizontal line; the middle above it.
    expect(na!.y).toBeCloseTo(nb!.y);
    expect(Math.abs(nx!.y - na!.y)).toBeGreaterThan(20);
  });

  it('gives parallel transfers between one pair distinct paths', () => {
    const d = layout([t(ZERO, a), t(a, b), t(b, a), t(a, b)], [], []);
    const paths = d.edges.map((e) => e.d);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('bundles a pair traded more often than a fan can show into one arrow per direction', () => {
    const ping = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? t(a, b) : t(b, a)));
    const d = layout([t(ZERO, a), ...ping], [], []);
    const asset = d.edges.filter((e) => e.kind === 'asset');
    expect(asset).toHaveLength(2);
    expect(asset.map((e) => e.label).sort()).toEqual(['×10', '×10']);
    // Each bundle points at its first transfer's row, so the label still leads to the table.
    expect(asset.map((e) => e.ref).sort()).toEqual([1, 2]);
  });

  it('draws money only between wallets on the drawing, counting repeats on one arrow', () => {
    const flow = (from: string, to: string) => ({ txHash: '0xf', kind: 'native' as const, from, to, valueWei: '1', token: '', blockNumber: 1, blockTime: 1 });
    const d = layout([t(ZERO, a), t(a, b)], [flow(b, a), flow(b, a), flow(b, '0x' + 'd'.repeat(40))], []);
    const money = d.edges.filter((e) => e.kind === 'money');
    expect(money).toHaveLength(1);
    expect(money[0]!.label).toBe('×2');
  });
});
