import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Answer, Ext, Head, Section } from '@/components/head';
import { LensName } from '@/components/methods';
import { Transfers } from '@/components/transfers';
import { chainOf, txOf } from '@/lib/api';
import { chainName } from '@/lib/chains';
import { NOT_JUDGED_YET, lensList, short } from '@/lib/format';
import { explorerTx } from '@/lib/links';
import { APART_WHY, NOT_JUDGED, TINT_LEAD, answer } from '@/lib/metrics';
import { txView } from '@/lib/views';

type Props = { params: Promise<{ chain: string; hash: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { hash } = await params;
  return { title: txOf(hash) === null ? 'Transaction' : short(hash) };
}

/** The console's form of GET /api/transfers/<chain>/<tx>: is this sale a wash trade, and by which lens. */
export default async function TxPage({ params }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const tx = txOf(p.hash);
  if (chainId === null || tx === null) notFound();
  const v = await txView(chainId, tx);
  const { transfers, washTrade, by, apartOnly, notRun } = v;
  const unread = transfers.length === 0;
  const { title, tone } = unread ? { title: NOT_JUDGED_YET, tone: 'clean' as const } : answer(v, 'Flagged as a wash trade');
  const body = unread ? 'No watched collection has a transfer in this transaction, so washtrace has not read it. That is not the same as clean.'
    : washTrade === null ? NOT_JUDGED
    : washTrade ? 'The lenses on the right flag it. The reason is beside each transfer below; open its token to see the whole pattern.'
    : apartOnly ? `The lens on the right flags it: ${APART_WHY}. The reason is beside each transfer below.`
    : `Its ${transfers.length === 1 ? 'transfer is' : `${transfers.length} transfers are`} read, and no lens that ran flags ${transfers.length === 1 ? 'it' : 'them'}.`;
  // The lens names open that lens's tab when the transaction belongs to one collection; across several there is no one tab.
  const homes = new Set(transfers.flatMap((t) => (t.collection ? [`/c/${t.collection.chainId}/${t.collection.address}`] : [])));
  const home = homes.size === 1 ? [...homes][0]! : null;
  const collection = home === null ? null : transfers.find((t) => t.collection)!.collection!;
  return (
    <>
      <Head
        title={<span className="font-mono">{short(tx)}</span>}
        crumb={[{ href: '/', label: 'Collections' }, ...(home === null ? [] : [{ href: home, label: collection!.name ?? short(collection!.address) }])]}
        sub={<>Transaction on {chainName(chainId)} · <Ext href={explorerTx(chainId, tx)} className="font-mono">{tx}</Ext></>}
      />
      <Answer
        tone={tone}
        title={title}
        aside={by.length > 0 ? <span className="flex flex-col gap-1">{by.map((m) => <LensName key={m} m={m} href={home === null ? undefined : `${home}?method=${m}#evidence`} />)}</span> : undefined}
      >
        {body}{notRun.length > 0 && !unread ? ` ${lensList(notRun)} did not run.` : ''}
      </Answer>
      {transfers.length > 0 ? <Section title="What it moved" lead={TINT_LEAD}><Transfers chainId={chainId} transfers={transfers} collection /></Section> : null}
    </>
  );
}
