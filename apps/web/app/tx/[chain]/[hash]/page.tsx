import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Answer, Head, Section } from '@/components/head';
import { LensName } from '@/components/methods';
import { Transfers } from '@/components/transfers';
import { chainOf, txOf } from '@/lib/api';
import { explorer, lensList, short } from '@/lib/format';
import { APART_WHY, NOT_JUDGED, TINT_LEAD, answer } from '@/lib/metrics';
import { txView } from '@/lib/views';

type Props = { params: Promise<{ chain: string; hash: string }> };

export const metadata: Metadata = { title: 'Transaction' };

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
  const { title, tone } = unread ? { title: 'Not judged', tone: 'clean' as const } : answer(v, 'Flagged as a wash trade');
  const body = unread ? 'No watched collection has a transfer in this transaction, so washtrace has not read it. That is not the same as clean.'
    : washTrade === null ? NOT_JUDGED
    : washTrade ? 'The lenses on the right flag it. The reason is beside each transfer below; open its token to see the whole pattern.'
    : apartOnly ? `The lens on the right flags it: ${APART_WHY}. The reason is beside each transfer below.`
    : `Its ${transfers.length === 1 ? 'transfer is' : `${transfers.length} transfers are`} read, and no lens that ran flags ${transfers.length === 1 ? 'it' : 'them'}.`;
  return (
    <>
      <Head
        title={<span className="font-mono">{short(tx)}</span>}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>Transaction · <a className="font-mono hover:underline" href={`${explorer(chainId)}/tx/${tx}`} target="_blank" rel="noreferrer">{tx}</a></>}
      />
      <Answer
        tone={tone}
        title={title}
        aside={by.length > 0 ? <span className="flex flex-col gap-1">{by.map((m) => <LensName key={m} m={m} />)}</span> : undefined}
      >
        {body}{notRun.length > 0 && !unread ? ` ${lensList(notRun)} did not run.` : ''}
      </Answer>
      {transfers.length > 0 ? <Section title="What it moved" lead={TINT_LEAD}><Transfers chainId={chainId} transfers={transfers} collection /></Section> : null}
    </>
  );
}
