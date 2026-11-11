import { describe, expect, it } from 'vitest';
import { ZERO, type FlaggedTransfer, type LoopEdge, type OwnFlag } from '@washtrace/detect';
import { layout } from '@/lib/layout';

const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40), x = '0x' + 'c'.repeat(40);

function t(from: string, to: string, flags: FlaggedTransfer['flags'] = {}): FlaggedTransfer {
  return { txHash: '0x1', logIndex: 0, blockNumber: 1, blockTime: null, tokenId: '1', from, to, marketplace: null, priceWei: null, currency: null, flags };
}

// The lab's token 1 (packages/detect/test/fixtures.ts LAB): minted to w1, then a ring w1 → w2 → w3 → w1 → w2, all Round trips.
const w = (n: string) => `0x${n.padStart(40, '0')}`;
const [W1, W2, W3] = [w('w1'), w('w2'), w('w3')];
const labScc = { kind: 'scc' as const, wallets: [W1, W2, W3], cycles: 2 };
const lab = (key: string, from: string, to: string, block: number, flagged: boolean): FlaggedTransfer => ({
  txHash: `0xlab_${key.toLowerCase()}`, logIndex: 0, blockNumber: block, blockTime: null, tokenId: '1', from, to,
  marketplace: flagged ? 'blur' : null, priceWei: flagged ? '1000000000000000000' : null, currency: flagged ? '' : null, flags: flagged ? { A: labScc } : {},
});
const LAB = [lab('M1', ZERO, W1, 100, false), lab('S1', W1, W2, 200, true), lab('S2', W2, W3, 300, true), lab('S3', W3, W1, 400, true), lab('S4', W1, W2, 500, true)];

describe('layout', () => {
  it('a built-in drawing is unchanged with no own flags', () => {
    expect(layout(LAB, [], [])).toMatchInlineSnapshot(`
      {
        "edges": [
          {
            "d": "M 280 187.62395692965987 Q 306.143593539449 264.905989232415 351.41828539142705 316.42307533065843",
            "from": "0x00000000000000000000000000000000000000w1",
            "ids": [
              "0xlab_s1:0",
            ],
            "key": "t1",
            "kind": "asset",
            "label": "2",
            "lx": 313.07179676972453,
            "ly": 260.905989232415,
            "row": 2,
            "title": "#2 sale on Blur · flagged",
            "to": "0x00000000000000000000000000000000000000w2",
            "tone": "cycle",
            "tx": "0xlab_s1",
          },
          {
            "d": "M 360 326.18802153517004 Q 280 310.18802153517004 212.74754878398196 323.6385117783737",
            "from": "0x00000000000000000000000000000000000000w2",
            "ids": [
              "0xlab_s2:0",
            ],
            "key": "t2",
            "kind": "asset",
            "label": "3",
            "lx": 280,
            "ly": 318.18802153517004,
            "row": 3,
            "title": "#3 sale on Blur · flagged",
            "to": "0x00000000000000000000000000000000000000w3",
            "tone": "cycle",
            "tx": "0xlab_s2",
          },
          {
            "d": "M 200 326.1880215351701 Q 253.85640646055103 264.905989232415 275.83416582459097 199.93841289096787",
            "from": "0x00000000000000000000000000000000000000w3",
            "ids": [
              "0xlab_s3:0",
            ],
            "key": "t3",
            "kind": "asset",
            "label": "4",
            "lx": 246.92820323027553,
            "ly": 260.905989232415,
            "row": 4,
            "title": "#4 sale on Blur · flagged",
            "to": "0x00000000000000000000000000000000000000w1",
            "tone": "cycle",
            "tx": "0xlab_s3",
          },
          {
            "d": "M 280 187.62395692965987 Q 276.69872981077805 281.905989232415 348.5211079256864 320.0859696879419",
            "from": "0x00000000000000000000000000000000000000w1",
            "ids": [
              "0xlab_s4:0",
            ],
            "key": "t4",
            "kind": "asset",
            "label": "5",
            "lx": 298.34936490538905,
            "ly": 269.405989232415,
            "row": 5,
            "title": "#5 sale on Blur · flagged",
            "to": "0x00000000000000000000000000000000000000w2",
            "tone": "cycle",
            "tx": "0xlab_s4",
          },
        ],
        "loops": [
          {
            "edges": [
              "t1",
              "t2",
              "t3",
              "t4",
            ],
            "key": "r0",
            "methods": [
              "A",
            ],
            "nodes": [
              "0x00000000000000000000000000000000000000w1",
              "0x00000000000000000000000000000000000000w2",
              "0x00000000000000000000000000000000000000w3",
            ],
          },
        ],
        "nodes": [
          {
            "anchor": "middle",
            "first": true,
            "id": "0x00000000000000000000000000000000000000w1",
            "lx": 280,
            "ly": 161.62395692965987,
            "middle": false,
            "x": 280,
            "y": 187.62395692965987,
          },
          {
            "anchor": "start",
            "first": false,
            "id": "0x00000000000000000000000000000000000000w2",
            "lx": 382.5166604983954,
            "ly": 339.18802153517004,
            "middle": false,
            "x": 360,
            "y": 326.18802153517004,
          },
          {
            "anchor": "end",
            "first": false,
            "id": "0x00000000000000000000000000000000000000w3",
            "lx": 177.4833395016046,
            "ly": 339.1880215351701,
            "middle": false,
            "x": 200,
            "y": 326.1880215351701,
          },
        ],
        "size": 560,
        "view": {
          "h": 217.56406460551023,
          "w": 365.03332099679085,
          "x": 97.4833395016046,
          "y": 141.62395692965987,
        },
      }
    `);
  });

  it('draws a transfer flagged only by Money loops back as apart, saying it is not counted', () => {
    const pair = { kind: 'pair' as const, pair: [a, b] as [string, string], middle: null, flowTx: '0x2' };
    const e = layout([t(a, b, { AU: pair })], [], []).edges[0]!;
    expect(e.tone).toBe('apart');
    expect(e.title).toContain('not counted');
    expect(e.title.endsWith(' · flagged')).toBe(false);
  });

  it('takes the strongest tone for a bundle of more than 6 transfers between one pair', () => {
    const pair = { kind: 'pair' as const, pair: [a, b] as [string, string], middle: null, flowTx: '0x2' };
    const scc = { kind: 'scc' as const, wallets: [a, b], cycles: 2 };
    const ts = [t(a, b, { AU: pair }), t(a, b, { A: scc }), ...Array.from({ length: 5 }, () => t(a, b))];
    const edges = layout(ts, [], []).edges.filter((e) => e.kind === 'asset');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.tone).toBe('cycle');
  });

  it('draws a small graph in the box round it, not the whole square, its labels inside', () => {
    const d = layout([t(a, b), t(b, a)], [], []);
    // Two holders, left and right: a strip, far shorter than the square. Its width is their labels', outside the ring.
    expect(d.view.h).toBeLessThan(d.size / 3);
    expect(d.view.h).toBeLessThan(d.view.w / 2);
    for (const n of d.nodes) {
      expect(n.x).toBeGreaterThan(d.view.x);
      expect(n.x).toBeLessThan(d.view.x + d.view.w);
      expect(n.ly).toBeGreaterThan(d.view.y);
      expect(n.ly).toBeLessThan(d.view.y + d.view.h);
    }
    // The left holder's label ends at it, the right's starts there, so each sits outside the pair.
    expect(d.nodes.map((n) => n.anchor)).toEqual(['end', 'start']);
    // A ring of three is drawn taller.
    expect(layout(LAB, [], []).view.h).toBeGreaterThan(d.view.h);
  });

  it('draws a two-wallet loop narrow enough for a phone’s column at full size, its labels under its wallets', () => {
    const d = layout([t(ZERO, a), t(a, b), t(b, a), t(a, b), t(b, a)], [], []);
    // A phone's graph box is about 312 px: the strip fits it unscaled, so its 10 px labels stay 10 px.
    expect(d.view.w).toBeLessThanOrEqual(312);
    for (const n of d.nodes) expect(n.ly).toBeGreaterThan(n.y + 10);
  });

  it('draws a loop of three no wider than a phone shows at 0.8 of its size, and a crowd on the full ring', () => {
    expect(layout(LAB, [], []).view.w * 0.8).toBeLessThanOrEqual(312);
    const crowd = Array.from({ length: 8 }, (_, i) => t(w(`c${i}`), w(`c${(i + 1) % 8}`)));
    const [n0, n4] = [layout(crowd, [], []).nodes[0]!, layout(crowd, [], []).nodes[4]!];
    expect(Math.abs(n0.y - n4.y)).toBeCloseTo(360);
  });

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
    expect(asset.map((e) => e.row).sort()).toEqual([2, 3]);
  });

  it('draws money only between wallets on the drawing, counting repeats on one arrow', () => {
    const flow = (from: string, to: string) => ({ txHash: '0xf', kind: 'native' as const, from, to, valueWei: '1', token: '', blockNumber: 1, blockTime: 1 });
    const d = layout([t(ZERO, a), t(a, b)], [flow(b, a), flow(b, a), flow(b, '0x' + 'd'.repeat(40))], []);
    const money = d.edges.filter((e) => e.kind === 'money');
    expect(money).toHaveLength(1);
    expect(money[0]!.label).toBe('×2');
  });

  it('names each reason’s arrows and wallets, and gives an arrow its trade and row', () => {
    const c = '0x' + 'd'.repeat(40);
    const one = { kind: 'scc' as const, wallets: [a, b], cycles: 2 };
    const two = { kind: 'scc' as const, wallets: [b, c], cycles: 3 };
    const flow = { txHash: '0xf', kind: 'native' as const, from: b, to: c, valueWei: '1', token: '', blockNumber: 1, blockTime: 1 };
    const ts = [{ ...t(ZERO, a), txHash: '0xs0' }, { ...t(a, b, { A: one }), txHash: '0xs1' }, { ...t(b, a, { A: one }), txHash: '0xs2' }, { ...t(b, c, { AC: two }), txHash: '0xs3' }];
    const d = layout(ts, [flow], []);
    expect(d.loops.map((l) => l.key)).toEqual(['r0', 'r1']);
    expect(d.loops[0]!.methods).toEqual(['A']);
    expect(d.loops[0]!.edges).toEqual(['t1', 't2']);
    expect(d.loops[0]!.nodes).toEqual([a, b]);
    // The second reason also takes the money between its two wallets.
    expect(d.loops[1]!.edges).toEqual(['t3', `m${b}>${c}`]);
    const e = d.edges.find((x) => x.key === 't2')!;
    expect([e.tx, e.row]).toEqual(['0xs2', 3]);
    expect(d.edges.find((x) => x.kind === 'money')).toMatchObject({ tx: null, row: null });
  });

  it('takes a bundle into the reason of every transfer it holds, and opens its first trade', () => {
    const scc = { kind: 'scc' as const, wallets: [a, b], cycles: 2 };
    const ping = Array.from({ length: 20 }, (_, i) => ({ ...(i % 2 === 0 ? t(a, b, { A: scc }) : t(b, a, { A: scc })), txHash: `0xp${i}` }));
    const d = layout(ping, [], []);
    expect(d.loops[0]!.edges).toHaveLength(2);
    expect(d.edges.map((e) => e.tx).sort()).toEqual(['0xp0', '0xp1']);
  });

  describe('an arrow’s number', () => {
    const ts = [{ ...t(ZERO, a), txHash: '0xs0' }, { ...t(a, b), txHash: '0xs1' }, { ...t(b, a), txHash: '0xs2', logIndex: 3 }];

    it('is the transfer’s place in its token’s history, the mint 1, as the token’s table numbers it', () => {
      const asset = layout(ts, [], []).edges.filter((e) => e.kind === 'asset');
      expect(asset.map((e) => [e.label, e.title])).toEqual([['2', '#2 transfer'], ['3', '#3 transfer']]);
    });

    it('keeps that place when the list is not the whole history, as a ring’s is', () => {
      // The ring draws only its wallets' transfers: no mint, so the list's own order would start at 1.
      const asset = layout([{ ...ts[1]!, n: 2 }, { ...ts[2]!, n: 3 }], [], []).edges.filter((e) => e.kind === 'asset');
      expect(asset.map((e) => e.label)).toEqual(['2', '3']);
      // The row stays the list's, which a page's links are keyed by.
      expect(asset.map((e) => e.row)).toEqual([1, 2]);
    });

    it('names its token in a drawing of several, where two tokens each have a transfer 2', () => {
      const several = [{ ...t(a, b), n: 2 }, { ...t(b, a), tokenId: '114', n: 2 }];
      const asset = layout(several, [], []).edges.filter((e) => e.kind === 'asset');
      expect(asset.map((e) => [e.label, e.title])).toEqual([['#1·2', '#1·2 transfer'], ['#114·2', '#114·2 transfer']]);
    });

    it('is said for a bundle’s first and last, and a bundle holds every transfer it draws', () => {
      const ping = Array.from({ length: 14 }, (_, i) => ({ ...(i % 2 === 0 ? t(a, b) : t(b, a)), txHash: `0xp${i}` }));
      const bundle = layout([t(ZERO, a), ...ping], [], []).edges.find((e) => e.from === a)!;
      expect(bundle.title).toBe('7 transfers this way, #2 to #14');
      expect(bundle.ids).toEqual([0, 2, 4, 6, 8, 10, 12].map((i) => `0xp${i}:0`));
      // An arrow holds its one transfer, by hash and log index; money holds none.
      expect(layout(ts, [], []).edges.map((e) => e.ids)).toEqual([['0xs1:0'], ['0xs2:3']]);
    });
  });

  describe('a lens of yours', () => {
    const y = '0x' + 'e'.repeat(40);
    const edge = (kind: LoopEdge['kind'], from: string, to: string, more: Partial<LoopEdge> = {}): LoopEdge =>
      ({ from, to, kind, tx: null, time: null, amountWei: null, tokenId: null, token: null, ...more });
    const own = (path: LoopEdge[], wallets: string[], lensId = 7): OwnFlag => ({ lensId, collectionId: 1, txHash: '0xs1', logIndex: 0, path, wallets });
    const ts = [{ ...t(ZERO, a), txHash: '0xs0' }, { ...t(a, b), txHash: '0xs1' }];

    it('draws a lens path through a wallet outside the token’s graph', () => {
      const path = [edge('nft-token', a, b, { tx: '0xs1', tokenId: '1' }), edge('eth', b, x, { amountWei: '500000000000000000' }), edge('eth', x, a)];
      const d = layout(ts, [], [], [own(path, [a, b, x])]);
      // The money middle is no holder and no built-in middle, so it joins the inner ring rather than being dropped.
      expect(d.nodes.find((n) => n.id === x)).toMatchObject({ middle: true });
      const loop = d.loops.find((l) => l.key === 'o0')!;
      expect(loop.methods).toEqual(['L7']);
      expect(loop.nodes).toEqual([a, b, x]);
      // The trade lights its own arrow; the way back is two new arrows of the lens.
      expect(loop.edges).toEqual(['t1', 'o0e1', 'o0e2']);
      const [e1, e2] = ['o0e1', 'o0e2'].map((k) => d.edges.find((e) => e.key === k)!);
      expect(e1).toMatchObject({ kind: 'money', tone: 'own', from: b, to: x, label: '0.5', tx: null, row: null });
      expect(e2).toMatchObject({ kind: 'money', tone: 'own', from: x, to: a, label: '?' });
      expect(d.edges.filter((e) => e.kind === 'asset')).toHaveLength(1);
    });

    it('draws another token’s transfer solid with its number, and a funding dashed with its amount', () => {
      const path = [edge('nft-token', a, b, { tx: '0xs1', tokenId: '1' }), edge('nft-collection', b, y, { tx: '0xc9', tokenId: '9' }), edge('funds', y, a, { amountWei: '1234567000000000000' })];
      const d = layout(ts, [], [], [own(path, [a, b, y])]);
      expect(d.nodes.find((n) => n.id === y)).toMatchObject({ middle: true });
      expect(d.edges.find((e) => e.key === 'o0e1')).toMatchObject({ kind: 'asset', tone: 'own', label: '#9', tx: '0xc9', row: null, token: '9' });
      expect(d.edges.find((e) => e.key === 'o0e2')).toMatchObject({ kind: 'money', tone: 'own', label: '1.2345' });
    });

    it('reads a token edge in its own symbol, scaled by its decimals, on the arrow and on hover; an old path without a token still reads ETH', () => {
      const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', APE = '0x4d224452801aced8b2f0aebe155379bb5d594381';
      const path = [
        edge('nft-token', a, b, { tx: '0xs1', tokenId: '1' }),
        edge('other-tokens', b, x, { amountWei: '1250500000', token: USDC }),
        edge('funds', x, y, { amountWei: '3000000000000000000', token: APE }),
        // Stored before LoopEdge had a token: no key at all.
        { from: y, to: a, kind: 'eth', tx: null, time: null, amountWei: '500000000000000000', tokenId: null } as unknown as LoopEdge,
      ];
      const d = layout(ts, [], [], [own(path, [a, b, x, y])]);
      const at = (key: string) => d.edges.find((e) => e.key === key)!;
      expect(at('o0e1')).toMatchObject({ kind: 'money', label: '1,250.5 USDC', title: '1,250.5 USDC paid, on a loop of a lens of yours' });
      expect(at('o0e2')).toMatchObject({ kind: 'money', label: '3 APE', title: '3 APE funding the seller before the trade, on a loop of a lens of yours' });
      expect(at('o0e3')).toMatchObject({ kind: 'money', label: '0.5', title: '0.5 ETH paid, on a loop of a lens of yours' });
    });

    it('lights an arrow of the token for every transfer of it on the path, and keeps the built-in loops first', () => {
      const scc = { kind: 'scc' as const, wallets: [a, b], cycles: 1 };
      const ring = [{ ...t(ZERO, a), txHash: '0xs0' }, { ...t(a, b, { A: scc }), txHash: '0xs1' }, { ...t(b, a, { A: scc }), txHash: '0xs2' }];
      const path = [edge('nft-token', a, b, { tx: '0xs1', tokenId: '1' }), edge('nft-token', b, a, { tx: '0xs2', tokenId: '1' })];
      const d = layout(ring, [], [], [own(path, [a, b]), own(path, [a, b], 8)]);
      expect(d.loops.map((l) => [l.key, l.methods])).toEqual([['r0', ['A']], ['o0', ['L7']], ['o1', ['L8']]]);
      expect(d.loops[1]!.edges).toEqual(['t1', 't2']);
      expect(d.edges.some((e) => e.tone === 'own')).toBe(false);
    });
  });
});
