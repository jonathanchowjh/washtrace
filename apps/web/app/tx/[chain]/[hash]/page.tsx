import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Answer, Head, Section } from '@/components/head';
import { LensName } from '@/components/methods';
import { Transfers } from '@/components/transfers';
import { chainOf, txOf } from '@/lib/api';
import { explorer, lensList, short } from '@/lib/format';
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
  const { transfers, washTrade, by, apartOnly, notRun } = await txView(chainId, tx);
  const unread = transfers.length === 0;
  const title = unread ? 'Not judged'
    : washTrade === true ? 'Flagged as a wash trade'
    : washTrade === null ? 'Not judged yet'
    : apartOnly ? 'Flagged only by Money loops back, which is not counted'
    : notRun.length === 0 ? 'Not a wash trade by any lens'
    : 'Not flagged by the lenses that ran';
  const body = unread ? 'No watched collection has a transfer in this transaction, so washtrace has not read it. That is not the same as clean.'
    : washTrade === null ? 'Its transfers are read, but no analysis has covered them yet. That is not the same as clean.'
    : washTrade ? 'The lenses on the right flag it. The reason is beside each transfer below; open its token to see the whole pattern.'
    : by.length > 0 ? 'The lens on the right flags it, but Money loops back flags about as many sales as randomly paired wallets do, so it is not counted. The reason is beside each transfer below.'
    : `Its ${transfers.length === 1 ? 'transfer is' : `${transfers.length} transfers are`} read, and no lens that ran flags ${transfers.length === 1 ? 'it' : 'them'}.`;
  return (
    <>
      <Head
        title={<span className="font-mono">{short(tx)}</span>}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>Transaction · <a className="font-mono hover:underline" href={`${explorer(chainId)}/tx/${tx}`} target="_blank" rel="noreferrer">{tx}</a></>}
      />
      <Answer
        tone={washTrade ? (by.includes('A') ? 'cycle' : 'money') : by.length > 0 ? 'money' : 'clean'}
        title={title}
        aside={by.length > 0 ? <span className="flex flex-col gap-1">{by.map((m) => <LensName key={m} m={m} />)}</span> : undefined}
      >
        {body}{notRun.length > 0 && !unread ? ` ${lensList(notRun)} did not run.` : ''}
      </Answer>
      {transfers.length > 0 ? <Section title="What it moved"><Transfers chainId={chainId} transfers={transfers} collection /></Section> : null}
    </>
  );
}
