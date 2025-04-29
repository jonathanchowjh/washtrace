import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Head, Section } from '@/components/head';
import { Transfers, Wallet } from '@/components/transfers';
import { addressOf, chainOf } from '@/lib/api';
import { chainName } from '@/lib/chains';
import { clock, explorer, short } from '@/lib/format';
import { store } from '@/lib/store';

type Props = { params: Promise<{ chain: string; address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: short(address) };
}

/** One wallet: whether its money has been read, who it moved money with, and every watched transfer it was in. */
export default async function WalletPage({ params }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const s = store();
  const [funding, counterparties, transfers] = await Promise.all([s.wallet(chainId, address), s.counterparties(chainId, address), s.walletTransfers(chainId, address)]);
  const flagged = transfers.filter((t) => Object.keys(t.flags).length > 0).length;

  const state = funding === null ? 'Not in any watched collection, so its money is not read.'
    : funding.status === 'pending' ? `Money not read yet: queued behind busier wallets (${funding.transfers} transfers).`
    : funding.status === 'failed' ? `Reading its money failed: ${funding.error ?? 'unknown error'}. Retried hourly.`
    : `Money read ${clock(funding.fetchedAt)}${funding.truncated ? ': more history than Etherscan pages through, so it is never treated as a middle' : ''}.`;

  return (
    <>
      <Head
        title={<span className="font-mono">{short(address)}</span>}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>{chainName(chainId)} · <a className="font-mono hover:underline" href={`${explorer(chainId)}/address/${address}`} target="_blank" rel="noreferrer">{address}</a></>}
      />
      <p className="mt-3 text-xs">{state}</p>
      <Section title="Transfers in watched collections" aside={`${flagged} of ${transfers.length} flagged by some method`}>
        <Transfers chainId={chainId} transfers={transfers} collection />
      </Section>
      <Section title="Money moved with" aside="native, internal and wrapped-native flows, both directions">
        {counterparties.length === 0 ? <p className="rounded-md border bg-card p-4 text-muted-foreground">No flows read.</p> : (
          <div className="overflow-x-auto rounded-md border bg-card">
            <table className="w-full min-w-[30rem] text-left">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">Wallet</th>
                  <th className="px-3 py-2 text-right font-medium">Flows</th>
                  <th className="px-3 py-2 text-right font-medium">Sent to</th>
                  <th className="px-3 py-2 text-right font-medium">Received from</th>
                  <th className="px-3 py-2 font-medium">Trades in a watched collection</th>
                </tr>
              </thead>
              <tbody>
                {counterparties.map((c) => (
                  <tr key={c.address} className="border-b last:border-b-0">
                    <td className="px-3 py-1.5"><Wallet chainId={chainId} address={c.address} /></td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{c.flows}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{c.sent}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{c.received}</td>
                    <td className="px-3 py-1.5">{c.watched ? 'yes' : <span className="text-muted-foreground">no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
