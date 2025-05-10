import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { Answer, Head, Section } from '@/components/head';
import { LensName } from '@/components/methods';
import { Transfers } from '@/components/transfers';
import { chainOf, txOf } from '@/lib/api';
import { explorer, short } from '@/lib/format';
import { store } from '@/lib/store';

type Props = { params: Promise<{ chain: string; hash: string }> };

export const metadata: Metadata = { title: 'Transaction' };

/** The console's form of GET /api/transfers/<chain>/<tx>: is this sale a wash trade, and by which lens. */
export default async function TxPage({ params }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const tx = txOf(p.hash);
  if (chainId === null || tx === null) notFound();
  const transfers = await store().transaction(chainId, tx);
  const by = METHODS.filter((m) => transfers.some((t) => t.flags[m]));
  return (
    <>
      <Head
        title={<span className="font-mono">{short(tx)}</span>}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>Transaction · <a className="font-mono hover:underline" href={`${explorer(chainId)}/tx/${tx}`} target="_blank" rel="noreferrer">{tx}</a></>}
      />
      <Answer
        tone={by.includes('A') ? 'cycle' : by.length > 0 ? 'money' : 'clean'}
        title={transfers.length === 0 ? 'Not judged' : by.length === 0 ? 'Not a wash trade by any lens' : 'Flagged as a wash trade'}
        aside={by.length > 0 ? <span className="flex flex-col gap-1">{by.map((m) => <LensName key={m} m={m} />)}</span> : undefined}
      >
        {transfers.length === 0
          ? 'No watched collection has a transfer in this transaction, so washtrace has not read it. That is not the same as clean.'
          : by.length === 0 ? `Its ${transfers.length === 1 ? 'transfer is' : `${transfers.length} transfers are`} read, and no lens flags ${transfers.length === 1 ? 'it' : 'them'}.`
          : 'The lenses on the right flag it. The reason is beside each transfer below; open its token to see the whole pattern.'}
      </Answer>
      {transfers.length > 0 ? <Section title="What it moved"><Transfers chainId={chainId} transfers={transfers} collection /></Section> : null}
    </>
  );
}
