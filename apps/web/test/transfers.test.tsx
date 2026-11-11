import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlaggedTransfer } from '@washtrace/detect';
import { Transfers, because } from '@/components/transfers';
import type { PairShape, Witness } from '@washtrace/detect';

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

describe('a mint or a burn in the From → To cell', () => {
  const ZERO = '0x' + '0'.repeat(40);
  const cell = (from: string, to: string) => render(<Transfers chainId={1} transfers={[{ ...sale(1), from, to, marketplace: null }]} base={BASE} within={BASE} />).container.querySelectorAll('tbody td')[1]!.textContent;

  it('reads "minted to 0x…" and "0x… burned", and a move between wallets keeps its arrow', () => {
    expect(cell(ZERO, B)).toBe('minted to 0x2222…2222');
    cleanup();
    expect(cell(S, ZERO)).toBe('0x1111…1111 burned');
    cleanup();
    expect(cell(S, B)).toBe('0x1111…1111 → 0x2222…2222');
  });
});

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

describe('the transfer table’s lens tags and marketplaces', () => {
  const ALL = {
    ...ROUND,
    AC: { kind: 'pair' as const, pair: [S, B] as [string, string], middle: null, flowTx: '0x' + 'f'.repeat(64) },
    AU: { kind: 'pair' as const, pair: [S, B] as [string, string], middle: null, flowTx: '0x' + 'f'.repeat(64) },
  };

  it('tags each lens as a chip with its tier’s mark, linking its tab, as every other page does', () => {
    const own = new Map([[`${sale(1).txHash}:0`, ['L7' as const]]]);
    const names = { L7: { name: 'Fast flips', tone: 'own' as const, says: '' } };
    const el = render(<Transfers chainId={1} transfers={[sale(1, ALL)]} base={BASE} own={own} names={names} />).container;
    const chips = [...el.querySelectorAll('tbody a.chip')];
    expect(chips.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Round trips', `${BASE}/methods?method=A#evidence`],
      ['Linked wallets', `${BASE}/methods?method=AC#evidence`],
      ['Money loops back', `${BASE}/methods?method=AU#evidence`],
      ['Fast flips', `${BASE}/methods?method=L7#evidence`],
    ]);
    // The mark is the tier's shape: the floor solid, the ceiling hatched, the uncounted a dashed ring, yours a diamond.
    const marks = chips.map((a) => a.querySelector('i')!.className);
    expect(marks[0]).toContain('bg-cycle');
    expect(marks[1]).toContain('repeating-linear-gradient');
    expect(marks[2]).toContain('border-dashed');
    expect(marks[3]).toContain('rotate-45');
    // No solid filled badge is left.
    expect(el.querySelector('tbody .text-background')).toBeNull();
  });

  it('a chip with no collection to open is a chip still, with no link', () => {
    const el = render(<Transfers chainId={1} transfers={[{ ...sale(1, ROUND), collection: undefined }]} />).container;
    const chip = el.querySelector('tbody span.chip')!;
    expect(chip.textContent).toBe('Round trips');
    expect(chip.querySelector('i')!.className).toContain('bg-cycle');
    expect(el.querySelector('tbody a.chip')).toBeNull();
  });

  it('names a marketplace as Trades does, and keeps a name no venue lists', () => {
    const el = render(<Transfers chainId={1} transfers={[sale(1), sale(2, {}, 'blur-v2'), sale(3, {}, 'Elsewhere')]} collection base={BASE} />).container;
    const sold = [...el.querySelectorAll('tbody tr')].map((r) => r.querySelectorAll('td')[3]!.firstChild!.textContent);
    expect(sold).toEqual(['OpenSea', 'Blur', 'Elsewhere']);
    expect(el.textContent).not.toContain('seaport');
  });
});

describe('why a linked pair was flagged, by its shape', () => {
  const M = '0x' + '3'.repeat(40);
  const said = (shape: PairShape | undefined, middle: string | null) => {
    const w: Witness = { kind: 'pair', pair: [S, B], middle, flowTx: '0x1', ...(shape === undefined ? {} : { shape }) };
    return render(<>{because(w, 1)}</>).container.textContent;
  };
  const [s, b, m] = ['0x1111…1111', '0x2222…2222', '0x3333…3333'];

  it('says who paid whom, the seller first in a funder, payee or forward pair and the buyer first in a pay-back', () => {
    expect(said('funder', M)).toContain(`${s} and ${b} were both funded by ${m}`);
    expect(said('payee', M)).toContain(`${s} and ${b} both paid ${m}`);
    expect(said('back', M)).toContain(`${b} paid ${s} back through ${m}`);
    expect(said('forward', M)).toContain(`${s} paid ${b} through ${m}`);
    expect(said('direct-back', null)).toContain(`${b} paid ${s} directly`);
    expect(said('direct-forward', null)).toContain(`${s} paid ${b} directly`);
    expect(said('both', null)).toContain(`${s} and ${b} paid each other directly`);
  });

  it('keeps today\'s words for a pair stored without a shape', () => {
    expect(said(undefined, M)).toContain(`${s} and ${b} share money with ${m}`);
    expect(said(undefined, null)).toContain(`${s} and ${b} paid each other directly`);
  });
});
