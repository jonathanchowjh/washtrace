import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { Head, Section } from '@/components/head';
import { Transfers } from '@/components/transfers';
import { chainOf, txOf } from '@/lib/api';
import { METHOD_NAMES, explorer, short } from '@/lib/format';
import { store } from '@/lib/store';

type Props = { params: Promise<{ chain: string; hash: string }> };

export const metadata: Metadata = { title: 'Transaction' };

/** The console's form of GET /api/transfers/<chain>/<tx>: is this sale a wash trade, and by which method. */
export default async function TxPage({ params }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const tx = txOf(p.hash);
  if (chainId === null || tx === null) notFound();
  const transfers = await store().transaction(chainId, tx);
  const methods = METHODS.filter((m) => transfers.some((t) => t.flags[m]));
  const verdict = transfers.length === 0 ? 'No watched collection has a transfer in this transaction, so it has not been judged.'
    : methods.length === 0 ? 'Not flagged by any method.'
    : `Flagged by ${methods.map((m) => METHOD_NAMES[m]).join(', ')}.`;
  return (
    <>
      <Head
        title={<span className="font-mono">{short(tx)}</span>}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<a className="font-mono hover:underline" href={`${explorer(chainId)}/tx/${tx}`} target="_blank" rel="noreferrer">{tx}</a>}
      />
      <p className={methods.length > 0 ? 'mt-3 font-medium text-cycle' : 'mt-3'}>{verdict}</p>
      {transfers.length > 0 ? <Section title="Transfers in it"><Transfers chainId={chainId} transfers={transfers} collection /></Section> : null}
    </>
  );
}
