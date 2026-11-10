import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Loading } from '@/components/ui';
import CollectionLoading from '@/app/c/[chain]/[address]/loading';
import TokenLoading from '@/app/c/[chain]/[address]/t/[tokenId]/loading';
import WalletLoading from '@/app/w/[chain]/[address]/loading';
import TxLoading from '@/app/tx/[chain]/[hash]/loading';
import TokensLoading from '@/app/c/[chain]/[address]/tokens/loading';
import WalletsLoading from '@/app/c/[chain]/[address]/wallets/loading';
import TradesLoading from '@/app/c/[chain]/[address]/trades/loading';
import InWalletLoading from '@/app/c/[chain]/[address]/w/[wallet]/loading';
import InTxLoading from '@/app/c/[chain]/[address]/tx/[hash]/loading';

afterEach(cleanup);

describe('a page still loading', () => {
  it('says what it is loading, to a screen reader as well', () => {
    const status = render(<Loading kind="wallet" />).getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Loading this wallet');
  });

  it('names the kind each route will be', () => {
    const named = (el: ReactElement) => {
      const label = render(el).getByRole('status').getAttribute('aria-label');
      cleanup();
      return label;
    };
    expect([<CollectionLoading key="c" />, <TokenLoading key="t" />, <WalletLoading key="w" />, <TxLoading key="x" />].map(named))
      .toEqual(['Loading this collection', 'Loading this token', 'Loading this wallet', 'Loading this transaction']);
    // A collection's lists and the things opened from them say the kind they list or are.
    expect([<TokensLoading key="t" />, <WalletsLoading key="w" />, <TradesLoading key="x" />, <InWalletLoading key="iw" />, <InTxLoading key="ix" />].map(named))
      .toEqual(['Loading these tokens', 'Loading these wallets', 'Loading these transactions', 'Loading this wallet', 'Loading this transaction']);
  });

  it('pulses only when the reader allows motion', () => {
    const { container } = render(<Loading kind="token" />);
    const bones = [...container.querySelectorAll('div')].filter((d) => d.className.includes('bg-muted'));
    expect(bones.length).toBeGreaterThan(0);
    expect(bones.every((d) => d.className.includes('motion-safe:animate-pulse') && !/(^| )animate-pulse/.test(d.className))).toBe(true);
  });
});
