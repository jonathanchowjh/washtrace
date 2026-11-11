import { describe, expect, it } from 'vitest';
import { ZERO, type FlaggedTransfer, type LoopEdge, type OwnFlag } from '@washtrace/detect';
import { FAN_MAX, OWN_MARGIN, layout, reasons } from '@/lib/layout';
import { LABELLED_MAX } from '@/lib/format';

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

describe('layout custody', () => {
  it('marks only an escrow wallet, by its name', () => {
    const blend = '0x29469395eaf6f95920e59f858042f0e28d98a20b';
    const nodes = layout([t(a, blend), t(blend, a)], [], []).nodes;
    expect(nodes.map((n) => [n.id === blend ? 'blend' : 'a', n.custody])).toEqual([['a', null], ['blend', 'Blur Blend']]);
  });
});

describe('layout', () => {
  it('a built-in drawing is unchanged with no own flags', () => {
    expect(layout(LAB, [], [])).toMatchInlineSnapshot(`
      {
        "edges": [
          {
            "amount": "1 ETH",
            "d": "M 280 187.62395692965987 Q 333.856406460551 248.90598923241498 355.83416582459097 313.87356557386204",
            "from": "0x00000000000000000000000000000000000000w1",
            "ids": [
              "0xlab_s1:0",
            ],
            "key": "t1",
            "kind": "asset",
            "label": "2",
            "lx": 301.04903810567663,
            "ly": 267.8473321835049,
            "row": 2,
            "title": "#2 sale on Blur · flagged",
            "to": "0x00000000000000000000000000000000000000w2",
            "tone": "cycle",
            "tx": "0xlab_s1",
          },
          {
            "amount": "1 ETH",
            "d": "M 360 326.18802153517004 Q 280 342.18802153517004 212.74754878398196 328.7375312919665",
            "from": "0x00000000000000000000000000000000000000w2",
            "ids": [
              "0xlab_s2:0",
            ],
            "key": "t2",
            "kind": "asset",
            "label": "3",
            "lx": 280,
            "ly": 324.18802153517004,
            "row": 3,
            "title": "#3 sale on Blur · flagged",
            "to": "0x00000000000000000000000000000000000000w3",
            "tone": "cycle",
            "tx": "0xlab_s2",
          },
          {
            "amount": "1 ETH",
            "d": "M 200 326.1880215351701 Q 226.14359353944897 248.90598923241498 271.41828539142705 197.38890313417147",
            "from": "0x00000000000000000000000000000000000000w3",
            "ids": [
              "0xlab_s3:0",
            ],
            "key": "t3",
            "kind": "asset",
            "label": "4",
            "lx": 204.68334473406279,
            "ly": 240.79563756767598,
            "row": 4,
            "title": "#4 sale on Blur · flagged",
            "to": "0x00000000000000000000000000000000000000w1",
            "tone": "cycle",
            "tx": "0xlab_s3",
          },
          {
            "amount": "1 ETH",
            "d": "M 280 187.62395692965987 Q 410.0666419935816 204.90598923241498 364.96050268725304 314.1716405038547",
            "from": "0x00000000000000000000000000000000000000w1",
            "ids": [
              "0xlab_s4:0",
            ],
            "key": "t4",
            "kind": "asset",
            "label": "5",
            "lx": 390.91248612138963,
            "ly": 215.96464628132506,
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
            "custody": null,
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
            "custody": null,
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
            "custody": null,
            "first": false,
            "id": "0x00000000000000000000000000000000000000w3",
            "lx": 177.4833395016046,
            "ly": 339.1880215351701,
            "middle": false,
            "x": 200,
            "y": 326.1880215351701,
          },
        ],
        "numbering": "history",
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

  it('sets middles around a lone holder, apart from it and from each other, and apart with no holder at all', () => {
    const apart = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    for (const [transfers, n] of [[[t(ZERO, a)], 3], [[], 2]] as const) {
      const nodes = layout(transfers, [], [b, x]).nodes;
      expect(nodes).toHaveLength(n);
      for (const [i, p] of nodes.entries()) for (const q of nodes.slice(i + 1)) expect(apart(p, q)).toBeGreaterThan(60);
    }
    // One middle too sits off the lone holder, not on it.
    const [h, m] = layout([t(ZERO, a)], [], [x]).nodes;
    expect(apart(h!, m!)).toBeGreaterThan(60);
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

  it('draws money only between wallets on the drawing, one arrow a payment with its amount', () => {
    const flow = (from: string, to: string, valueWei: string, kind: 'native' | 'token' = 'native') => ({ txHash: '0xf', kind, from, to, valueWei, token: '', blockNumber: 1, blockTime: 1 });
    const d = layout([t(ZERO, a), t(a, b)], [flow(b, a, '1500000000000000000'), flow(b, a, '2000000000000000000', 'token'), flow(b, '0x' + 'd'.repeat(40), '1')], []);
    const money = d.edges.filter((e) => e.kind === 'money');
    expect(money.map((e) => [e.key, e.label, e.amount, e.title])).toEqual([['p0', '', '1.5 ETH', '1.5 ETH paid'], ['p1', '', '2 WETH', '2 WETH paid']]);
    // Each its own arc of the pair's fan.
    expect(new Set(money.map((e) => e.d)).size).toBe(2);
  });

  it('draws each way’s payments as one arrow, with their count and sum, past what a fan can show', () => {
    const flow = (from: string, to: string, i: number) => ({ txHash: `0xf${i}`, kind: 'native' as const, from, to, valueWei: '1000000000000000000', token: '', blockNumber: i, blockTime: 1 });
    // One sale and six payments on the pair: seven arcs, past FAN_MAX. The one payment back stays its own arrow.
    const d = layout([t(ZERO, a), t(a, b)], [...Array.from({ length: 5 }, (_, i) => flow(b, a, i)), flow(a, b, 9)], []);
    const money = d.edges.filter((e) => e.kind === 'money');
    expect(money.map((e) => [e.key, e.label, e.amount, e.tx])).toEqual([[`m${b}>${a}`, '×5', '5 ETH', '0xf0'], ['p5', '', '1 ETH', '0xf9']]);
    expect(money[0]!.title).toBe('5 payments this way, 5 ETH in all');
  });

  it('names each reason’s arrows and wallets, and gives an arrow its trade and row', () => {
    const c = '0x' + 'd'.repeat(40);
    const one = { kind: 'scc' as const, wallets: [a, b], cycles: 2 };
    const two = { kind: 'pair' as const, pair: [b, c] as [string, string], middle: null, flowTx: '0xf' };
    const flow = { txHash: '0xf', kind: 'native' as const, from: b, to: c, valueWei: '1', token: '', blockNumber: 1, blockTime: 1 };
    const ts = [{ ...t(ZERO, a), txHash: '0xs0' }, { ...t(a, b, { A: one }), txHash: '0xs1' }, { ...t(b, a, { A: one }), txHash: '0xs2' }, { ...t(b, c, { AC: two }), txHash: '0xs3' }];
    const d = layout(ts, [flow], []);
    expect(d.loops.map((l) => l.key)).toEqual(['r0', 'r1']);
    expect(d.loops[0]!.methods).toEqual(['A']);
    expect(d.loops[0]!.edges).toEqual(['t1', 't2']);
    expect(d.loops[0]!.nodes).toEqual([a, b]);
    // The second reason, a direct pair, also takes the payment it used between its two wallets.
    expect(d.loops[1]!.edges).toEqual(['t3', 'p0']);
    const e = d.edges.find((x) => x.key === 't2')!;
    expect([e.tx, e.row]).toEqual(['0xs2', 3]);
    // A money arrow opens the payment it draws.
    expect(d.edges.find((x) => x.kind === 'money')).toMatchObject({ tx: '0xf', row: null });
  });

  it('gives each payment of a fan its own arrow, which opens it', () => {
    const flow = (txHash: string) => ({ txHash, kind: 'native' as const, from: b, to: a, valueWei: '1', token: '', blockNumber: 1, blockTime: 1 });
    const d = layout([t(ZERO, a), t(a, b)], [flow('0xf1'), flow('0xf2')], []);
    expect(d.edges.filter((e) => e.kind === 'money')).toMatchObject([{ key: 'p0', label: '', amount: '<0.0001 ETH', tx: '0xf1' }, { key: 'p1', tx: '0xf2' }]);
  });

  it('says what a sale paid on its arrow, in its currency, and nothing for a transfer no one paid for', () => {
    const sale = (priceWei: string, currency: string) => ({ ...t(a, b), marketplace: 'blur', priceWei, currency });
    const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const ts = [t(ZERO, a), sale('9000000000000000000', ''), sale('500000000000000000', WETH), sale('1250500000', USDC), sale('1', '0x' + '9'.repeat(40))];
    expect(layout(ts, [], []).edges.map((e) => [e.label, e.amount])).toEqual([['2', '9 ETH'], ['3', '0.5 WETH'], ['4', '1,250.5 USDC'], ['5', '? token']]);
    expect(layout([t(ZERO, a), t(a, b)], [], []).edges.map((e) => e.amount)).toEqual(['']);
  });

  it('sets a label off its line, further for a wider label beside a steep arc, and grows a ring’s fan outward, its first labels inside', () => {
    /** How far a label's centre is from its arc's middle (t = 0.5 of M x0 y0 Q cx cy x1 y1). */
    const near = (e: { d: string; lx: number; ly: number }) => {
      const v = (e.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      return Math.hypot(e.lx - (v[0]! + 2 * v[2]! + v[4]!) / 4, e.ly - (v[1]! + 2 * v[3]! + v[5]!) / 4);
    };
    // Two holders sit left and right: a level arc's label goes up or down by half its height and a gap, whatever its width.
    const level = layout([t(ZERO, a), t(a, b)], [], []).edges[0]!;
    // Measured from the drawn path's middle, which ends short of the wallet, so a px or so off the curve's own.
    expect(near(level)).toBeGreaterThan(7 + 3 - 1);
    expect(near(level)).toBeLessThan(7 + 3 + 1.5);
    // A ring's side is steep: a longer amount sets its label further off it.
    const dear = layout(LAB.map((x, i) => (i === 1 ? { ...x, priceWei: '10500000000000000000' } : x)), [], []).edges[0]!;
    const cheap = layout(LAB, [], []).edges[0]!;
    expect(dear.amount).toBe('10.5 ETH');
    expect(near(dear)).toBeGreaterThan(near(cheap) + 5);
    // A ring's side grows its fan outward, where there is room for it: its second arc (t4, beside t1) bows away from the centre.
    // Its first arcs' labels sit inside, on the side no arc of a fan grows toward; t3's would meet t1's by the top wallet, so it goes outside its own arc.
    const ring = layout(LAB, [], []);
    const control = (k: string) => { const v = (ring.edges.find((x) => x.key === k)!.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number); return Math.hypot(v[2]! - 280, v[3]! - 280); };
    expect(control('t4')).toBeGreaterThan(control('t1'));
    for (const k of ['t1', 't2']) {
      const e = ring.edges.find((x) => x.key === k)!;
      const [x0, y0] = [ring.nodes.find((n) => n.id === e.from)!, ring.nodes.find((n) => n.id === e.to)!].reduce((m, n) => [m[0]! + n.x / 2, m[1]! + n.y / 2], [0, 0]);
      expect(Math.hypot(e.lx - 280, e.ly - 280)).toBeLessThan(Math.hypot(x0! - 280, y0! - 280));
    }
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
      expect(e1).toMatchObject({ kind: 'money', tone: 'own', from: b, to: x, label: '', amount: '0.5 ETH', tx: null, row: null });
      expect(e2).toMatchObject({ kind: 'money', tone: 'own', from: x, to: a, label: '', amount: '? ETH' });
      expect(d.edges.filter((e) => e.kind === 'asset')).toHaveLength(1);
    });

    it('draws another token’s transfer solid with its number, and a funding dashed with its amount', () => {
      const path = [edge('nft-token', a, b, { tx: '0xs1', tokenId: '1' }), edge('nft-collection', b, y, { tx: '0xc9', tokenId: '9' }), edge('funds', y, a, { amountWei: '1234567000000000000', tx: '0xfund' })];
      const d = layout(ts, [], [], [own(path, [a, b, y])]);
      expect(d.nodes.find((n) => n.id === y)).toMatchObject({ middle: true });
      expect(d.edges.find((e) => e.key === 'o0e1')).toMatchObject({ kind: 'asset', tone: 'own', label: '#9', tx: '0xc9', row: null, token: '9' });
      // A funding names a payment too, but not one the console stores as a payment: no arrow opens it.
      expect(d.edges.find((e) => e.key === 'o0e2')).toMatchObject({ kind: 'money', tone: 'own', label: '', amount: '1.2345 ETH', tx: null });
    });

    it('opens the payment of an ETH, internal or WETH edge of a lens of yours, and nothing for another money edge', () => {
      const path = [
        edge('nft-token', a, b, { tx: '0xs1', tokenId: '1' }), edge('eth', b, x, { tx: '0xp1', amountWei: '1' }),
        edge('weth', x, y, { tx: '0xp2', amountWei: '1' }), edge('other-tokens', y, a, { tx: '0xp3', amountWei: '1', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }),
      ];
      const d = layout(ts, [], [], [own(path, [a, b, x, y])]);
      expect(['o0e1', 'o0e2', 'o0e3'].map((k) => d.edges.find((e) => e.key === k)!.tx)).toEqual(['0xp1', '0xp2', null]);
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
      expect(at('o0e1')).toMatchObject({ kind: 'money', amount: '1,250.5 USDC', title: '1,250.5 USDC paid, on a loop of a lens of yours' });
      expect(at('o0e2')).toMatchObject({ kind: 'money', amount: '3 APE', title: '3 APE funding the seller before the trade, on a loop of a lens of yours' });
      expect(at('o0e3')).toMatchObject({ kind: 'money', amount: '0.5 ETH', title: '0.5 ETH paid, on a loop of a lens of yours' });
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
  it('reasons come in the shown order, floor then ceiling then not counted, and loops keep their reason index', () => {
    // One transfer both Money loops back (AU) and Linked wallets (AC) flag, on different wallets: METHODS order would say AU first.
    const both = t(a, b, { AU: { kind: 'scc+flow', wallets: [a, b], cycles: 1, via: [] }, AC: { kind: 'pair', pair: [a, x], middle: null, flowTx: '0xf' } });
    const trs = [t(b, a, { A: { kind: 'scc', wallets: [a, b], cycles: 2 } }), both];
    const why = reasons(trs);
    expect(why.map((r) => r.methods)).toEqual([['A'], ['AC'], ['AU']]);
    const drawn = layout(trs, [], []).loops;
    expect(drawn.map((l) => l.methods)).toEqual(why.map((r) => r.methods));
    expect(drawn.map((l) => l.key)).toEqual(['r0', 'r1', 'r2']);
    // Same loop at each index: the pair's wallets are the AC loop's nodes.
    expect(drawn[1]!.nodes).toEqual([a, x]);
    expect(drawn[2]!.nodes).toEqual([a, b]);
  });
});

describe('layout numbering', () => {
  const y = '0x' + 'e'.repeat(40);
  const pair = { kind: 'pair' as const, pair: [a, b] as [string, string], middle: x, flowTx: '0xp1', shape: 'funder' as const };
  const sale = (from: string, to: string, block: number, logIndex: number, more: Partial<FlaggedTransfer> = {}): FlaggedTransfer =>
    ({ ...t(from, to, { AC: pair }), txHash: `0xs${block}${logIndex}`, blockNumber: block, logIndex, marketplace: 'blur', priceWei: '9000000000000000000', currency: '', ...more });
  const pay = (txHash: string, from: string, to: string, block: number, eth: number) =>
    ({ txHash, kind: 'native' as const, from, to, valueWei: `${eth}000000000000000000`, token: '', blockNumber: block, blockTime: 1 });

  it('by history, the default, numbers transfers as the token’s table does and leaves payments unnumbered, with a first holder', () => {
    const d = layout([t(ZERO, a), sale(a, b, 10, 0)], [pay('0xp1', x, a, 5, 1), pay('0xp2', x, b, 5, 10)], [x]);
    expect(d.numbering).toBe('history');
    expect(d.steps).toBeUndefined();
    expect(d.edges.map((e) => [e.key, e.label, e.amount])).toEqual([['t1', '2', '9 ETH'], ['p0', '', '1 ETH'], ['p1', '', '10 ETH']]);
    expect(d.nodes.find((n) => n.first)?.id).toBe(a);
  });

  it('by time, numbers the flagged sales and the payments in one sequence by block, with no first holder', () => {
    // The ring of the wireframe: the funder pays both sides at block 5, then the sale at block 10; a clean trade at 12 is drawn unnumbered.
    const ts = [sale(a, b, 10, 0), { ...t(b, a), txHash: '0xclean', blockNumber: 12 }];
    const d = layout(ts, [pay('0xp2', x, b, 5, 10), pay('0xp1', x, a, 5, 1)], [x], [], {}, { numbering: 'time' });
    expect(d.numbering).toBe('time');
    // In one block a payment has no place washtrace reads: block 5's two payments go by hash, so 0xp1 first.
    // Each step says its own amount, as its arrow's label does, for a list of them to say beside its number.
    expect(d.steps).toEqual([
      { n: 1, edge: 'p1', of: 'payment', index: 1, amount: '1 ETH' },
      { n: 2, edge: 'p0', of: 'payment', index: 0, amount: '10 ETH' },
      { n: 3, edge: 't0', of: 'transfer', index: 0, amount: '9 ETH' },
    ]);
    const at = (key: string) => d.edges.find((e) => e.key === key)!;
    expect([at('p1').label, at('p0').label, at('t0').label, at('t1').label]).toEqual(['1', '2', '3', '']);
    expect(at('p1')).toMatchObject({ amount: '1 ETH', title: '1: 1 ETH paid' });
    expect(at('t0').title).toBe('3: sale of #1 on Blur · flagged');
    expect(at('t1').title).toBe('transfer of #1');
    expect(d.nodes.some((n) => n.first)).toBe(false);
  });

  it('by time, puts a block’s sales before its payments, sales by log index, and names no token in the number of several', () => {
    const ts = [sale(a, b, 7, 4, { tokenId: '114' }), sale(b, a, 7, 2, { tokenId: '9' })];
    const d = layout(ts, [pay('0xp0', x, a, 7, 1), pay('0xp9', x, b, 6, 1)], [x], [], {}, { numbering: 'time' });
    expect(d.steps!.map((s) => s.edge)).toEqual(['p1', 't1', 't0', 'p0']);
    expect(d.edges.filter((e) => e.kind === 'asset').map((e) => e.label)).toEqual(['3', '2']);
    expect(d.edges.find((e) => e.key === 't1')!.title).toBe('2: sale of #9 on Blur · flagged');
  });

  it('by time, a bundle carries its count, and each payment it holds keeps its place in the sequence, naming it', () => {
    const many = Array.from({ length: 7 }, (_, i) => pay(`0xp${i}`, y, a, i + 1, 1));
    const d = layout([sale(a, b, 100, 0)], many, [y], [], {}, { numbering: 'time' });
    expect(d.edges.find((e) => e.key === `m${y}>${a}`)).toMatchObject({ label: '×7', amount: '7 ETH' });
    expect(d.steps!.map((s) => [s.n, s.edge])).toEqual([...many.map((_, i) => [i + 1, `m${y}>${a}`]), [8, 't0']]);
    // A bundled payment's step keeps its own amount, not the bundle's sum.
    expect(d.steps!.map((s) => s.amount)).toEqual([...many.map(() => '1 ETH'), '9 ETH']);
  });
});

describe('layout of Money loops back’s path', () => {
  const [h1, h2, h3] = [w('h1'), w('h2'), w('h3')];
  // #113's shape: a sold to b, and b paid a back through three other wallets.
  const loop = { kind: 'scc+flow' as const, wallets: [b, a], cycles: 1, via: [[b, a]] as [string, string][], paths: [{ wallets: [b, h1, h2, h3, a], txs: ['0x1a', '0x1b', '0x1c', '0x1d'] }] };
  const pay = (txHash: string, from: string, to: string) => ({ txHash, kind: 'native' as const, from, to, valueWei: '1000000000000000000', token: '', blockNumber: 2, blockTime: 1 });
  const steps = [pay('0x1a', b, h1), pay('0x1b', h1, h2), pay('0x1c', h2, h3), pay('0x1d', h3, a)];

  it('draws the wallets on the path inside, and lights the loop’s path, its steps and wallets', () => {
    const d = layout([t(ZERO, a), t(a, b, { AU: loop })], steps, [h1, h2, h3]);
    expect(d.nodes.filter((n) => n.middle).map((n) => n.id)).toEqual([h1, h2, h3]);
    const lit = d.loops[0]!;
    expect(lit.nodes).toEqual([b, a, h1, h2, h3]);
    expect(lit.edges).toEqual(['t1', 'p0', 'p1', 'p2', 'p3']);
  });

  it('sets a pair’s three or more middles in a row above it, from the holder the path starts at, every label clear of the others', () => {
    const d = layout([t(ZERO, a), t(a, b, { AU: loop })], steps, [h1, h2, h3]);
    const [na, nb] = [d.nodes.find((n) => n.id === a)!, d.nodes.find((n) => n.id === b)!];
    const hops = [h1, h2, h3].map((id) => d.nodes.find((n) => n.id === id)!);
    for (const h of hops) expect(h.y).toBeLessThan(na.y - 60);
    // b, on the right, pays h1: the row runs right to left, so the path reads across without doubling back.
    expect(nb.x).toBeGreaterThan(na.x);
    expect(hops.map((h) => h.x)).toEqual([...hops.map((h) => h.x)].sort((p, q) => q - p));
    // No two wallet labels (68 px of text, 16 high) overlap.
    const boxes = d.nodes.map((n) => ({ x0: n.anchor === 'end' ? n.lx - 68 : n.anchor === 'start' ? n.lx : n.lx - 34, y: n.ly }));
    for (const [i, p] of boxes.entries()) for (const q of boxes.slice(i + 1)) expect(Math.abs(p.x0 - q.x0) >= 68 || Math.abs(p.y - q.y) >= 16).toBe(true);
  });

  it('lights only the path’s steps, not another payment among its wallets', () => {
    // h2 paid h1 too: on the drawing, but no step of the path.
    const d = layout([t(ZERO, a), t(a, b, { AU: loop })], [...steps, pay('0x2a', h2, h1)], [h1, h2, h3]);
    expect(d.edges.some((e) => e.key === 'p4')).toBe(true);
    expect(d.loops[0]!.edges).not.toContain('p4');
  });

  it('lights its payment back for a loop saved before paths were', () => {
    const old = { kind: 'scc+flow' as const, wallets: [b, a], cycles: 1, via: [[b, a]] as [string, string][] };
    const d = layout([t(ZERO, a), t(a, b, { AU: old })], [pay('0xback', b, a)], []);
    expect(d.loops[0]!.nodes).toEqual([b, a]);
    expect(d.loops[0]!.edges).toEqual(['t1', 'p0']);
  });

  it('lights only its via legs for a loop saved before paths were, not another payment among its wallets', () => {
    // a paid b too: among the loop's wallets, but no leg of its money back, so its card does not list it.
    const old = { kind: 'scc+flow' as const, wallets: [b, a], cycles: 1, via: [[b, a]] as [string, string][] };
    const d = layout([t(ZERO, a), t(a, b, { AU: old })], [pay('0xback', b, a), pay('0xfwd', a, b)], []);
    expect(d.edges.some((e) => e.key === 'p1')).toBe(true);
    expect(d.loops[0]!.edges).toEqual(['t1', 'p0']);
  });
});

describe('layout of Linked wallets’ payments', () => {
  const m = w('m1');
  const pair = { kind: 'pair' as const, pair: [a, b] as [string, string], middle: m, flowTx: '0xf1' };
  const pay = (txHash: string, from: string, to: string) => ({ txHash, kind: 'native' as const, from, to, valueWei: '1000000000000000000', token: '', blockNumber: 2, blockTime: 1 });

  it('lights a pair’s legs through its middle, not a direct payment between seller and buyer', () => {
    // a paid b directly: drawn, but no leg of a pair through m, so evidencePayments leaves it out and so does the loop.
    const d = layout([t(ZERO, a), t(a, b, { AC: pair })], [pay('0xf1', m, a), pay('0xf2', b, m), pay('0xd', a, b)], [m]);
    const direct = d.edges.find((e) => e.kind === 'money' && e.from === a && e.to === b)!;
    expect(direct).toBeDefined();
    const lit = d.loops[0]!;
    expect(lit.methods).toEqual(['AC']);
    expect(lit.edges).not.toContain(direct.key);
    expect(lit.edges.filter((k) => k.startsWith('p'))).toHaveLength(2);
    expect(lit.nodes).toEqual([a, b, m]);
  });
});

/** Points along an arrow's path (M x0 y0 Q cx cy x1 y1, or a self-loop's M x y C c1, c2, x y), half a px or so apart. */
// Sampled once a path: the sweep measures every arc against every label.
const sampled = new Map<string, [number, number][]>();
function along(d: string): [number, number][] {
  const known = sampled.get(d);
  if (known !== undefined) return known;
  const v = (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
  const pts = Array.from({ length: 401 }, (_, i): [number, number] => {
    const s = i / 400, u = 1 - s;
    if (d.includes('C')) return [u ** 3 * v[0]! + 3 * u * u * s * v[2]! + 3 * u * s * s * v[4]! + s ** 3 * v[6]!, u ** 3 * v[1]! + 3 * u * u * s * v[3]! + 3 * u * s * s * v[5]! + s ** 3 * v[7]!];
    return [u * u * v[0]! + 2 * u * s * v[2]! + s * s * v[4]!, u * u * v[1]! + 2 * u * s * v[3]! + s * s * v[5]!];
  });
  sampled.set(d, pts);
  return pts;
}
/** A drawn label's glyph box, 10 px mono at 6 px a character and 10 px high, about its centre. */
function glyphBox(e: ReturnType<typeof layout>['edges'][number]) {
  // As drawn: an amount layout left to the title (amountHidden) is not on the graph.
  const paid = e.amountHidden ? '' : e.amount;
  const text = e.label && paid ? `${e.label} · ${paid}` : e.label || paid;
  const hw = (text.length * 6) / 2;
  return { text, x0: e.lx - hw, x1: e.lx + hw, y0: e.ly - 5, y1: e.ly + 5 };
}
type Box = { x0: number; x1: number; y0: number; y1: number };
/** How far a point is from a box, 0 inside it. */
const gapTo = (b: Box, x: number, y: number) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
const inside = (b: Box, x: number, y: number) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
/** The box round an arrow's sampled path, once a path. */
const bounded = new Map<string, Box>();
function boundsOf(d: string): Box {
  const known = bounded.get(d);
  if (known !== undefined) return known;
  const pts = along(d), xs = pts.map(([x]) => x), ys = pts.map(([, y]) => y);
  const b = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  bounded.set(d, b);
  return b;
}
/** Each label an arc runs through. Only an arc whose bounds meet the label's box is sampled. */
function strikes(d: ReturnType<typeof layout>): string[] {
  return d.edges.flatMap((e) => {
    const g = glyphBox(e);
    if (g.text === '') return [];
    const meets = (b: Box) => b.x0 < g.x1 && g.x0 < b.x1 && b.y0 < g.y1 && g.y0 < b.y1;
    return d.edges.filter((o) => meets(boundsOf(o.d)) && along(o.d).some(([x, y]) => inside(g, x, y))).map((o) => `${e.key} "${g.text}" struck by ${o.key}`);
  });
}
/**
 * Each label an arc runs through, and each another arc comes nearer than its own, to its centre or to its box: read
 * beside the nearest line, it would name that line's amount.
 */
function misattributed(d: ReturnType<typeof layout>): string[] {
  return [...strikes(d), ...d.edges.flatMap((e) => {
    const g = glyphBox(e);
    if (g.text === '') return [];
    const box = (o: typeof e) => Math.min(...along(o.d).map(([x, y]) => gapTo(g, x, y)));
    const centre = (o: typeof e) => Math.min(...along(o.d).map(([x, y]) => Math.hypot(x - e.lx, y - e.ly)));
    const own = { box: box(e), centre: centre(e) };
    // As layout's own check reaches: an arc whose bounds are own.centre + hw + 5 from the label's centre is nearer by
    // neither measure, its every point being further from the centre than that, and from the box than own.centre (≥ own.box).
    const reach = own.centre + (g.x1 - g.x0) / 2 + 5;
    return d.edges.filter((o) => o !== e && gapTo(boundsOf(o.d), e.lx, e.ly) < reach && (centre(o) < own.centre || box(o) < own.box)).map((o) => `${e.key} "${g.text}" nearer ${o.key}`);
  })];
}
/** Each wallet an arc runs over that it does not join: inside its circle (9 px) and a stroke. */
function crossings(d: ReturnType<typeof layout>): string[] {
  return d.nodes.flatMap((n) => d.edges.filter((e) => e.from !== n.id && e.to !== n.id && gapTo(boundsOf(e.d), n.x, n.y) < 11
    && along(e.d).some(([x, y]) => Math.hypot(x - n.x, y - n.y) < 11)).map((e) => `wallet ${n.id.slice(-2)} crossed by ${e.key}`));
}
/** A wallet's name as drawn: 68 px of 10 px mono, `half` px either side of its line. */
const nameOf = (n: ReturnType<typeof layout>['nodes'][number], half: number): Box => {
  const x0 = n.anchor === 'end' ? n.lx - 68 : n.anchor === 'start' ? n.lx : n.lx - 34;
  return { x0, x1: x0 + 68, y0: n.ly - half, y1: n.ly + half };
};
/** Each label set on a wallet or on a wallet's name. */
function onWallets(d: ReturnType<typeof layout>): string[] {
  const meets = (p: Box, q: Box) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;
  return d.edges.flatMap((e) => {
    const g = glyphBox(e);
    if (g.text === '') return [];
    return d.nodes.filter((n) => meets(g, { x0: n.x - 10, x1: n.x + 10, y0: n.y - 10, y1: n.y + 10 }) || meets(g, nameOf(n, 6))).map((n) => `${e.key} "${g.text}" on wallet ${n.id.slice(-2)}`);
  });
}
/** Each name of a wallet in between that an arc runs through. */
function middleNamesStruck(d: ReturnType<typeof layout>): string[] {
  return d.nodes.filter((n) => n.middle).flatMap((n) => {
    const b = nameOf(n, 6);
    return d.edges.filter((e) => along(e.d).some(([x, y]) => inside(b, x, y))).map((e) => `name ${n.id.slice(-2)} struck by ${e.key}`);
  });
}
/** The box round what is drawn: each wallet and its name, each arc's sampled curve and each label as drawn. */
function contentOf(d: ReturnType<typeof layout>): Box {
  const boxes = [
    ...d.nodes.flatMap((n) => [{ x0: n.x - 10, x1: n.x + 10, y0: n.y - 10, y1: n.y + 10 }, nameOf(n, 8)]),
    ...d.edges.flatMap((e) => {
      const g = glyphBox(e);
      return [boundsOf(e.d), ...(g.text === '' ? [] : [{ ...g, y0: e.ly - 7, y1: e.ly + 7 }])];
    }),
  ];
  return { x0: Math.min(...boxes.map((b) => b.x0)), x1: Math.max(...boxes.map((b) => b.x1)), y0: Math.min(...boxes.map((b) => b.y0)), y1: Math.max(...boxes.map((b) => b.y1)) };
}

describe('a label stays with its own arrow', () => {
  const [A, B, C, D, M, N, O] = [w('a1'), w('b1'), w('c1'), w('d1'), w('e1'), w('f1'), w('99')];
  const loopOf = (wallets: string[]) => ({ A: { kind: 'scc' as const, wallets, cycles: 2 } });
  const sale = (i: number, from: string, to: string, flags: FlaggedTransfer['flags'], priceWei = '12345000000000000000'): FlaggedTransfer =>
    ({ ...t(from, to, flags), txHash: `0xs${i}`, blockNumber: 10 + i, marketplace: 'blur', priceWei, currency: '' });
  const pay = (i: number, from: string, to: string, valueWei: string) => ({ txHash: `0xf${i}`, kind: 'native' as const, from, to, valueWei, token: '', blockNumber: 50 + i, blockTime: 0 });
  const pairOf = (n: number, oneWay = false) => Array.from({ length: n }, (_, i) => sale(i, oneWay || i % 2 === 0 ? A : B, oneWay || i % 2 === 0 ? B : A, loopOf([A, B])));
  const s = (i: number, from: string, to: string) => sale(i, from, to, loopOf([A, B, C]), '9000000000000000000');
  const one = [s(1, A, B), s(2, B, C), s(3, C, A)];
  const two = [...one, s(4, A, B), s(5, B, C), s(6, C, A)];
  const three = [...two, s(7, B, A), s(8, C, B), s(9, A, C)];
  const funded = { AC: { kind: 'pair' as const, pair: [A, B] as [string, string], middle: C, flowTx: '0xf1' } };
  const [h1, h2, h3] = [w('h1'), w('h2'), w('h3')];
  const loop = { kind: 'scc+flow' as const, wallets: [B, A], cycles: 1, via: [[B, A]] as [string, string][], paths: [{ wallets: [B, h1, h2, h3, A], txs: ['0x1a', '0x1b', '0x1c', '0x1d'] }] };
  const big = '12345600000000000000';
  const cases: [string, ReturnType<typeof layout>][] = [
    ...Array.from({ length: FAN_MAX - 1 }, (_, i): [string, ReturnType<typeof layout>] => [`pair of ${i + 2}`, layout(pairOf(i + 2), [], [])]),
    ...Array.from({ length: FAN_MAX - 1 }, (_, i): [string, ReturnType<typeof layout>] => [`pair of ${i + 2} one way`, layout(pairOf(i + 2, true), [], [])]),
    ['pair with payments both ways', layout(pairOf(2), [pay(1, B, A, '10500000000000000000'), pay(2, A, B, '1000000000000000000')], [])],
    ['pair by time', layout(pairOf(2), [pay(1, B, A, '10500000000000000000')], [], [], {}, { numbering: 'time' })],
    ['triangle, 1 a side', layout(one, [], [])],
    ['triangle, 2 a side', layout(two, [], [])],
    ['triangle, 3 a side', layout(three, [], [])],
    ['the lab', layout(LAB, [], [])],
    ['a funder', layout([sale(1, A, B, funded, '9000000000000000000')], [pay(1, C, A, '1000000000000000000'), pay(2, C, B, '2000000000000000000'), pay(3, C, A, '3000000000000000000')], [C])],
    ['#113’s row', layout([t(ZERO, A), sale(1, A, B, { AU: loop }, '1230000000000000000')], [pay(1, B, h1, big), pay(2, h1, h2, big), pay(3, h2, h3, big), pay(4, h3, A, big)], [h1, h2, h3])],
    ['a self-loop', layout([sale(1, A, B, loopOf([A, B])), sale(2, B, B, loopOf([A, B])), sale(3, B, A, loopOf([A, B]))], [], [])],
    ['two self-loops on one wallet', layout([sale(1, A, B, loopOf([A, B])), sale(2, B, B, loopOf([A, B])), sale(3, B, A, loopOf([A, B])), sale(4, B, B, loopOf([A, B])), sale(5, A, B, loopOf([A, B]))], [], [])],
    // The same pair with 9 ETH prices: its kept spots are measured as every label is, price apart.
    ['pair with payments both ways, short', layout(pairOf(2).map((x) => ({ ...x, priceWei: '9000000000000000000' })), [pay(1, B, A, '10500000000000000000'), pay(2, A, B, '1000000000000000000')], [])],
    ['pair of 4 with payments both ways', layout(pairOf(4), [pay(1, B, A, '10500000000000000000'), pay(2, A, B, '1000000000000000000')], [])],
    ['pair of 6 with payments both ways', layout(pairOf(6), [pay(1, B, A, '10500000000000000000'), pay(2, A, B, '1000000000000000000')], [])],
    ...[1, 2].map((k): [string, ReturnType<typeof layout>] => [`triangle, ${k} a side, a funder paying each`, layout(
      [[A, B], [B, C], [C, A]].flatMap(([f, to], j) => Array.from({ length: k }, (_, m) => sale(j * 10 + m, f!, to!, { ...loopOf([A, B, C]), AC: { kind: 'pair', pair: [f!, to!], middle: M, flowTx: '0xf1' } }, '9000000000000000000'))),
      [pay(1, M, A, '1000000000000000000'), pay(2, M, B, '2000000000000000000'), pay(3, M, C, '3000000000000000000')], [M])]),
    ...[1, 2].map((k): [string, ReturnType<typeof layout>] => [`square, ${k} a side, payees inside`, layout(
      [[A, B], [B, C], [C, D], [D, A]].flatMap(([f, to], j) => Array.from({ length: k }, (_, m) => sale(j * 10 + m, f!, to!, loopOf([A, B, C, D]), '9000000000000000000'))),
      [pay(1, A, M, '1000000000000000000'), pay(2, M, C, '1000000000000000000'), pay(3, B, N, '2000000000000000000'), pay(4, N, D, '2000000000000000000')], [M, N])]),
  ];

  it('every label is nearer its own arc than any other, to its centre and to its box, and no arc runs through one', () => {
    expect(cases.flatMap(([name, d]) => misattributed(d).map((m) => `${name}: ${m}`))).toEqual([]);
  });

  it('a label is at its own spot beside its arc, as layout first set it, or moved only where its own arc is nearer by OWN_MARGIN', () => {
    /**
     * The spot layout sets a label of half-width `hw` beside its arc before clearing, on its own side only: rebuilt from
     * the drawing, the arc's middle between its two wallets and its control point, out by half the label's extent and the gap.
     */
    const ownSpots = (d: ReturnType<typeof layout>, e: (typeof d.edges)[number], hw: number) => {
      const v = (e.d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
      const a = d.nodes.find((n) => n.id === e.from)!, b = d.nodes.find((n) => n.id === e.to)!;
      let mx: number, my: number, nx: number, ny: number;
      if (e.d.includes('C')) {
        [mx, my] = [(v[2]! + v[4]!) / 2, (v[3]! + v[5]!) / 2];
        const l = Math.hypot(mx - a.x, my - a.y);
        [nx, ny] = [(mx - a.x) / l, (my - a.y) / l];
      } else {
        [mx, my] = [(a.x + 2 * v[2]! + b.x) / 4, (a.y + 2 * v[3]! + b.y) / 4];
        const l = Math.hypot(b.x - a.x, b.y - a.y);
        [nx, ny] = [-(b.y - a.y) / l, (b.x - a.x) / l];
        // Its own side: a fan's first arc (bowed MID_BOW, 8 px) puts its label on the side away from its bow, every later one (36 px or more) beyond it.
        const bow = (mx - (a.x + b.x) / 2) * nx + (my - (a.y + b.y) / 2) * ny;
        const side = Math.abs(bow) < 20 ? -Math.sign(bow) : Math.sign(bow);
        [nx, ny] = [nx * side, ny * side];
      }
      const out = hw * Math.abs(nx) + 7 * Math.abs(ny) + 3;
      return [mx + nx * out, my + ny * out] as const;
    };
    const count = { unmoved: 0, moved: 0 };
    const offOwn = (d: ReturnType<typeof layout>) => d.edges.flatMap((e) => {
      const g = glyphBox(e);
      if (g.text === '') return [];
      const [x, y] = ownSpots(d, e, (g.text.length * 6) / 2);
      const unmoved = Math.abs(x - e.lx) < 1e-6 && Math.abs(y - e.ly) < 1e-6;
      count[unmoved ? 'unmoved' : 'moved'] += 1;
      if (unmoved) return [];
      const box = (o: typeof e) => Math.min(...along(o.d).map(([x, y]) => Math.hypot(Math.max(g.x0 - x, 0, x - g.x1), Math.max(g.y0 - y, 0, y - g.y1))));
      const centre = (o: typeof e) => Math.min(...along(o.d).map(([x, y]) => Math.hypot(x - e.lx, y - e.ly)));
      const near = d.edges.filter((o) => o !== e && (centre(o) < centre(e) + OWN_MARGIN || box(o) < box(e) + OWN_MARGIN));
      return near.map((o) => `${e.key} "${g.text}" moved, ${o.key} within OWN_MARGIN`);
    });
    expect(cases.flatMap(([name, d]) => offOwn(d).map((m) => `${name}: ${m}`))).toEqual([]);
    // Not vacuous: the rebuilt spot is the one layout set for most labels, and some were moved off it.
    expect(count.unmoved).toBeGreaterThan(count.moved);
    expect(count.moved).toBeGreaterThan(0);
  });

  it('drops an amount that fits beside no arc of its own, keeping its number by its arc, and says the amount in its title', () => {
    const d = cases.find(([n]) => n === 'pair of 4 with payments both ways')![1];
    const hidden = d.edges.filter((e) => e.amountHidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const e of hidden) {
      expect(e.amount).not.toBe('');
      expect(e.title.endsWith(` · ${e.amount}`)).toBe(true);
    }
    // Where the whole label fits, none is dropped.
    for (const [name, x] of cases.filter(([n]) => /^pair of 2$|^triangle, 1 a side$|^the lab$|^a funder$|#113/.test(n))) expect(x.edges.some((e) => e.amountHidden), name).toBe(false);
  });

  it('places no label, and keeps no room for one, past LABELLED_MAX wallets, where none is drawn', () => {
    const crowd = (price: string | null) => Array.from({ length: LABELLED_MAX + 1 }, (_, i) => ({ ...t(w(`k${i}`), w(`k${(i + 1) % (LABELLED_MAX + 1)}`)), marketplace: 'blur', priceWei: price, currency: '' }));
    const [cheap, dear] = [layout(crowd('1'), [], []), layout(crowd('12345600000000000000'), [], [])];
    expect(dear.view).toEqual(cheap.view);
  });

  it('sets a ring’s lone middle at its centre, its name clear of the payments that run out from it', () => {
    for (const n of [3, 4, 5]) {
      const ws = Array.from({ length: n }, (_, i) => w(`m${i}`));
      const d = layout(ws.map((from, j) => sale(j, from, ws[(j + 1) % n]!, loopOf(ws))), ws.map((to, j) => pay(j, M, to, '1000000000000000000')), [M]);
      const m = d.nodes.find((x) => x.id === M)!;
      expect([m.x, m.y]).toEqual([280, 280]);
      const x0 = m.anchor === 'end' ? m.lx - 68 : m.anchor === 'start' ? m.lx : m.lx - 34;
      const hits = d.edges.filter((e) => along(e.d).some(([x, y]) => x > x0 && x < x0 + 68 && Math.abs(y - m.ly) < 7)).map((e) => e.key);
      expect(hits, `ring of ${n}`).toEqual([]);
    }
  });

  it('no arc strikes any label, in every case above', () => {
    expect(cases.flatMap(([name, d]) => strikes(d).map((m) => `${name}: ${m}`))).toEqual([]);
  });

  // The sweep: rings of 3 to 8 wallets with up to FAN_MAX sales a side, either way, short or long; the same with a funder
  // inside paying each holder, and with two or three wallets inside, at 1 to 4 a side, paid amounts that are not round.
  // The widest goes to the first holder, at the top: its payment from a funder at the centre runs straight up, where the
  // ring's two sides close in on a label set beside it.
  const ODD = ['750000000000000000', '1500000000000000000', '3250000000000000000'];
  const PRICES = [['short', '9000000000000000000'], ['long', '12345000000000000000']] as const;
  const ringOf = (n: number) => Array.from({ length: n }, (_, i) => w(`r${i}`));
  const ringSales = (ws: string[], k: number, alternating: boolean, priceWei: string) => ws.flatMap((from, j) => Array.from({ length: k }, (_, m) => {
    const to = ws[(j + 1) % ws.length]!, back = alternating && m % 2 === 1;
    return sale(j * 10 + m, back ? to : from, back ? from : to, loopOf(ws), priceWei);
  }));
  const sweep: [string, ReturnType<typeof layout>][] = [];
  for (const n of [3, 4, 5, 6, 8]) for (let k = 1; k <= FAN_MAX; k++) for (const way of ['alternating', 'one way']) for (const [size, priceWei] of PRICES) {
    sweep.push([`ring of ${n}, ${k} a side, ${way}, ${size}`, layout(ringSales(ringOf(n), k, way === 'alternating', priceWei), [], [])]);
  }
  for (const n of [3, 4, 5, 6, 8]) for (const k of [1, 2, 3, 4]) for (const [size, priceWei] of PRICES) {
    const ws = ringOf(n);
    sweep.push([`ring of ${n}, ${k} a side, a funder paying each, ${size}`, layout(ringSales(ws, k, true, priceWei), ws.map((to, j) => pay(j, M, to, ODD[j % 3]!)), [M])]);
  }
  // A funder paying each holder a long amount, "12.3456 ETH" (11 characters). Not the widest a payment label gets: amount
  // keeps 4 places, so any WETH payment of 10 or more ("12.3456 WETH"), "<0.0001 WETH" and "123.4567 ETH" are 12.
  for (const n of [3, 4, 5, 6, 8]) for (const k of [1, 2, 3, 4]) {
    const ws = ringOf(n);
    sweep.push([`ring of ${n}, ${k} a side, a funder paying 12.3456 ETH each`, layout(ringSales(ws, k, true, '9000000000000000000'), ws.map((to, j) => pay(j, M, to, '12345600000000000000')), [M])]);
  }
  // A funder paying each holder and paid back by each: two spokes to every holder, a fan of two.
  for (const n of [3, 4, 5, 6, 8]) for (const k of [1, 2, 3, 4]) {
    const ws = ringOf(n);
    const both = ws.flatMap((h, j) => [pay(2 * j, M, h, ODD[j % 3]!), pay(2 * j + 1, h, M, ODD[(j + 1) % 3]!)]);
    sweep.push([`ring of ${n}, ${k} a side, a funder paying each and paid back by each`, layout(ringSales(ws, k, true, '12345000000000000000'), both, [M])]);
  }
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const payWeth = (i: number, from: string, to: string, valueWei: string) => ({ ...pay(i, from, to, valueWei), kind: 'token' as const, token: WETH });
  for (const n of [4, 5, 6, 8]) for (const k of [1, 2, 3, 4]) for (const [size, priceWei] of PRICES) {
    const ws = ringOf(n);
    const relays = [pay(1, ws[0]!, M, ODD[0]!), pay(2, M, ws[2]!, ODD[0]!), pay(3, ws[1]!, N, ODD[1]!), pay(4, N, ws[3]!, ODD[1]!)];
    sweep.push([`ring of ${n}, ${k} a side, two relays, ${size}`, layout(ringSales(ws, k, true, priceWei), relays, [M, N])]);
    // And a third wallet inside, paying the first holder.
    sweep.push([`ring of ${n}, ${k} a side, three middles, ${size}`, layout(ringSales(ws, k, true, priceWei), [...relays, pay(5, O, ws[0]!, ODD[2]!)], [M, N, O])]);
  }
  // Two relays paying "12.3456 WETH" (12 characters) at each step.
  for (const n of [4, 5, 6, 8]) for (const k of [1, 2, 3, 4]) {
    const ws = ringOf(n), v = '12345600000000000000';
    const relays = [payWeth(1, ws[0]!, M, v), payWeth(2, M, ws[2]!, v), payWeth(3, ws[1]!, N, v), payWeth(4, N, ws[3]!, v)];
    sweep.push([`ring of ${n}, ${k} a side, two relays paying 12.3456 WETH`, layout(ringSales(ws, k, true, '9000000000000000000'), relays, [M, N])]);
  }

  /**
   * Combinations the geometry cannot keep every label with its own arrow, every arc off the wallets it does not join
   * and every middle's name clear, within FAN_MAX and LABELLED_MAX, each with what was measured. A combination that
   * starts passing must leave this list, and every key must name a combination of the sweep. Both entries are crowded
   * rings, the funder's or relays' payments filling the inside. Measured past the sweep: a triangle whose funder pays each
   * a 12-character amount ("12.3456 WETH", "123.4567 ETH", "<0.0001 WETH") has its top payment's label struck by a side,
   * the ring too small for so wide a label beside a spoke running straight up; two relays paying "12.3456 WETH" on a
   * pentagon, 2 to 4 a side, set one payment's label on a sale's label, which no check here counts; and a fan's outer
   * arcs cross a holder's name, under the name's halo, which no check here counts either.
   *
   * Each entry records what each check found on it, as the sweep counts them (one per strike or nearer arc, so a label
   * both struck by and nearer another arrow counts twice): a count past it is a regression, and one under it means the
   * entry is to be tightened.
   */
  type Limit = { why: string; misattributed: number; crossings: number; onWallets: number; names: number };
  const CHECKS = [['misattributed', misattributed], ['crossings', crossings], ['onWallets', onWallets], ['names', middleNamesStruck]] as const;
  const backAndForth = (n: number, ks: number[], limit: Limit) => Object.fromEntries(ks.map((k) => [`ring of ${n}, ${k} a side, a funder paying each and paid back by each`, limit]));
  const known: Record<string, Limit> = {
    // A funder paying each holder and paid back by each: two spokes to every holder, so 2n payments run out from the centre.
    ...backAndForth(3, [1], { why: 'the funder\'s name is struck by p3, a spoke back from the second holder: on a triangle all 6 spokes cut every spot round it', misattributed: 0, crossings: 0, onWallets: 0, names: 1 }),
    ...backAndForth(3, [2, 3, 4], { why: '2 labels misattributed: p1 "1.5 ETH" struck by and nearer the top side\'s first sale (t0), p3 "3.25 ETH" nearer a side\'s sale; and the funder\'s name struck by p3', misattributed: 3, crossings: 0, onWallets: 0, names: 1 }),
    ...backAndForth(4, [1, 2, 3, 4], { why: 'the funder\'s name is struck by p3, of the 8 spokes; every label is its own arrow\'s', misattributed: 0, crossings: 0, onWallets: 0, names: 1 }),
    ...backAndForth(5, [1, 2, 3, 4], { why: 'the funder\'s name is struck by 3 of the 10 spokes (p4, p5, p6); every label is its own arrow\'s', misattributed: 0, crossings: 0, onWallets: 0, names: 3 }),
    ...backAndForth(6, [1, 2, 3, 4], { why: '2 labels misattributed: p0 and p6 "0.75 ETH" are each struck by and nearer a neighbouring holder\'s spoke (p11, p5), spokes to neighbours 60° apart; and the funder\'s name struck by p7 and p8', misattributed: 4, crossings: 0, onWallets: 0, names: 2 }),
    ...backAndForth(8, [1, 2, 3, 4], { why: '7 of 16 payment labels misattributed: each struck by and nearer a neighbouring spoke (p0/p15, p2/p1, p6/p5, p8/p7, p9/p10, p10/p9, p14/p13), 16 spokes leaving under 23° between neighbours; the funder\'s name is clear', misattributed: 14, crossings: 0, onWallets: 0, names: 0 }),
    // Two relays paying 12-character amounts on a square: their payments cross inside it.
    ...Object.fromEntries([2, 3, 4].map((k) => [`ring of 4, ${k} a side, two relays paying 12.3456 WETH`, {
      why: '1 label misattributed: p1 "12.3456 WETH" (the first relay to the third holder) is struck by and nearer p2 (the second holder to the second relay), where the two cross, and sits on that relay\'s wallet',
      misattributed: 2, crossings: 0, onWallets: 1, names: 0 }])),
  };

  it('names in `known` only combinations of the sweep, so a stale entry cannot pass unseen', () => {
    const names = new Set(sweep.map(([name]) => name));
    expect(Object.keys(known).filter((name) => !names.has(name))).toEqual([]);
    expect(Object.keys(known)).toHaveLength(23);
  });

  it('keeps every label with its own arrow, every arc off the wallets it does not join, and the names inside clear, on every ring of the sweep', () => {
    const found: string[] = [], passed: string[] = [], worse: string[] = [], tighter: string[] = [];
    for (const [name, d] of sweep) {
      const wrong = CHECKS.flatMap(([, check]) => check(d));
      const limit = known[name];
      if (wrong.length > 0 && limit === undefined) found.push(`${name}: ${wrong.join('; ')}`);
      if (wrong.length === 0 && limit !== undefined) passed.push(name);
      if (limit === undefined) continue;
      for (const [check, measure] of CHECKS) {
        const n = measure(d).length, was = limit[check];
        if (n > was) worse.push(`${name}: ${check} ${n}, recorded ${was}`);
        if (n < was) tighter.push(`${name}: ${check} ${n}, recorded ${was}`);
      }
    }
    expect(found).toEqual([]);
    // A known limit that no longer holds is taken off the list.
    expect(passed).toEqual([]);
    // A known combination gets no worse on any check; one that got better has its entry tightened to what it is now.
    expect(worse).toEqual([]);
    expect(tighter).toEqual([]);
  });

  it('draws each drawing in the box round what it draws, its curves as drawn, not their control points', () => {
    const loose = [...cases, ...sweep].flatMap(([name, d]) => {
      const c = contentOf(d), v = d.view;
      // Everything inside the view, and the view no more than its 12 px pad (and a px) round everything.
      const holds = v.x <= c.x0 && v.y <= c.y0 && v.x + v.w >= c.x1 && v.y + v.h >= c.y1;
      const tight = v.w <= c.x1 - c.x0 + 25 && v.h <= c.y1 - c.y0 + 25;
      return holds && tight ? [] : [`${name}: view ${v.w.toFixed(0)}×${v.h.toFixed(0)} against ${(c.x1 - c.x0).toFixed(0)}×${(c.y1 - c.y0).toFixed(0)} drawn`];
    });
    expect(loose).toEqual([]);
  });
});

