import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { Head, Section } from '@/components/head';
import { TokenGraph } from '@/components/token-graph';
import { Transfers } from '@/components/transfers';
import { addressOf, chainOf, tokenIdOf } from '@/lib/api';
import { METHOD_NAMES, short } from '@/lib/format';
import { layout } from '@/lib/layout';
import { tokenView } from '@/lib/views';

type Props = { params: Promise<{ chain: string; address: string; tokenId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tokenId } = await params;
  return { title: `#${tokenId}` };
}

/** One token: its graph with the money among its holders, and every transfer with each method's reason. */
export default async function TokenPage({ params }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const tokenId = tokenIdOf(p.tokenId);
  if (chainId === null || address === null || tokenId === null) notFound();
  const view = await tokenView(chainId, address, tokenId);
  if (view === null) notFound();
  const { collection, transfers, flows, middles } = view;
  const counts = METHODS.map((m) => `${METHOD_NAMES[m]} ${transfers.filter((t) => t.flags[m]).length}`).join(' · ');

  return (
    <>
      <Head
        title={`${collection.name ?? short(address)} #${tokenId.length > 20 ? `${tokenId.slice(0, 18)}…` : tokenId}`}
        crumb={[{ href: '/', label: 'Collections' }, { href: `/c/${chainId}/${address}`, label: collection.name ?? short(address) }]}
        sub={`${transfers.length} transfers · flagged: ${counts}`}
      />
      <Section title="Graph" aside="solid: the token moving · dashed: money between the same wallets">
        <TokenGraph drawing={layout(transfers, flows, middles)} chainId={chainId} />
      </Section>
      <Section title="Transfers, in chain order">
        <Transfers chainId={chainId} transfers={transfers} numbered />
      </Section>
    </>
  );
}
