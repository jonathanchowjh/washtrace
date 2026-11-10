import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { moneyFor } from '@washtrace/detect';
import { Empty, Head } from '@/components/ui';
import { Pager } from '@/components/pager';
import { RingsTable } from '@/components/rings';
import { collectionOf } from '@/lib/collection-reads';
import { plural, short } from '@/lib/format';
import { addressOf, chainOf, pageOf, pages } from '@/lib/params';
import { store } from '@/lib/store';
import { RINGS_PAGE } from '@/lib/views';

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const c = chainId === null || address === null ? null : await collectionOf(chainId, address);
  return { title: c ? `Rings · ${c.name ?? short(c.address)}` : 'Rings' };
}

/**
 * Every ring of the collection, RINGS_PAGE a page, the most ETH first: the
 * wallets the counted evidence joins, as methods.md's Rings says them.
 */
export default async function RingsPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const c = await collectionOf(chainId, address);
  if (!c) notFound();
  const base = `/c/${chainId}/${address}`;
  const counted = c.latest?.rings ?? null;
  // A page past the last reads as the last; the analysis's count says which that is without a read.
  const page = Math.min(pageOf((await searchParams).page), pages(counted ?? 0, RINGS_PAGE));
  const read = counted ? await store().rings(c.id, { money: moneyFor(chainId) }, RINGS_PAGE, (page - 1) * RINGS_PAGE) : null;
  return (
    <>
      <Head title="Rings" sub="Wallets that Round trips or Linked wallets ties together, the most ETH first. A ring is wallets the evidence joins, not one person." />
      {c.latest === null ? <Empty>No analysis yet, so no ring.</Empty>
        : counted === null ? <Empty>The rings of the latest analysis are being worked out from its evidence. This page fills in once they are.</Empty>
        : read === null || read.total === 0 ? <Empty>No ring: nothing Round trips or Linked wallets flags ties wallets together.</Empty>
        : (
          <>
            <p className="mb-2 text-sm text-muted-foreground">{plural(read.total, 'ring')}. Each count opens its trades.</p>
            <RingsTable rows={read.rows} base={base} chainId={chainId} />
            <Pager total={read.total} page={page} size={RINGS_PAGE} href={(n) => (n > 1 ? `${base}/rings?page=${n}` : `${base}/rings`)} label="rings" />
          </>
        )}
    </>
  );
}
