import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { short } from '@/lib/format';
import { chainOf, txOf } from '@/lib/params';
import { TxView } from './view';

type Props = { params: Promise<{ chain: string; hash: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { hash } = await params;
  return { title: txOf(hash) === null ? 'Transaction' : short(hash) };
}

/** One transaction, whatever collections it moved. */
export default async function TxPage({ params }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const tx = txOf(p.hash);
  if (chainId === null || tx === null) notFound();
  return TxView({ chainId, tx });
}
