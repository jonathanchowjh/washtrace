import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlaggedTransfer } from '@washtrace/detect';
import { Payments, Transfers, because } from '@/components/transfers';
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

describe('why Money loops back flagged a loop', () => {
  // #113 [demo]: the buyer 0xfadd… paid the seller 0xdfe1… back through three hops.
  const buyer = '0xfadd' + '0'.repeat(32) + '79c5', seller = '0xdfe1' + '0'.repeat(32) + '1f10';
  const hops = ['0x' + 'a'.repeat(40), '0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40)];
  const loop = (more: Partial<Extract<Witness, { kind: 'scc+flow' }>> = {}): Witness =>
    ({ kind: 'scc+flow', wallets: [buyer, seller], cycles: 1, via: [[buyer, seller]], ...more });
  const said = (w: Witness, within?: string) => render(<>{because(w, 1, within)}</>).container;

  it('says who paid whom back, and through how many other wallets, from its recorded path', () => {
    const w = loop({ paths: [{ wallets: [buyer, ...hops, seller], txs: ['0x1', '0x2', '0x3', '0x4'] }] });
    expect(said(w).textContent).toBe('0xfadd…79c5 paid 0xdfe1…1f10 back through 3 other wallets, closing a loop of 2 wallets');
    cleanup();
    // Its two wallets link, under the collection's tabs.
    expect(links(said(w, BASE))).toEqual([['0xfadd…79c5', `${BASE}/w/${buyer}`], ['0xdfe1…1f10', `${BASE}/w/${seller}`]]);
    cleanup();
    expect(said(loop({ paths: [{ wallets: [buyer, seller], txs: ['0x1'] }] })).textContent).toBe('0xfadd…79c5 paid 0xdfe1…1f10 back directly, closing a loop of 2 wallets');
  });

  it('keeps today’s words for a loop saved before paths were, for several ways back, and for a path that is not its way back', () => {
    expect(said(loop()).textContent).toBe('2 wallets in a loop closed by a payment back');
    cleanup();
    const two = loop({ via: [[buyer, seller], [seller, buyer]], paths: [{ wallets: [buyer, seller], txs: ['0x1'] }] });
    expect(said(two).textContent).toBe('2 wallets in a loop closed by 2 money paths');
    cleanup();
    expect(said(loop({ paths: [{ wallets: [seller, buyer], txs: ['0x1'] }] })).textContent).toBe('2 wallets in a loop closed by a payment back');
  });
});

describe('the payment a linked pair names', () => {
  const FLOW_TX = '0x' + 'f'.repeat(64);
  const w: Witness = { kind: 'pair', pair: [S, B], middle: null, flowTx: FLOW_TX, shape: 'both' };

  it('opens its view under the collection’s tabs when there are tabs, else the explorer, and neither in a row that is itself a link', () => {
    const paid = (el: Element) => [...el.querySelectorAll('a')].filter((a) => /^(payment|tx)/.test(a.textContent ?? '')).map((a) => [a.textContent, a.getAttribute('href')]);
    expect(paid(render(<>{because(w, 1, BASE)}</>).container)).toEqual([['payment', `${BASE}/tx/${FLOW_TX}`]]);
    cleanup();
    expect(paid(render(<>{because(w, 1)}</>).container)).toEqual([['tx ↗', `https://etherscan.io/tx/${FLOW_TX}`]]);
    cleanup();
    expect(paid(render(<>{because(w, 1, BASE, true)}</>).container)).toEqual([]);
  });

  it('keeps the page’s lens and list on its payment link and its wallets, as a card’s payment rows do', () => {
    const ctx = { method: 'AC', from: 'rings' };
    const el = render(<>{because(w, 1, BASE, false, ctx)}</>).container;
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`${BASE}/tx/${FLOW_TX}?method=AC&from=rings`);
    expect(hrefs).toContain(`${BASE}/w/${S}?method=AC&from=rings`);
  });
});

describe('Payments', () => {
  const T = '0x' + 'a'.repeat(64);
  const flow = { txHash: T, kind: 'native' as const, from: S, to: B, valueWei: '1500000000000000000', token: '', blockNumber: 7, blockTime: 1_700_000_000 };

  it('for one wallet: which way each went, and its transaction opens its view under the tabs, else the explorer', () => {
    // Past the time, which reads in the reader's zone.
    const rows = (el: Element) => [...el.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].slice(1).map((td) => td.textContent));
    const under = render(<Payments chainId={1} flows={[flow]} self={S} within={BASE} ctx={{ method: 'AC' }} />).container;
    expect(rows(under)).toEqual([['it sent', 'direct', '1.5 ETH', '0xaaaa…aaaa']]);
    expect(links(under).filter(([, h]) => h?.includes('/tx/'))).toEqual([['0xaaaa…aaaa', `${BASE}/tx/${T}?method=AC`]]);
    cleanup();
    const away = render(<Payments chainId={1} flows={[{ ...flow, from: B, to: S, kind: 'token' }]} self={S} />).container;
    expect(rows(away)).toEqual([['it received', 'wrapped ETH', '1.5 WETH', 'tx ↗']]);
    expect(links(away)).toEqual([['tx ↗', `https://etherscan.io/tx/${T}`]]);
  });

  it('on a card: a row a payment with each wallet’s role, the amount, and a link to its view carrying the lens; the named one marked', () => {
    const el = render(<Payments chainId={1} flows={[flow, { ...flow, txHash: '0x' + 'b'.repeat(64), kind: 'token' as const }]} within={BASE} ctx={{ method: 'AC' }} card={{ roles: new Map([[S, 'seller']]), named: T }} />).container;
    const rows = [...el.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows[0]).toMatch(/^0x1111…1111 \(seller\) → 0x2222…2222 · 1\.5 ETH · .* · payment 0xaaaa…aaaa · the one the lens names$/);
    expect(rows[1]).toContain('1.5 WETH');
    expect(rows[1]).not.toContain('the one the lens names');
    expect(links(el).filter(([, h]) => h?.includes('/tx/'))[0]).toEqual(['payment 0xaaaa…aaaa', `${BASE}/tx/${T}?method=AC`]);
  });

  it('for one transaction: who paid whom, with no column for the transaction it is', () => {
    const el = render(<Payments chainId={1} flows={[flow]} within={BASE} />).container;
    expect([...el.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['When', 'From', 'To', 'How', 'Amount']);
    expect(links(el).map(([, h]) => h)).toEqual([`${BASE}/w/${S}`, `${BASE}/w/${B}`]);
  });
});
