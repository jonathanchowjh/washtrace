import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlaggedTransfer } from '@washtrace/detect';
import { layout } from '@/lib/layout';
import { LoopFigure, TokenLoops } from '@/components/token-graph';

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

  it('keeps a money arrow’s title and opens nothing for it', () => {
    const flow = { txHash: '0xf', kind: 'native' as const, from: A, to: C, valueWei: '1', token: '', blockNumber: 1, blockTime: 1 };
    const withMoney = layout(transfers, [flow], []);
    render(<TokenLoops drawing={withMoney} chainId={1} items={[]} initial={null} rowHrefs={rowHrefs} />);
    const g = document.querySelector(`[data-edge="m${A}>${C}"]`)!;
    expect(g.querySelector('title')?.textContent).toBe('1 money flow');
    fireEvent.click(g.querySelector('path')!);
    expect(push).not.toHaveBeenCalled();
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
