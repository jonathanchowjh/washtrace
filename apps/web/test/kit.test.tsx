import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Witness } from '@washtrace/detect';
import { CountGlyph, type Counts, EvidenceGlyph, KindIcon, TierMark, VerdictChip, countLabel, evidenceLabel, ringTone } from '@/components/kit';

afterEach(cleanup);

const loop = (n: number, cycles = 1): Witness => ({ kind: 'scc', wallets: Array.from({ length: n }, (_, i) => `0x${i}`), cycles });
const pair = (middle: string | null): Witness => ({ kind: 'pair', pair: ['0xa', '0xb'], middle, flowTx: '0xf' });
const wallets = (w: Witness) => render(<EvidenceGlyph witness={w} />).container.querySelectorAll('circle').length;

describe('the evidence picture', () => {
  it('names what it draws, and says nothing a witness does not record', () => {
    expect(evidenceLabel(loop(2))).toBe('The token went round 2 wallets');
    expect(evidenceLabel(loop(3, 2))).toBe('The token went round 3 wallets, 2 cycles');
    expect(evidenceLabel({ kind: 'scc+flow', wallets: ['0xa', '0xb'], cycles: 0, via: [['0xb', '0xa']] })).toBe('A loop among 2 wallets, closed by money');
    // A pair records a link, not who paid whom.
    expect(evidenceLabel(pair(null))).toBe('The seller and buyer are joined by money');
    expect(evidenceLabel(pair('0xm'))).toBe('The seller and buyer are joined by money through one wallet');
  });

  it('draws one circle a wallet, the middle included, up to six', () => {
    expect(wallets(loop(2))).toBe(2);
    expect(wallets(loop(4))).toBe(4);
    expect(wallets(pair(null))).toBe(2);
    expect(wallets(pair('0xm'))).toBe(3);
    // A loop of nine is drawn as six; its name keeps the nine.
    const { container } = render(<EvidenceGlyph witness={loop(9)} />);
    expect(container.querySelectorAll('circle')).toHaveLength(6);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('The token went round 9 wallets');
  });

  it('dashes money and only money', () => {
    const dashed = (w: Witness) => [...render(<EvidenceGlyph witness={w} />).container.querySelectorAll('[stroke-dasharray]')].map((e) => e.getAttribute('class'));
    expect(dashed(loop(3))).toEqual([]);
    cleanup();
    expect(dashed(pair('0xm'))).toEqual(['stroke-flow']);
    cleanup();
    expect(dashed({ kind: 'scc+flow', wallets: ['0xa', '0xb', '0xc'], cycles: 0, via: [['0xc', '0xa']] })).toEqual(['stroke-flow']);
  });
});

describe('the tier mark and the kind symbol', () => {
  it('tells the standings apart by shape, not only by hue', () => {
    const cls = (tone: 'cycle' | 'ceiling' | 'apart' | 'own') => render(<TierMark tone={tone} />).container.querySelector('i')!.className;
    expect(cls('cycle')).toContain('bg-cycle');
    expect(cls('ceiling')).toContain('repeating-linear-gradient');
    expect(cls('apart')).toContain('border-dashed');
    // Not a faint 1 px outline: a heavier ring round a tinted disc, still grey, so a Trades column tells it from "–" at a glance.
    expect(cls('apart')).toContain('border-[1.5px]');
    expect(cls('apart')).toContain('bg-muted-foreground/30');
    expect(cls('own')).toContain('rotate-45');
  });

  it('is decoration: the words beside it carry the meaning', () => {
    const { container } = render(<><KindIcon kind="wallet" /><TierMark tone="cycle" /></>);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('i')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('with `label`, says its standing to a screen reader before what it leads; a lens of yours has none to say', () => {
    expect(render(<TierMark tone="ceiling" label />).container.querySelector('.sr-only')?.textContent).toBe('Linked wallets · the ceiling: ');
    cleanup();
    expect(render(<TierMark tone="own" label />).container.querySelector('.sr-only')).toBeNull();
  });
});

describe('the verdict chip', () => {
  it('names the tier by the lens behind it, and says not judged yet rather than clean', () => {
    const word = (tone: Parameters<typeof VerdictChip>[0]['tone']) => { const t = render(<VerdictChip tone={tone} />).container.textContent; cleanup(); return t; };
    expect([word('cycle'), word('ceiling'), word('apart'), word('clean'), word(null)])
      .toEqual(['Round trips · the floor', 'Linked wallets · the ceiling', 'Money loops back · not counted', 'Not flagged', 'Not judged yet']);
  });
});

describe('the picture drawn from counts', () => {
  const none: Counts = { loops: null, pairs: null, wallets: null, closedByMoney: null, middles: null };
  const drawn = (c: Partial<Counts>) => render(<CountGlyph counts={{ ...none, ...c }} />).container;

  it('draws a ring of the wallets the loops run among, a dot each up to six', () => {
    expect(drawn({ loops: 3, wallets: 4 }).querySelectorAll('circle')).toHaveLength(4);
    cleanup();
    const nine = drawn({ loops: 1, wallets: 9 });
    expect(nine.querySelectorAll('circle')).toHaveLength(6);
    expect(nine.querySelector('svg')?.getAttribute('aria-label')).toBe('1 loop among 9 wallets');
  });

  it('dashes money and only money: a loop closed by money has a payment back, one that is not has none', () => {
    const dashes = (c: Partial<Counts>) => [...drawn(c).querySelectorAll('[stroke-dasharray]')].map((e) => e.getAttribute('class'));
    expect(dashes({ loops: 2, wallets: 3 })).toEqual([]);
    cleanup();
    expect(dashes({ loops: 2, wallets: 3, closedByMoney: 1 })).toEqual(['stroke-flow']);
  });

  it('with only pairs, draws the sale with money under it, through a middle wallet when any pair had one', () => {
    expect(drawn({ pairs: 2 }).querySelectorAll('circle')).toHaveLength(2);
    cleanup();
    const mid = drawn({ pairs: 2, middles: 1 });
    expect(mid.querySelectorAll('circle')).toHaveLength(3);
    expect(mid.querySelector('svg')?.getAttribute('aria-label')).toBe('2 seller and buyer pairs joined by money, 1 through a middle wallet');
  });

  it('names what it draws, and is nothing for a row with no counts', () => {
    expect(countLabel({ ...none, loops: 3, wallets: 4, closedByMoney: 2 })).toBe('3 loops among 4 wallets, 2 loops closed by money');
    expect(countLabel({ ...none, pairs: 1 })).toBe('1 seller and buyer pair joined by money');
    expect(countLabel(none)).toBeNull();
    expect(countLabel({ ...none, loops: 0, pairs: 0 })).toBeNull();
    expect(drawn({}).querySelector('svg')).toBeNull();
  });
});

describe('a ring\'s mark', () => {
  it('is the floor\'s when Round trips flags any of its sales, else the ceiling\'s', () => {
    expect(ringTone({ floorSales: 2 })).toBe('cycle');
    expect(ringTone({ floorSales: 0 })).toBe('ceiling');
  });
});
