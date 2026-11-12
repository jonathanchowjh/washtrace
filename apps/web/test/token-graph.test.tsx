import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlaggedTransfer } from '@washtrace/detect';
import { layout } from '@/lib/layout';
import { LensGraph, LoopFigure, RingTrail, TokenLoops } from '@/components/token-graph';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const A = '0x1', B = '0x2', C = '0x3';
const scc = (wallets: string[]) => ({ kind: 'scc' as const, wallets, cycles: 2 });
const t = (from: string, to: string, tx: string, flags: FlaggedTransfer['flags'] = {}): FlaggedTransfer =>
  ({ txHash: tx, logIndex: 0, blockNumber: 1, blockTime: null, tokenId: '1', from, to, marketplace: null, priceWei: null, currency: null, flags });

// Two reasons: A and B pass it back and forth (rows 2-3, Round trips), then B and C (row 4, Linked wallets).
const transfers = [t('0x0000000000000000000000000000000000000000', A, '0xs0'), t(A, B, '0xs1', { A: scc([A, B]) }), t(B, A, '0xs2', { A: scc([A, B]) }), t(B, C, '0xs3', { AC: scc([B, C]) })];
const d = layout(transfers, [], []);
const items = d.loops.map((l) => ({ key: l.key, body: <span>why {l.key} <a href="/w/1/0x1">0x1</a></span>, meta: <span>rows</span> }));
const rowHrefs = { 2: '?page=1#t2', 3: '?show=flagged#t3', 4: '#t4' };

const show = (initial: Parameters<typeof TokenLoops>[0]['initial'] = null) =>
  render(<TokenLoops drawing={d} chainId={1} items={items} initial={initial} rowHrefs={rowHrefs} />);
const litKeys = () => [...document.querySelectorAll('[data-lit]')].map((e) => e.getAttribute('data-edge')).sort();

beforeEach(() => push.mockClear());
afterEach(cleanup);

describe('the token graph', () => {
  it('a why line’s toggle lights its loop and dims the rest', () => {
    show();
    expect(litKeys()).toEqual([]);
    const toggle = screen.getAllByRole('button', { name: /Show in graph/ })[0]!;
    fireEvent.click(toggle);
    expect(litKeys()).toEqual([...d.loops[0]!.edges].sort());
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-edge="t3"]')?.getAttribute('class')).toContain('opacity-25');
    expect(document.querySelector('[data-edge="t1"]')?.getAttribute('class') ?? '').not.toContain('opacity-25');
    fireEvent.click(toggle);
    expect(litKeys()).toEqual([]);
  });

  it('a toggle’s name includes its line’s text', () => {
    show();
    expect(screen.getByRole('button', { name: /Show in graph.*why r1/ })).toBeTruthy();
  });

  it('the svg is a group, not an image, so the wallets inside it stay buttons', () => {
    show();
    const svg = document.querySelector('svg[aria-label]')!;
    expect(svg.getAttribute('role')).toBe('group');
    expect(svg.getAttribute('role')).not.toBe('img');
  });

  it('a why line has no link inside a button', () => {
    show();
    expect(document.querySelectorAll('button a').length).toBe(0);
    expect(document.querySelectorAll('li a').length).toBe(2);
  });

  it('a wallet lights its edges on the first click and opens on the second', () => {
    show();
    const c = screen.getByRole('button', { name: /^Wallet 0x3/ });
    fireEvent.click(c);
    expect(push).not.toHaveBeenCalled();
    expect(litKeys()).toEqual(['t3']);
    fireEvent.click(c);
    expect(push).toHaveBeenCalledWith('/w/1/0x3');
  });

  it('a wallet acts on Enter and on Space, and can take focus', () => {
    show();
    const c = screen.getByRole('button', { name: /^Wallet 0x1/ });
    expect(c.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(c, { key: 'Enter' });
    expect(litKeys()).toEqual(['t1', 't2']);
    fireEvent.keyDown(c, { key: ' ' });
    expect(push).toHaveBeenCalledWith('/w/1/0x1');
  });

  it('picking a wallet clears a lit loop, and the other way round', () => {
    show({ loop: 'r1' });
    expect(litKeys()).toEqual(['t3']);
    fireEvent.click(screen.getByRole('button', { name: /^Wallet 0x1/ }));
    expect(litKeys()).toEqual(['t1', 't2']);
    fireEvent.click(screen.getAllByRole('button', { name: /Show in graph/ })[1]!);
    expect(litKeys()).toEqual(['t3']);
  });

  it('an arrow opens its trade; its number links to the server’s href for that row', () => {
    show();
    // The click lands on the wider invisible path; the visible one is not the target.
    const hit = document.querySelector('[data-edge="t2"] path[stroke="transparent"]')!;
    expect(hit.getAttribute('stroke-width')).toBe('12');
    fireEvent.click(hit);
    expect(push).toHaveBeenCalledWith('/tx/1/0xs2');
    const label = (n: string) => [...document.querySelectorAll('svg a')].find((a) => a.textContent === n)?.getAttribute('href');
    expect(label('2')).toBe(rowHrefs[2]);
    expect(label('3')).toBe(rowHrefs[3]);
    expect(label('4')).toBe(rowHrefs[4]);
  });

  it('?loop lights that loop on arrival, and ?method every loop of that lens', () => {
    show({ loop: 'r1' });
    expect(litKeys()).toEqual(['t3']);
    cleanup();
    show({ method: 'A' });
    expect(litKeys()).toEqual([...d.loops[0]!.edges].sort());
    cleanup();
    show({ method: 'AC' });
    expect(litKeys()).toEqual(['t3']);
    cleanup();
    show({ loop: 'nope' });
    expect(litKeys()).toEqual([]);
  });

  it('says a payment’s amount on its arrow and in its title, and opens the payment it draws, under the collection’s tabs', () => {
    const flow = { txHash: '0xf', kind: 'native' as const, from: A, to: C, valueWei: '1000000000000000000', token: '', blockNumber: 1, blockTime: 1 };
    const withMoney = layout(transfers, [flow], []);
    render(<TokenLoops drawing={withMoney} chainId={1} base="/c/1/0xcoll" items={[]} initial={null} rowHrefs={rowHrefs} />);
    const g = document.querySelector('[data-edge="p0"]')!;
    expect(g.querySelector('title')?.textContent).toBe('1 ETH paid');
    expect(document.querySelector('[data-label="p0"] text')?.textContent).toBe('1 ETH');
    expect(g.querySelector('a')?.getAttribute('aria-label')).toBe('Open the payment: 1 ETH paid');
    fireEvent.click(g.querySelector('a path')!);
    expect(push).toHaveBeenCalledWith('/c/1/0xcoll/tx/0xf');
  });

  it('names a bundle of payments by its first, as a bundle of trades is', () => {
    const flow = (txHash: string) => ({ txHash, kind: 'native' as const, from: A, to: C, valueWei: '1000000000000000000', token: '', blockNumber: 1, blockTime: 1 });
    render(<TokenLoops drawing={layout(transfers, Array.from({ length: 7 }, (_, i) => flow(`0xf${i}`)), [])} chainId={1} base="/c/1/0xcoll" items={[]} initial={null} rowHrefs={rowHrefs} />);
    const g = document.querySelector(`[data-edge="m${A}>${C}"]`)!;
    expect(g.querySelector('a')?.getAttribute('aria-label')).toBe('Open the first payment: 7 payments this way, 7 ETH in all');
    expect(document.querySelector(`[data-label="m${A}>${C}"] text`)?.textContent).toBe('×7 · 7 ETH');
  });

  it('draws a sale’s number and price as one label, the number still opening its row', () => {
    const priced = transfers.map((x, i) => (i === 1 ? { ...x, marketplace: 'blur', priceWei: '9000000000000000000', currency: '' } : x));
    render(<TokenLoops drawing={layout(priced, [], [])} chainId={1} items={[]} initial={null} rowHrefs={rowHrefs} />);
    const text = document.querySelector('[data-label="t1"] text')!;
    expect(text.textContent).toBe('2 · 9 ETH');
    expect(text.querySelector('a')?.textContent).toBe('2');
    expect(text.querySelector('a')?.getAttribute('href')).toBe(rowHrefs[2]);
  });
});

describe('the figure alone', () => {
  // A lens of yours's loop on row 2: back from B to A through another token of the collection.
  const own = { lensId: 7, collectionId: 1, txHash: '0xs1', logIndex: 0, wallets: [A, B], path: [
    { from: A, to: B, kind: 'nft-token' as const, tx: '0xs1', time: null, amountWei: null, tokenId: '1', token: null },
    { from: B, to: A, kind: 'nft-collection' as const, tx: '0xc9', time: null, amountWei: null, tokenId: '9', token: null },
  ] };
  const drawn = layout(transfers, [], [], [own]);
  const loop = drawn.loops.find((l) => l.key === 'o0')!;

  it('links its wallets, its trades and another token’s number, with no buttons, as a server page draws it', () => {
    render(<LoopFigure drawing={drawn} chainId={1} base="/c/1/0xc" lit={{ edges: loop.edges, nodes: loop.nodes }} />);
    const href = (sel: string) => document.querySelector(sel)?.closest('a')?.getAttribute('href');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // Drawn for a collection, its wallets and trades open under that collection's tabs.
    expect(screen.getByRole('link', { name: /^Wallet 0x3/ }).getAttribute('href')).toBe('/c/1/0xc/w/0x3');
    expect(href('[data-edge="t2"] path[stroke="transparent"]')).toBe('/c/1/0xc/tx/0xs2');
    expect(href('[data-edge="o0e1"] path[stroke="transparent"]')).toBe('/c/1/0xc/tx/0xc9');
    expect([...document.querySelectorAll('svg text a')].find((a) => a.textContent === '#9')?.getAttribute('href')).toBe('/c/1/0xc/t/9');
    expect(litKeys()).toEqual(['o0e1', 't1']);
    expect(document.querySelector('[data-edge="t3"]')?.getAttribute('class')).toContain('opacity-25');
    expect(document.querySelector('[data-edge="o0e1"] path')?.getAttribute('class')).toBe('stroke-flow');
  });
});

describe('a trade no built-in flagged, on a loop of a lens of yours', () => {
  // A and B pass the token back and forth once: too few cycles for Round trips, but Fast flips's loop on row 2 comes back through row 3.
  const clean = [t('0x0000000000000000000000000000000000000000', A, '0xs0'), t(A, B, '0xs1'), t(B, A, '0xs2'), t(A, C, '0xs3')];
  const own = { lensId: 7, collectionId: 1, txHash: '0xs1', logIndex: 0, wallets: [A, B], path: [
    { from: A, to: B, kind: 'nft-token' as const, tx: '0xs1', time: null, amountWei: null, tokenId: '1', token: null },
    { from: B, to: A, kind: 'nft-token' as const, tx: '0xs2', time: null, amountWei: null, tokenId: '1', token: null },
  ] };
  const drawn = layout(clean, [], [], [own], { L7: { name: 'Fast flips', tone: 'own', says: '' } });
  const loop = drawn.loops.find((l) => l.key === 'o0')!;

  it('is drawn in your lens’s hue, says whose loop it is, and the legend never calls it not flagged', () => {
    render(<LoopFigure drawing={drawn} chainId={1} base="" lit={{ edges: loop.edges, nodes: loop.nodes }} />);
    expect(loop.edges.sort()).toEqual(['t1', 't2']);
    for (const k of ['t1', 't2']) expect(document.querySelector(`[data-edge="${k}"] path`)?.getAttribute('class')).toBe('stroke-flow');
    expect(document.querySelector('[data-edge="t1"] title')?.textContent).toBe('#2 transfer · not flagged by a built-in lens; on a loop of Fast flips');
    const legend = [...document.querySelectorAll('figcaption span')].map((s) => s.textContent);
    expect(legend).toContain('not flagged by a built-in lens, on a loop of Fast flips');
    // Row 4, on no loop, is the only arrow the plain swatch stands for.
    expect(legend).toContain('not flagged');
    expect(document.querySelector('[data-edge="t3"] path')?.getAttribute('class')).toBe('stroke-clean');
  });
});

describe('the arrows’ links', () => {
  const tradeLinks = () => [...document.querySelectorAll('svg a[data-tx]')];
  const ping = Array.from({ length: 8 }, (_, i) => t(i % 2 === 0 ? A : B, i % 2 === 0 ? B : A, `0xp${i}`, { A: scc([A, B]) }));

  it('each says what it opens, from its arrow’s title, in lens names', () => {
    render(<LoopFigure drawing={d} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    const names = tradeLinks().map((a) => a.getAttribute('aria-label'));
    expect(names).toEqual(['Open the trade: #2 transfer · flagged', 'Open the trade: #3 transfer · flagged', 'Open the trade: #4 transfer · flagged']);
    cleanup();
    // A bundle opens the first of its transfers, and says so.
    render(<LoopFigure drawing={layout(ping, [], [])} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    for (const a of tradeLinks()) expect(a.getAttribute('aria-label')).toMatch(/^Open the first trade: 4 transfers this way/);
    for (const a of tradeLinks()) expect(a.getAttribute('aria-label')).not.toMatch(/\b(A|AU|AC|L\d+)\b/);
  });

  it('stay out of the tab order: the table’s rows are the keyboard’s way to a trade, as before', () => {
    show();
    expect(tradeLinks().length).toBeGreaterThan(0);
    for (const a of tradeLinks()) expect(a.getAttribute('tabindex')).toBe('-1');
  });
});

describe('the graph on a phone', () => {
  it('is drawn no narrower than 0.8 of its size below sm, scrolling in its own box, so its 10 px labels stay 8 px or more', () => {
    const c = render(<LoopFigure drawing={d} chainId={1} lit={{ edges: [], nodes: [] }} base="" />).container;
    const svg = c.querySelector<SVGSVGElement>('figure svg')!;
    expect(svg.parentElement!.className).toBe('overflow-x-auto');
    expect(svg.getAttribute('class')).toContain('max-sm:min-w-(--figure-min)');
    expect(svg.style.getPropertyValue('--figure-min')).toBe(`${Math.round(d.view.w * 0.8)}px`);
    // From sm it fits its column as before: full width, never wider than drawn.
    expect(svg.getAttribute('class')).toContain('w-full');
    expect(svg.style.maxWidth).toBe(`${Math.round(d.view.w)}px`);
    // The legend stays put, outside the scrolling box.
    expect(c.querySelector('figure > figcaption')).not.toBeNull();
  });
});

describe('the numbers on the arrows', () => {
  const legend = () => [...document.querySelectorAll('figcaption span')].map((s) => s.textContent);

  it('say their rule in the legend: one token’s place from its first transfer, several tokens’ each under its token', () => {
    render(<LoopFigure drawing={d} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    expect(legend()).toContain('numbered from the token’s first transfer');
    cleanup();
    const several = layout([{ ...t(A, B, '0xs1'), n: 2 }, { ...t(B, A, '0xs2'), tokenId: '9', n: 4 }], [], []);
    render(<LoopFigure drawing={several} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    expect([...document.querySelectorAll('svg text')].map((x) => x.textContent)).toContain('#9·4');
    expect(legend()).toContain('#token·n: that token’s transfer n, counted from its first');
  });

  it('are not explained when none is drawn: a bundle carries a count', () => {
    const ping = Array.from({ length: 14 }, (_, i) => t(i % 2 === 0 ? A : B, i % 2 === 0 ? B : A, `0xp${i}`));
    render(<LoopFigure drawing={layout(ping, [], [])} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    expect(legend().some((x) => x?.includes('numbered'))).toBe(false);
  });
});

describe('the legend', () => {
  const legend = () => [...document.querySelectorAll('figcaption > span')].map((s) => s.textContent);
  const M = '0x9', BLEND = '0x29469395eaf6f95920e59f858042f0e28d98a20b';
  const pair = { kind: 'pair' as const, pair: [B, C] as [string, string], middle: M, flowTx: '0xf', shape: 'funder' as const };
  const pay = { txHash: '0xf', kind: 'native' as const, from: M, to: B, valueWei: '1000000000000000000', token: '', blockNumber: 1, blockTime: 1 };
  // Every kind of thing drawn, given in the reverse of the legend's order.
  const all = [t('0x0000000000000000000000000000000000000000', A, '0xs0'), t(A, BLEND, '0xs1'), t(BLEND, A, '0xs2'), t(A, C, '0xs3', { AU: { kind: 'scc+flow', wallets: [A, C], cycles: 1, via: [] } }),
    t(B, C, '0xs4', { AC: pair }), t(A, B, '0xs5', { A: scc([A, B]) })];

  it('keys what is drawn in one fixed order, under the picture and left-aligned', () => {
    const c = render(<LoopFigure drawing={layout(all, [pay], [M])} chainId={1} base="" lit={{ edges: [], nodes: [] }} />).container;
    expect(legend()).toEqual([
      'Round trips · the floor', 'Linked wallets · the ceiling', 'Money loops back only, not counted', 'not flagged',
      'payment a lens used', 'wallet', 'first holder', 'in between, funder or payee: joined by money only',
      'custody (Blur Blend): holds the token, does not own it', 'numbered from the token’s first transfer',
    ]);
    expect(c.querySelector('figure > figcaption')!.className).toContain('justify-start');
  });

  it('names only what is drawn: no payment, no wallet key without a wallet in between to tell apart', () => {
    render(<LoopFigure drawing={d} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    expect(legend()).toEqual(['Round trips · the floor', 'Linked wallets · the ceiling', 'first holder', 'numbered from the token’s first transfer']);
  });

  it('says a drawing numbered by time counts sales and payments together by block, and has no first holder', () => {
    const drawn = layout([{ ...t(B, C, '0xs4', { AC: pair }), blockNumber: 5 }], [pay], [M], [], {}, { numbering: 'time' });
    render(<LoopFigure drawing={drawn} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    expect(legend()).toEqual(['Linked wallets · the ceiling', 'payment a lens used', 'wallet', 'in between, funder or payee: joined by money only',
      'numbered in block order, sales and payments together; in one block, its transfers first']);
    // The numbers themselves: the payment at block 1 is 1, the sale 2.
    expect([...document.querySelectorAll('svg text tspan.font-semibold')].map((x) => x.textContent)).toEqual(['2', '1']);
  });

  it('keys the wallets inside truly when a lens of yours drew one: not every one is joined by money', () => {
    // Row 2's loop of a lens of yours goes back through another token's transfer to Y, which no payment joins.
    const Y = '0x8';
    const own = { lensId: 7, collectionId: 1, txHash: '0xs1', logIndex: 0, wallets: [A, B, Y], path: [
      { from: A, to: B, kind: 'nft-token' as const, tx: '0xs1', time: null, amountWei: null, tokenId: '1', token: null },
      { from: B, to: Y, kind: 'nft-collection' as const, tx: '0xc9', time: null, amountWei: null, tokenId: '9', token: null },
      { from: Y, to: A, kind: 'eth' as const, tx: '0xe1', time: null, amountWei: '1', tokenId: null, token: null },
    ] };
    render(<LoopFigure drawing={layout(transfers, [], [], [own])} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    expect(legend()).toContain('never held this token: joined by money, or on a loop of a lens of yours');
    expect(legend()).not.toContain('in between, funder or payee: joined by money only');
    cleanup();
    // With none of yours drawn, the wallets inside are the built-ins' middles alone.
    render(<LoopFigure drawing={layout(all, [pay], [M])} chainId={1} base="" lit={{ edges: [], nodes: [] }} />);
    expect(legend()).toContain('in between, funder or payee: joined by money only');
    expect(legend()).not.toContain('never held this token: joined by money, or on a loop of a lens of yours');
  });

  it('draws every label after every line, so no arc is drawn over one', () => {
    const c = render(<LoopFigure drawing={layout(all, [pay], [M])} chainId={1} base="" lit={{ edges: [], nodes: [] }} />).container;
    const order = [...c.querySelectorAll('svg > g[data-edge], svg > g[data-label]')].map((g) => (g.hasAttribute('data-edge') ? 'line' : 'label'));
    expect(order.indexOf('label')).toBeGreaterThan(order.lastIndexOf('line'));
    expect(c.querySelector('[data-edge] text')).toBeNull();
  });

  it('draws a wallet in between as the dashed wallet of money alone, and a holder solid', () => {
    const c = render(<LoopFigure drawing={layout(all, [pay], [M])} chainId={1} base="" lit={{ edges: [], nodes: [] }} />).container;
    const ring = (id: string) => c.querySelector(`a[aria-label="Wallet ${id}"] circle`)!;
    expect(ring(M).getAttribute('stroke-dasharray')).toBe('3 2');
    expect(ring(M).getAttribute('class')).toContain('stroke-flow');
    expect(ring(B).getAttribute('stroke-dasharray')).toBeNull();
  });
});

describe('a label on a crowded fan', () => {
  const sale = (i: number, from: string, to: string, flags: FlaggedTransfer['flags'] = { A: scc([A, B]) }): FlaggedTransfer =>
    ({ ...t(from, to, `0xs${i}`, flags), blockNumber: 10 + i, marketplace: 'blur', priceWei: '12345000000000000000', currency: '' });
  const pay = (i: number, from: string, to: string, valueWei: string) => ({ txHash: `0xf${i}`, kind: 'native' as const, from, to, valueWei, token: '', blockNumber: 50 + i, blockTime: 0 });

  it('is drawn after every line, the one that runs under it included, and names its arrow on hover', () => {
    // Layout keeps every label of its fixtures clear, so the one an arc runs under is set by hand: t1's label sits on t0's straight line.
    const base = layout([sale(1, A, B), sale(2, B, A)], [], []);
    const [t0, t1] = [base.edges.find((e) => e.key === 't0')!, base.edges.find((e) => e.key === 't1')!];
    const [x0, y0, , , x1, y1] = (t0.d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
    const drawn = { ...base, edges: [{ ...t0, d: `M ${x0} ${y0} Q ${(x0! + x1!) / 2} ${(y0! + y1!) / 2} ${x1} ${y1}` }, { ...t1, lx: (x0! + x1!) / 2, ly: (y0! + y1!) / 2 }] };
    // Struck, as the fixture must be: a point of t0's path, sampled along it, lies inside t1's label's glyph box.
    const v = drawn.edges[0]!.d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)!.map(Number), label = drawn.edges[1]!;
    const hw = (`${label.label} · ${label.amount}`.length * 6) / 2;
    const onPath = Array.from({ length: 101 }, (_, i) => {
      const s = i / 100, u = 1 - s;
      return [u * u * v[0]! + 2 * u * s * v[2]! + s * s * v[4]!, u * u * v[1]! + 2 * u * s * v[3]! + s * s * v[5]!] as const;
    });
    expect(onPath.some(([x, y]) => Math.abs(x - label.lx) < hw && Math.abs(y - label.ly) < 5)).toBe(true);
    const c = render(<LoopFigure drawing={drawn} chainId={1} base="" lit={{ edges: [], nodes: [] }} />).container;
    const all = [...c.querySelectorAll('svg > g[data-edge], svg > g[data-label]')];
    const at = (sel: string) => all.indexOf(c.querySelector(sel)!);
    expect(at('[data-label="t1"]')).toBeGreaterThan(at('[data-edge="t0"]'));
    for (const e of drawn.edges) expect(at(`[data-label="${e.key}"]`), e.key).toBeGreaterThan(Math.max(...drawn.edges.map((o) => at(`[data-edge="${o.key}"]`))));
    expect(c.querySelector('[data-label="t1"] title')?.textContent).toBe(c.querySelector('[data-edge="t1"] title')?.textContent);
  });

  it('draws only the number of a label whose amount fits beside no arc of its own, and its title says the amount', () => {
    const drawn = layout([1, 2, 3, 4].map((i) => sale(i, i % 2 ? A : B, i % 2 ? B : A)), [pay(1, B, A, '10500000000000000000'), pay(2, A, B, '1000000000000000000')], []);
    const e = drawn.edges.find((x) => x.amountHidden)!;
    const c = render(<LoopFigure drawing={drawn} chainId={1} base="" lit={{ edges: [], nodes: [] }} />).container;
    expect(c.querySelector(`[data-label="${e.key}"] text`)?.textContent).toBe(e.label);
    expect(c.querySelector(`[data-label="${e.key}"] title`)?.textContent).toMatch(/ · 12\.345 ETH$/);
  });

  it('on a trade page, with no table to link to, opens the trade from a number whose amount is hidden, and every number names its amount', () => {
    const drawn = layout([1, 2, 3, 4].map((i) => sale(i, i % 2 ? A : B, i % 2 ? B : A)), [pay(1, B, A, '10500000000000000000'), pay(2, A, B, '1000000000000000000')], []);
    const e = drawn.edges.find((x) => x.amountHidden)!;
    const caught = [{ key: 'A' as const, name: 'Round trips', loop: drawn.loops[0]! }];
    render(<LensGraph drawing={drawn} chainId={1} base="/c/1/0xc" ctx={{ method: 'A' }} tokenHref="/c/1/0xc/t/1" caught={caught} />);
    const link = document.querySelector(`[data-label="${e.key}"] a`)!;
    expect(link.getAttribute('href')).toBe(`/c/1/0xc/tx/${e.tx}?method=A`);
    expect(link.getAttribute('aria-label')).toBe(`Arrow ${e.label}: 12.345 ETH`);
    cleanup();
    // On the token page a number opens its row, and says its amount too.
    render(<TokenLoops drawing={drawn} chainId={1} items={[]} initial={null} rowHrefs={{ 1: '#t1', 2: '#t2', 3: '#t3', 4: '#t4' }} />);
    const row = document.querySelector('[data-label="t0"] a')!;
    expect(row.getAttribute('href')).toBe('#t1');
    expect(row.getAttribute('aria-label')).toBe('Arrow 1: 12.345 ETH');
  });
});

describe('a page’s main graph', () => {
  it('is drawn at least `min` wide where its box has room, never past 1.6 of its own size', () => {
    const svg = () => document.querySelector<SVGSVGElement>('figure svg')!;
    // A loop of three is drawn 520 wide, under 1.6 of its size.
    expect(d.view.w).toBeLessThan(520);
    render(<LoopFigure drawing={d} chainId={1} base="" lit={{ edges: [], nodes: [] }} min={520} />);
    expect(svg().style.maxWidth).toBe('520px');
    cleanup();
    // A two-wallet strip stops at 1.6 of its size, so its 10 px labels read at 16 px or less.
    const strip = layout([t(A, B, '0xs1'), t(B, A, '0xs2')], [], []);
    expect(strip.view.w * 1.6).toBeLessThan(520);
    render(<LoopFigure drawing={strip} chainId={1} base="" lit={{ edges: [], nodes: [] }} min={520} />);
    expect(svg().style.maxWidth).toBe(`${Math.round(strip.view.w * 1.6)}px`);
    cleanup();
    // The token page asks it of its graph; the phone's floor is still its own size's.
    show();
    expect(svg().style.maxWidth).toBe('520px');
    expect(svg().style.getPropertyValue('--figure-min')).toBe(`${Math.round(d.view.w * 0.8)}px`);
  });
});

describe('a trade page’s graph', () => {
  const caught = [{ key: 'A' as const, name: 'Round trips', loop: d.loops[0]! }];

  it('marks the arrow of the trade it is about, undimmed, and says so in the legend and the arrow’s name', () => {
    render(<LensGraph drawing={d} chainId={1} base="" tokenHref="/t/1" caught={caught} transfer={{ txHash: '0xs2', logIndex: 0 }} />);
    expect([...document.querySelectorAll('[data-mark]')].map((e) => e.getAttribute('data-edge'))).toEqual(['t2']);
    expect(document.querySelector('[data-edge="t2"]')!.getAttribute('class') ?? '').not.toContain('opacity-25');
    expect(document.querySelector('[data-edge="t2"] a')!.getAttribute('aria-label')).toBe('Open the trade: #3 transfer · flagged · this trade');
    expect([...document.querySelectorAll('figcaption span')].map((s) => s.textContent)).toContain('this trade');
  });

  it('marks the bundle that holds the trade, and nothing without one', () => {
    const ping = Array.from({ length: 14 }, (_, i) => t(i % 2 === 0 ? A : B, i % 2 === 0 ? B : A, `0xp${i}`, { A: scc([A, B]) }));
    const bundled = layout(ping, [], []);
    render(<LensGraph drawing={bundled} chainId={1} base="" tokenHref="/t/1" caught={[{ key: 'A', name: 'Round trips', loop: bundled.loops[0]! }]} transfer={{ txHash: '0xp5', logIndex: 0 }} />);
    expect([...document.querySelectorAll('[data-mark]')].map((e) => e.getAttribute('data-edge'))).toEqual([`b${B}>${A}`]);
    cleanup();
    render(<LensGraph drawing={d} chainId={1} base="" tokenHref="/t/1" caught={caught} />);
    expect(document.querySelector('[data-mark]')).toBeNull();
    expect([...document.querySelectorAll('figcaption span')].map((s) => s.textContent)).not.toContain('this trade');
  });
});

describe('a graph wider than its box', () => {
  // jsdom lays nothing out: give the box a phone's width, the drawing twice that, and the svg its drawn width.
  const wide = (svgWidth: number) => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 300; } });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return svgWidth; } });
    const rect = SVGElement.prototype.getBoundingClientRect;
    SVGElement.prototype.getBoundingClientRect = () => ({ width: svgWidth } as DOMRect);
    return () => {
      // Own properties over Element's: deleting them leaves jsdom's.
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      SVGElement.prototype.getBoundingClientRect = rect;
    };
  };

  it('opens scrolled to the lit loop, not its left edge', () => {
    const restore = wide(d.view.w);
    try {
      // The A and B reason, right of the drawing's middle: its wallets' middle is put in the box's.
      const loop = d.loops[0]!;
      const c = render(<LoopFigure drawing={d} chainId={1} base="" lit={{ edges: loop.edges, nodes: loop.nodes }} />).container;
      const xs = d.nodes.filter((n) => loop.nodes.includes(n.id)).map((n) => n.x);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      expect(c.querySelector<HTMLElement>('figure > div')!.scrollLeft).toBe(Math.round(mid) - d.view.x - 150);
      expect(mid).toBeGreaterThan(d.view.x + d.view.w / 2 + 10);
    } finally { restore(); }
  });

  it('opens on the arrow it marks, before what is lit', () => {
    const restore = wide(d.view.w);
    try {
      const c = render(<LoopFigure drawing={d} chainId={1} base="" lit={{ edges: d.loops[0]!.edges, nodes: d.loops[0]!.nodes }} mark="0xs3:0" />).container;
      const arrow = d.edges.find((e) => e.key === 't3')!;
      expect(c.querySelector<HTMLElement>('figure > div')!.scrollLeft).toBe(Math.max(0, Math.round(arrow.lx) - d.view.x - 150));
    } finally { restore(); }
  });

  it('opens at its middle with nothing lit', () => {
    const restore = wide(d.view.w);
    try {
      const c = render(<LoopFigure drawing={d} chainId={1} base="" lit={{ edges: [], nodes: [] }} />).container;
      expect(c.querySelector<HTMLElement>('figure > div')!.scrollLeft).toBe(Math.max(0, Math.round(d.view.x + d.view.w / 2) - d.view.x - 150));
    } finally { restore(); }
  });
});

describe('a ring’s trail', () => {
  // A sold to B, then B back to A: numbered by time, each a row of the trail.
  const ring = layout([t(A, B, '0xr1', { A: scc([A, B]) }), { ...t(B, A, '0xr2', { A: scc([A, B]) }), blockNumber: 2 }], [], [], [], {}, { numbering: 'time' });
  const rows = ring.steps!.map((s) => ({ key: `s${s.n}`, edge: s.edge, nodes: [A, B] as [string, string], body: <span>step {s.n}</span>, href: `/tx/1/${s.n}`, open: `Open ${s.n}` }));
  const trail = () => render(<RingTrail drawing={ring} chainId={1} base="" rows={rows} rowHrefs={{}} edgeHrefs={{ t0: '/c/1/0xc/tx/0xr1?method=A' }} label="A ring" />).container;
  const lit = (c: Element) => [...c.querySelectorAll('g[data-lit]')].map((g) => g.getAttribute('data-edge'));
  const buttons = (c: Element) => c.querySelectorAll('section[aria-label="In order"] button');

  it('lights a row’s arrow while it is hovered or focused, and pins it on a press, which aria-pressed says', () => {
    const c = trail();
    const [first, second] = [buttons(c)[0]!, buttons(c)[1]!];
    expect(lit(c)).toEqual([]);
    fireEvent.mouseEnter(second);
    expect(lit(c)).toEqual(['t1']);
    fireEvent.mouseLeave(second);
    expect(lit(c)).toEqual([]);
    fireEvent.focus(second);
    expect(lit(c)).toEqual(['t1']);
    fireEvent.blur(second);
    expect(lit(c)).toEqual([]);
    expect(second.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(second);
    expect(second.getAttribute('aria-pressed')).toBe('true');
    expect(lit(c)).toEqual(['t1']);
    // The other row's arrow dims; its two wallets stay lit.
    expect(c.querySelector('g[data-edge=t0]')!.getAttribute('class')).toContain('opacity-25');
    expect(c.querySelector(`a[aria-label="Wallet ${A}"]`)!.getAttribute('class')).not.toContain('opacity-25');
    // Hovering another row shows it while the pin waits; leaving it brings the pin back.
    fireEvent.mouseEnter(first);
    expect(lit(c)).toEqual(['t0']);
    fireEvent.mouseLeave(first);
    expect(lit(c)).toEqual(['t1']);
    fireEvent.click(second);
    expect(second.getAttribute('aria-pressed')).toBe('false');
    expect(lit(c)).toEqual([]);
  });

  it('keeps a keyboard-focused row lit while the mouse passes over another and leaves', () => {
    const c = trail();
    const [first, second] = [buttons(c)[0]!, buttons(c)[1]!];
    fireEvent.focus(second);
    fireEvent.mouseEnter(first);
    expect(lit(c)).toEqual(['t0']);
    fireEvent.mouseLeave(first);
    expect(lit(c)).toEqual(['t1']);
    fireEvent.blur(second);
    expect(lit(c)).toEqual([]);
  });

  it('a mouse press that un-pins a row leaves it unlit once the mouse leaves, though the press focused it', () => {
    const c = trail();
    const second = buttons(c)[1]!;
    // As a browser orders a click: the press, the focus it gives, then the click.
    const press = () => { fireEvent.mouseEnter(second); fireEvent.mouseDown(second); fireEvent.focus(second); fireEvent.mouseUp(second); fireEvent.click(second); };
    press();
    expect(second.getAttribute('aria-pressed')).toBe('true');
    fireEvent.mouseLeave(second);
    expect(lit(c)).toEqual(['t1']);
    fireEvent.mouseDown(second); fireEvent.mouseUp(second); fireEvent.click(second);
    fireEvent.mouseLeave(second);
    expect(second.getAttribute('aria-pressed')).toBe('false');
    expect(lit(c)).toEqual([]);
    // A keyboard's focus after it still lights the row.
    fireEvent.blur(second);
    fireEvent.focus(second);
    expect(lit(c)).toEqual(['t1']);
  });

  it('a press dragged off a focused row, so no click comes, still lets the next keyboard focus light its row', () => {
    const c = trail();
    const [first, second] = buttons(c);
    fireEvent.focus(first!);
    // The press lands on the row that has focus already, so no focus event follows; the pointer leaves before it lifts.
    fireEvent.mouseEnter(first!); fireEvent.mouseDown(first!); fireEvent.mouseLeave(first!);
    fireEvent.blur(first!);
    fireEvent.focus(second!);
    expect(lit(c)).toEqual(['t1']);
  });

  it('gives its trailing link a finger’s target, 44 px at least each way', () => {
    const link = trail().querySelector('section[aria-label="In order"] li a')!;
    expect(link.className).toContain('min-w-11');
    expect(link.className).toContain('min-h-11');
  });

  it('opens each row’s sale by its trailing link, never the row, and an arrow by the link its page gave it', () => {
    const c = trail();
    const li = c.querySelectorAll('section[aria-label="In order"] li')[0]!;
    expect([...li.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-label')])).toEqual([['tx ›', '/tx/1/1', 'Open 1']]);
    expect(li.querySelector('button a')).toBeNull();
    expect(c.querySelector('g[data-edge=t0] a')!.getAttribute('href')).toBe('/c/1/0xc/tx/0xr1?method=A');
    // One the page gave no link opens its trade, as every graph's does.
    expect(c.querySelector('g[data-edge=t1] a')!.getAttribute('href')).toBe('/tx/1/0xr2');
  });
});
