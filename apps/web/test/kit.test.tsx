import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Witness } from '@washtrace/detect';
import { EvidenceGlyph, KindIcon, TierMark, VerdictChip, evidenceLabel } from '@/components/kit';

afterEach(cleanup);

const loop = (n: number, cycles = 1): Witness => ({ kind: 'scc', wallets: Array.from({ length: n }, (_, i) => `0x${i}`), cycles });
const pair = (middle: string | null): Witness => ({ kind: 'pair', pair: ['0xa', '0xb'], middle, flowTx: '0xf' });
const wallets = (w: Witness) => render(<EvidenceGlyph witness={w} />).container.querySelectorAll('circle').length;

describe('the evidence picture', () => {
  it('names what it draws, and says nothing a witness does not record', () => {
    expect(evidenceLabel(loop(2))).toBe('The token went round 2 wallets');
    expect(evidenceLabel(loop(3, 2))).toBe('The token went round 3 wallets, 2 loops');
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
    const cls = (tone: 'cycle' | 'money' | 'apart' | 'own') => render(<TierMark tone={tone} />).container.querySelector('i')!.className;
    expect(cls('cycle')).toContain('bg-cycle');
    expect(cls('money')).toContain('repeating-linear-gradient');
    expect(cls('apart')).toContain('border-dashed');
    expect(cls('own')).toContain('rotate-45');
  });

  it('is decoration: the words beside it carry the meaning', () => {
    const { container } = render(<><KindIcon kind="wallet" /><TierMark tone="cycle" /></>);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('i')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the verdict chip', () => {
  it('names the tier by the lens behind it, and says not judged yet rather than clean', () => {
    const word = (tone: Parameters<typeof VerdictChip>[0]['tone']) => { const t = render(<VerdictChip tone={tone} />).container.textContent; cleanup(); return t; };
    expect([word('cycle'), word('money'), word('apart'), word('clean'), word(null)])
      .toEqual(['Round trips · the floor', 'Linked wallets · the ceiling', 'Money loops back · not counted', 'Not flagged', 'Not judged yet']);
  });
});
