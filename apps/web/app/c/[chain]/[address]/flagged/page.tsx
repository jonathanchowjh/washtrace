import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { readerZone } from '@/lib/api';
import { ownLenses } from '@/lib/metrics';
import { addressOf, chainOf } from '@/lib/params';
import { store } from '@/lib/store';
import { parseView, tradesHref } from '@/lib/trades-url';
import { FlaggedView, askedOf, metadataOf } from './view';

type Props = Parameters<typeof FlaggedView>[0];

export async function generateMetadata(props: Omit<Props, 'kind'>): Promise<Metadata> {
  const { kind } = askedOf(await props.searchParams);
  // A trades link is redirected before it renders, so its title is never shown.
  return metadataOf(kind, props);
}

/**
 * Tokens or wallets one lens flags. Trades used to be a kind of this page: an
 * old `?kind=trades` link is sent on to /trades with its filters, rewritten in
 * the order the trades page writes them.
 */
export default async function FlaggedPage(props: Omit<Props, 'kind'>) {
  const q = await props.searchParams;
  const { kind } = askedOf(q);
  if (kind === 'trades') {
    await connection();
    const p = await props.params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    const c = chainId === null || address === null ? null : await store().collection(chainId, address);
    if (!c) notFound();
    const own = ownLenses(await store().lensRuns(c.id));
    const { q: query, view } = parseView(q, await readerZone(), new Set(Object.keys(own)));
    redirect(tradesHref(`/c/${chainId}/${address}`, query, view));
  }
  return FlaggedView({ kind, ...props });
}
