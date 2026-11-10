import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlaggedTransfer } from '@washtrace/detect';
import { Transfers } from '@/components/transfers';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const S = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);

/** A sale of Demo Apes #101 S → B, flagged by `flags`. */
const sale = (n: number, flags: FlaggedTransfer['flags'] = {}, marketplace: string | null = 'seaport-1.6'): FlaggedTransfer => ({
  txHash: '0x' + String(n).repeat(64), logIndex: 0, blockNumber: n, blockTime: null, tokenId: '101', from: S, to: B, marketplace,
  priceWei: marketplace === null ? null : '1000000000000000000', currency: marketplace === null ? null : '', flags,
  collection: { chainId: 1, address: ADDR, name: 'Demo Apes' },
});
const ROUND = { A: { kind: 'scc' as const, wallets: [S, B], cycles: 2 } };

afterEach(cleanup);

const links = (el: Element) => [...el.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

describe('the transfer table on a phone', () => {
  it('lays each row out as a card below sm and as a table row from sm, its head hidden there', () => {
    const el = render(<Transfers chainId={1} transfers={[sale(1, ROUND), sale(2)]} numbered base={BASE} within={BASE} />).container;
    expect(el.querySelector('table')!.className).toMatch(/(^| )block( |$).*sm:table( |$)/);
    expect(el.querySelector('thead')!.className).toContain('hidden');
    expect(el.querySelector('thead')!.className).toContain('sm:table-header-group');
    const rows = [...el.querySelectorAll('tbody tr')];
    for (const tr of rows) {
      expect(tr.className).toContain('flex-wrap');
      expect(tr.className).toContain('sm:table-row');
    }
    // One element per row, so the graph's #t links reach the card on a phone too; and the tint is the card's.
    expect(rows.map((r) => r.id)).toEqual(['t1', 't2']);
    expect(rows[0]!.className).toContain('bg-cycle-surface/70');
    // The card draws its # beside the number; the cell's own text stays the number.
    const number = rows[0]!.querySelector('[data-row-number]')!;
    expect(number.textContent).toBe('1');
    expect(number.className).toContain("before:content-['#']");
  });

  it('a card leaves out the lens and Why cells of a row no lens flags; the table keeps their dash', () => {
    const el = render(<Transfers chainId={1} transfers={[sale(1, ROUND), sale(2)]} collection base={BASE} within={BASE} />).container;
    const [flagged, clean] = [...el.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')]);
    expect(flagged!.slice(-2).map((td) => td.className.includes('max-sm:hidden'))).toEqual([false, false]);
    expect(clean!.slice(-2).map((td) => td.className.includes('max-sm:hidden'))).toEqual([true, true]);
    expect(clean!.slice(-2).map((td) => td.textContent)).toEqual(['—', '—']);
  });

  it('a card holds the row’s links, its token on a line of its own', () => {
    const el = render(<Transfers chainId={1} transfers={[sale(1, ROUND)]} collection base={BASE} within={BASE} />).container;
    const tr = el.querySelector('tbody tr')!;
    const token = [...tr.querySelectorAll('td')][1]!;
    expect(token.textContent).toBe('Demo Apes #101');
    expect(token.className).toContain('basis-full');
    expect(links(tr)).toEqual(expect.arrayContaining([
      ['Demo Apes #101', `${BASE}/t/101`],
      [`${S.slice(0, 6)}…${S.slice(-4)}`, `${BASE}/w/${S}`],
      [`${B.slice(0, 6)}…${B.slice(-4)}`, `${BASE}/w/${B}`],
      ['Round trips', `${BASE}/methods?method=A#evidence`],
    ]));
  });
});
