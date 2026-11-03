import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'b'.repeat(40);
const ran = (m: string) => ({ available: m === 'A' || state.moneyRan });
const state = { moneyRan: true, throughBlock: 10 as number | null, blocks: [5], flagged: [] as string[], latestNull: false };

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => ({ id: 1, chainId: 1, address: ADDR, name: 'Coll', latest: state.latestNull ? null : { throughBlock: state.throughBlock, totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, ran(m)])) } }),
    token: async () => state.blocks.map((b, i) => ({
      txHash: '0x' + i, logIndex: 0, blockNumber: b, blockTime: null, tokenId: '7', from: '0x1', to: '0x2', marketplace: null, priceWei: null, currency: null,
      flags: Object.fromEntries(state.flagged.map((m) => [m, { kind: 'scc', wallets: ['0x1', '0x2'], cycles: 2 }])),
    })),
    flowsAmong: async () => [],
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(() => { cleanup(); Object.assign(state, { moneyRan: true, throughBlock: 10, blocks: [5], flagged: [], latestNull: false }); });

async function page(): Promise<string> {
  const { default: TokenPage } = await import('@/app/c/[chain]/[address]/t/[tokenId]/page');
  const { container } = render(await TokenPage({ params: Promise.resolve({ chain: '1', address: ADDR, tokenId: '7' }) }));
  return container.textContent ?? '';
}

describe('the token page when not everything is judged', () => {
  it('a token with newer transfers and an older Money loops back flag says no analysis covered them, not that it is flagged', async () => {
    Object.assign(state, { blocks: [5, 20], flagged: ['AU'] });
    const text = await page();
    expect(text).toContain('Not judged yet');
    expect(text).toContain('no analysis has covered them yet. That is not the same as clean.');
    expect(text).not.toContain('count toward');
    expect(text).not.toContain('What this means');
  });

  it('a token with no analysis does not say no pattern was found', async () => {
    Object.assign(state, { latestNull: true });
    const text = await page();
    expect(text).toContain('No analysis has covered these transfers yet, so no lens has looked for a pattern.');
    expect(text).not.toContain('No lens found a pattern');
  });

  it('a judged token flagged only by Money loops back says it is not counted', async () => {
    Object.assign(state, { flagged: ['AU'] });
    const text = await page();
    expect(text).toContain('Flagged only by Money loops back, which is not counted');
    expect(text).not.toContain('count toward');
  });

  it('copies of Round trips in lenses that did not run are not named', async () => {
    Object.assign(state, { moneyRan: false, flagged: ['A', 'AU', 'AC'] });
    const text = await page();
    expect(text).toContain('flagged, by Round trips.');
    expect(text).not.toContain('Linked wallets found');
  });
});
