import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Answer, Elsewhere, Empty, Head, Section } from '@/components/head';
import { Transfers, Wallet } from '@/components/transfers';
import { addressOf, chainOf } from '@/lib/api';
import { chainName } from '@/lib/chains';
import { LENSES, explorer, lensList, plural, short } from '@/lib/format';
import { walletLinks } from '@/lib/links';
import { HEADLINE, TINT_LEAD, answer, counted, toneOf } from '@/lib/metrics';
import { COUNTERPARTIES, TRADES, walletView } from '@/lib/views';
import { Time } from '@/components/time';

type Props = { params: Promise<{ chain: string; address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: short(address) };
}

/** One wallet: whether its trades look washed, which ones, and the money links the lenses followed to say so. */
export default async function WalletPage({ params }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const view = await walletView(chainId, address);
  const { funding, counterparties, transfers, cut, by, washTrade } = view;
  const hits = transfers.filter(counted);
  const hit = hits.length;
  // Shown tinted grey, yet outside the verdict: say so, or the title and the rows contradict each other.
  const apart = transfers.filter((t) => toneOf(t) === 'apart').length;
  const tokens = new Set(hits.map((t) => `${t.collection?.address}:${t.tokenId}`)).size;
  const linked = counterparties.filter((c) => c.watched).length;
  const of = cut.trades ? `its latest ${TRADES}` : String(transfers.length);
  const { title, tone } = transfers.length === 0 ? { title: 'Not in any watched collection', tone: 'clean' as const }
    : answer(view, `In ${hit} flagged ${hit === 1 ? 'trade' : 'trades'} out of ${of}`);
  // Only an apart title says it already; beside counted trades the grey ones are "more", alone they are not.
  const apartNote = apart === 0 || tone === 'apart' ? null
    : `${apart}${hit > 0 ? ' more' : ''} ${apart === 1 ? 'is' : 'are'} flagged only by ${LENSES.AU.name}, which is not counted.`;

  const money = funding === null ? 'Its money is not read: it never traded a watched collection.'
    : funding.status === 'pending' ? `Its money is not read yet: queued behind busier wallets (it is in ${plural(funding.transfers, 'transfer')}). Until it is, ${LENSES.AU.name} and ${LENSES.AC.name} cannot see its links.`
    : funding.status === 'failed' ? `Reading its money failed: ${funding.error ?? 'unknown error'}. Retried hourly; until then ${LENSES.AU.name} and ${LENSES.AC.name} cannot see its links.`
    : <>Its money was read {funding.fetchedAt === null ? 'from stored data' : <Time ms={funding.fetchedAt} />}{funding.truncated ? '. It has more history than Etherscan pages through, so it is never treated as the shared funder between two others' : ''}.</>;

  return (
    <>
      <Head
        title={<span className="font-mono">{short(address)}</span>}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>Wallet on {chainName(chainId)} · <a className="font-mono hover:underline" href={`${explorer(chainId)}/address/${address}`} target="_blank" rel="noreferrer">{address}</a></>}
      >
        <Elsewhere links={walletLinks(chainId, address)} />
      </Head>

      <Answer tone={tone} title={title}>
        {transfers.length > 0 && washTrade === null ? <p>Some of its trades are read, but no analysis has covered them yet. That is not the same as clean.</p> : null}
        {hit > 0 ? <p>Across {plural(tokens, 'token')}, flagged by {lensList(by.filter((m) => HEADLINE.includes(m)))}.</p> : null}
        {apartNote === null ? null : <p className="text-muted-foreground">{apartNote}</p>}
        <p className="text-muted-foreground">{money}</p>
      </Answer>

      <Section title="Which of its trades?" lead={<>{cut.trades ? `Its latest ${TRADES} trades are shown; older ones are not, so the verdict above covers these only.` : 'Every transfer it sent or received in a watched collection.'} {TINT_LEAD} Open the token to see the pattern.</>}>
        <Transfers chainId={chainId} transfers={transfers} collection />
      </Section>

      <Section
        title="Who did it move money with?"
        lead={<>{cut.counterparties ? `Its ${COUNTERPARTIES} busiest counterparties are shown; the rest are not. ` : ''}These are the links {LENSES.AU.name} and {LENSES.AC.name} follow. A counterparty that also trades a watched collection is the kind of link that flags a trade{linked > 0 ? `: ${linked} here do` : ''}.</>}
        aside="native, internal and wrapped-native flows, both directions"
      >
        {counterparties.length === 0 ? <Empty>No money flows read for this wallet.</Empty> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">Wallet</th>
                  <th className="px-3 py-2 font-medium">Also trades a watched collection</th>
                  <th className="px-3 py-2 text-right font-medium">Payments sent to it</th>
                  <th className="px-3 py-2 text-right font-medium">Payments received from it</th>
                </tr>
              </thead>
              <tbody>
                {counterparties.map((c) => (
                  <tr key={c.address} className={c.watched ? 'border-b bg-muted/60 last:border-b-0' : 'border-b last:border-b-0'}>
                    <td className="px-3 py-1.5"><Wallet chainId={chainId} address={c.address} /></td>
                    <td className="px-3 py-1.5">{c.watched ? <span className="font-medium text-foreground">yes</span> : <span className="text-muted-foreground">no</span>}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{c.sent}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{c.received}</td>
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
