import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Flow, MethodTotals, Transfer } from '@washtrace/detect';

const ADDR = '0x' + 'ab'.repeat(20);
const BASE = `/c/1/${ADDR}`;
const RING = '0x' + '12'.repeat(20);
const TX = '0x' + '9'.repeat(64);
const t = (n: number, a: number): MethodTotals => ({ transfers: 100, flagged: n, sales: 100, flaggedSales: n, volumeWei: '0', flaggedVolumeWei: '0', wallets: 0, tokens: 0, available: a > 0 });
const fake = {
  collection: vi.fn(async (_c: number, a: string) => (a === ADDR ? { id: 1, name: 'Demo Apes', latest: { totals: { A: t(18, 1), AC: t(25, 1), AU: t(30, 1) } } } : null)),
  ringsOf: vi.fn(async () => [RING]),
  ringLines: vi.fn(async () => [{ anchor: RING, rank: 3, wallets: 3, sample: [], sales: 1, floorSales: 0, tokens: 1, volumeWei: '0', firstAt: null, lastAt: null }]),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));

const { ConnectedRail, partnersOf, railTxs, walletRoles } = await import('@/components/connected-rail');
afterEach(cleanup);

const w = (c: string) => '0x' + c.repeat(40);
const ZERO = '0x' + '0'.repeat(40);
const transfer = (from: string, to: string, block: number, sale = true, tokenId = '114') => ({ txHash: `0x${block}`, logIndex: 0, blockNumber: block, blockTime: null, tokenId, from, to, marketplace: sale ? 'opensea' : null }) as unknown as Transfer;
const flow = (from: string, to: string, block: number) => ({ txHash: `0xf${block}`, kind: 'native', from, to, valueWei: '1', token: '', blockNumber: block, blockTime: 0 }) as Flow;

describe('the wallets on the rail', () => {
  it('says each one\'s role here: seller and buyer, then funder, payee and in between, leaving out the mint and the page\'s own', () => {
    const roles = walletRoles(
      [transfer(ZERO, w('a'), 1, false), transfer(w('a'), w('b'), 2), transfer(w('b'), w('a'), 3)],
      [flow(w('f'), w('a'), 2), flow(w('b'), w('p'), 3)], [w('m')], w('z'),
    );
    expect(roles).toEqual([
      { address: w('a'), role: 'got it · seller · buyer' }, { address: w('b'), role: 'buyer · seller' },
      { address: w('m'), role: 'in between' }, { address: w('f'), role: 'funder' }, { address: w('p'), role: 'payee' },
    ]);
  });

  it('on a wallet\'s page, lists those it traded with, then its money partners by who paid whom', () => {
    const me = w('a');
    expect(partnersOf([transfer(me, w('b'), 1)], [{ address: w('b'), sent: 1, received: 0 }, { address: w('c'), sent: 0, received: 2 }, { address: w('d'), sent: 1, received: 0 }], me))
      .toEqual([{ address: w('b'), role: 'buyer' }, { address: w('c'), role: 'funder' }, { address: w('d'), role: 'payee' }]);
  });

  it('lists each transaction once, by block, a sale before a payment in it', () => {
    expect(railTxs([transfer(w('a'), w('b'), 5), transfer(w('b'), w('a'), 2, false)], [flow(w('f'), w('a'), 3)]).map((x) => x.what))
      .toEqual(['Transfer of #114', 'Payment', 'Sale of #114']);
  });
});

describe('the Connected to rail', () => {
  it('reads up the tree, then the wallets, then the transactions, each opening its page; its rings are the header\'s chips, not repeated', async () => {
    const c = render(await ConnectedRail({ chainId: 1, address: ADDR, token: '114', wallets: [{ address: w('a'), role: 'seller' }], txs: [{ hash: TX, block: 9, what: 'Sale of #114' }] })!).container;
    expect([...c.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Part of', 'Wallets', 'Transactions']);
    const links = [...c.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Demo Apes18–25% washed', BASE], ['#114', `${BASE}/t/114`],
      [`${'0xaaaa…aaaa'}seller`, `${BASE}/w/${w('a')}`], ['Sale of #1140x9999…9999', `${BASE}/tx/${TX}`],
    ]);
  });

  it('lists the first six of a group and says the rest are below, and draws nothing for a collection not watched', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ address: w(String(i)), role: 'buyer' }));
    expect(render(await ConnectedRail({ chainId: 1, address: ADDR, wallets: many })!).container.textContent).toContain('and 2 more below');
    expect(await ConnectedRail({ chainId: 1, address: w('e') })).toBeNull();
  });
});
