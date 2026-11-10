import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { short } from '@/lib/format';
import { addressOf, chainOf } from '@/lib/params';
import { WalletView } from '@/app/w/[chain]/[address]/view';

type Props = { params: Promise<{ chain: string; address: string; wallet: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The wallet's own page across every collection is the canonical one; this is its view from one of them. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const chainId = chainOf(p.chain);
  const wallet = addressOf(p.wallet);
  return wallet === null || chainId === null ? { title: 'Wallet' } : { title: short(wallet), alternates: { canonical: `/w/${chainId}/${wallet}` } };
}

/** One wallet as seen from a collection: its trades there, under the collection's tabs; its money, all of it. */
export default async function CollectionWalletPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const wallet = addressOf(p.wallet);
  if (chainId === null || address === null || wallet === null) notFound();
  return WalletView({ chainId, address: wallet, sp: await searchParams, within: { base: `/c/${chainId}/${address}`, collection: address } });
}
