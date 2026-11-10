import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { short } from '@/lib/format';
import { addressOf, chainOf, txOf } from '@/lib/params';
import { TxView } from '@/app/tx/[chain]/[hash]/view';

type Props = { params: Promise<{ chain: string; address: string; hash: string }> };

/** The transaction's own page is the canonical one: it can move tokens of more than one collection. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const chainId = chainOf(p.chain);
  const tx = txOf(p.hash);
  return tx === null || chainId === null ? { title: 'Transaction' } : { title: short(tx), alternates: { canonical: `/tx/${chainId}/${tx}` } };
}

/** One transaction, opened from a collection: under its tabs, with Trades lit. */
export default async function CollectionTxPage({ params }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const tx = txOf(p.hash);
  if (chainId === null || address === null || tx === null) notFound();
  return TxView({ chainId, tx, within: `/c/${chainId}/${address}` });
}
