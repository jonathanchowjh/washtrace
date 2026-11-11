import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { moneyFor } from '@washtrace/detect';
import { Empty, Head } from '@/components/ui';
import { Pager } from '@/components/pager';
import { RingsTable } from '@/components/rings';
import { collectionAt } from '@/lib/collection-reads';
import { LENSES, short } from '@/lib/format';
import { pageOf, pages } from '@/lib/params';
import { store } from '@/lib/store';
import { RINGS_PAGE } from '@/lib/views';
import { fromParam } from '@/lib/step';

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = await collectionAt(await params);
  return { title: c ? `Rings · ${c.name ?? short(c.address)}` : 'Rings' };
}

/**
 * Every ring of the collection, RINGS_PAGE a page, the most ETH first: the
 * wallets the counted evidence joins, as methods.md's Rings says them.
 */
export default async function RingsPage({ params, searchParams }: Props) {
  await connection();
  const c = (await collectionAt(await params)) ?? notFound();
  const { chainId, address } = c;
  const base = `/c/${chainId}/${address}`;
  const counted = c.latest?.rings ?? null;
  // A page past the last reads as the last; the analysis's count says which that is without a read.
  const page = Math.min(pageOf((await searchParams).page), pages(counted ?? 0, RINGS_PAGE));
  const read = counted ? await store().rings(c.id, { money: moneyFor(chainId) }, RINGS_PAGE, (page - 1) * RINGS_PAGE) : null;
  return (
    <>
      <Head title="Rings" sub={`Wallets tied together by what ${LENSES.A.name} and ${LENSES.AC.name} flag, the most ETH first. A ring is wallets the evidence joins, not one person. Each count opens its trades.`} />
      {c.latest === null ? <Empty>No analysis yet, so no ring.</Empty>
        : counted === null ? <Empty>The rings of the latest analysis are being worked out from its evidence. This page fills in once they are.</Empty>
        : read === null || read.total === 0 ? <Empty>No ring: nothing {LENSES.A.name} or {LENSES.AC.name} flags ties wallets together.</Empty>
        : (
          <>
            {/* The count is said once, by the pager under the table. */}
            <RingsTable rows={read.rows} base={base} chainId={chainId} from={fromParam('rings', new URLSearchParams(), page)} />
            <Pager total={read.total} page={page} size={RINGS_PAGE} href={(n) => (n > 1 ? `${base}/rings?page=${n}` : `${base}/rings`)} label="rings" />
          </>
        )}
    </>
  );
}
