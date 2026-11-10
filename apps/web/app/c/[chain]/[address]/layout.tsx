import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { Badge, CollectionNav, TabCount } from '@/components/collection-nav';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { short } from '@/lib/format';
import { addressOf, chainOf } from '@/lib/params';

type Props = { params: Promise<{ chain: string; address: string }>; children: ReactNode };

/**
 * Every page of one collection sits under its parent line and tab bar, so a
 * token, a list or a trade always says which collection it belongs to and
 * which part of it the reader is in. The counts come after the page, from
 * the browser: a slow count never holds the page back, and a prefetch of a
 * tab never reads them.
 */
export default async function CollectionLayout({ params, children }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const c = await collectionOf(chainId, address);
  if (!c) notFound();
  // The counts are read by the browser, once a page and again when an analysis or a read changes them: here they ran for every prefetch and refresh.
  const src = `/api/collections/${chainId}/${address}/counts?analysis=${c.latest?.id ?? 'none'}&transfers=${c.transfers}`;
  const count = (kind: 'tokens' | 'wallets' | 'trades') => <TabCount src={src} kind={kind} />;
  // The page under it reads the same runs, from the same request's cache.
  const lenses = [...METHODS, ...(await runsOf(c.id)).map((r) => r.lens.key)];
  return (
    <>
      <CollectionNav base={`/c/${chainId}/${address}`} name={c.name ?? short(address)} analysedAt={c.latest?.ranAt ?? null} lenses={lenses}
        counts={{ rings: c.latest?.rings == null ? null : <Badge n={c.latest.rings} />, tokens: count('tokens'), wallets: count('wallets'), trades: count('trades') }} />
      {children}
    </>
  );
}
