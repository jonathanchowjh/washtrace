import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { readerZone } from '@/lib/api';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { listHref } from '@/lib/links';
import { ownLenses } from '@/lib/metrics';
import { addressOf, chainOf } from '@/lib/params';
import { parseView, tradesHref } from '@/lib/trades-url';
import { askedOf } from './view';

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Where the tokens, wallets and trades lists used to be, as kinds of one page.
 * Each now has its own tab and route; an old link is sent on to it with its
 * lens, order, Find and page, written as that list writes them.
 */
export default async function FlaggedPage({ params, searchParams }: Props) {
  await connection();
  const q = await searchParams;
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const base = `/c/${chainId}/${address}`;
  const { one, kind } = askedOf(q);
  if (kind !== 'trades') {
    const page = Number(one('page'));
    redirect(listHref(base, kind, { method: one('method') ?? 'AC', sort: one('sort'), q: one('q'), page: Number.isInteger(page) ? page : 1 }));
  }
  const c = await collectionOf(chainId, address);
  if (!c) notFound();
  const own = ownLenses(await runsOf(c.id));
  const { q: query, view } = parseView(q, await readerZone(), new Set(Object.keys(own)));
  redirect(tradesHref(base, query, view));
}
