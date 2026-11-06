import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlaggedTransfer } from '@washtrace/detect';
import { layout } from '@/lib/layout';
import { TokenLoops } from '@/components/token-graph';

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
