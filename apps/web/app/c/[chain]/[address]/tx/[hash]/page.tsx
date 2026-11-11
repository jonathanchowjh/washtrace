import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { movesIn, paymentOf, transactionOf } from '@/lib/collection-reads';
import { short } from '@/lib/format';
import { txHref } from '@/lib/links';
import { addressOf, chainOf, txOf } from '@/lib/params';
import { contextOf } from '@/lib/step';
import { TxView } from '@/app/tx/[chain]/[hash]/view';

type Props = { params: Promise<{ chain: string; address: string; hash: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

/**
 * The transaction's own page is the canonical one: it can move tokens of more
 * than one collection. A payment moves none, and its view is only this one,
 * so it is its own canonical page.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const tx = txOf(p.hash);
  if (tx === null || chainId === null || address === null) return { title: 'Transaction' };
  // No transfer of this collection in it, and a payment read: the page is the payment's view. A sale reads no payment.
  const isPayment = !movesIn(await transactionOf(chainId, tx), address) && (await paymentOf(chainId, tx)) !== null;
  return { title: short(tx), alternates: { canonical: isPayment ? txHref(chainId, tx, `/c/${chainId}/${address}`) : txHref(chainId, tx) } };
}

/** One transaction, opened from a collection: under its tabs, with Trades lit. */
export default async function CollectionTxPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const tx = txOf(p.hash);
  if (chainId === null || address === null || tx === null) notFound();
  const ctx = contextOf((await searchParams) ?? {});
  return TxView({ chainId, tx, within: `/c/${chainId}/${address}`, address, from: ctx.from, method: ctx.method });
}
