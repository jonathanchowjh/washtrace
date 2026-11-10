import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { short } from '@/lib/format';
import { addressOf, chainOf } from '@/lib/params';
import { WalletView } from './view';

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: short(address) };
}

/** One wallet across every watched collection. */
export default async function WalletPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  return WalletView({ chainId, address, sp: await searchParams });
}
