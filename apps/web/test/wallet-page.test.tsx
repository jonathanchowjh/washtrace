import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let funding: object | null = null;
vi.mock('@/lib/store', () => ({
  store: () => ({ wallet: async () => funding, counterparties: async () => [], walletTransfers: async () => [] }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(cleanup);

const params = Promise.resolve({ chain: '1', address: `0x${'a'.repeat(40)}` });

async function money(): Promise<string> {
  const { default: WalletPage } = await import('@/app/w/[chain]/[address]/page');
  const { container } = render(await WalletPage({ params }));
  return container.textContent ?? '';
}

describe('the wallet page', () => {
  it('says a wallet read from stored data was, with no dangling space before the full stop', async () => {
    funding = { status: 'done', transfers: 0, truncated: false, fetchedAt: null, error: null };
    expect(await money()).toContain('Its money was read from stored data.');
  });
});
