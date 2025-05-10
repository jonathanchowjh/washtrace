import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { Answer, Elsewhere, Head, Section } from '@/components/head';
import { LensName } from '@/components/methods';
import { TokenGraph } from '@/components/token-graph';
import { Transfers, because, reasons, rowList } from '@/components/transfers';
import { addressOf, chainOf, tokenIdOf } from '@/lib/api';
import { lensList, short } from '@/lib/format';
import { tokenLinks } from '@/lib/links';
import { layout } from '@/lib/layout';
import { tokenView } from '@/lib/views';

type Props = { params: Promise<{ chain: string; address: string; tokenId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tokenId } = await params;
  return { title: `#${tokenId}` };
}

/**
 * One token: whether its trades look washed, why, in a sentence per pattern,
 * the graph that shows the pattern, and every transfer it is drawn from.
 */
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
  const name = collection.name ?? short(address);
  const base = `/c/${chainId}/${address}`;
  const by = METHODS.filter((m) => transfers.some((t) => t.flags[m]));
  const flagged = transfers.filter((t) => METHODS.some((m) => t.flags[m])).length;
  const why = reasons(transfers);

  return (
    <>
      <Head
        title={`${name} #${tokenId.length > 20 ? `${tokenId.slice(0, 18)}…` : tokenId}`}
        crumb={[{ href: '/', label: 'Collections' }, { href: base, label: name }]}
        sub={`${transfers.length} transfers, in the order the chain recorded them`}
      >
        <Elsewhere links={tokenLinks(chainId, address, tokenId)} />
      </Head>

      <Answer
        tone={by.includes('A') ? 'cycle' : by.length > 0 ? 'money' : 'clean'}
        title={by.includes('A') ? 'Its trades go round in circles' : by.length > 0 ? 'Its buyers and sellers are linked by money' : 'No sign of wash trading'}
      >
        {by.length === 0 ? (
          <>None of its {transfers.length} transfers is flagged by any lens.</>
        ) : (
          <>
            {flagged} of {transfers.length} transfers flagged, by {lensList(by)}.{' '}
            They count toward <Link href={`${base}?method=${by[0]}`} className="underline hover:text-foreground">{name}&rsquo;s share</Link> under each of those lenses.
          </>
        )}
      </Answer>

      <div className="grid gap-x-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title="What it looks like" lead="Each circle is a wallet. Solid arrows are the token changing hands, numbered as in the table below; dashed arrows are money between the same wallets.">
          <TokenGraph drawing={layout(transfers, flows, middles)} chainId={chainId} />
        </Section>
        <Section title="Why it was flagged" lead={why.length === 0 ? undefined : 'One line per pattern found, with the transfers it covers and the lenses that agree on it.'}>
          {why.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">No lens found a pattern: the token never returns to a wallet that held it, and no buyer and seller are linked by money.</p>
          ) : (
            <ul className="space-y-2">
              {why.map((r, i) => (
                <li key={i} className="rounded-lg border bg-card p-3.5">
                  <p className="text-sm text-foreground">{because(r.witness, chainId)}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>transfer{r.rows.length === 1 ? '' : 's'} <a href={`#t${r.rows[0]}`} className="font-medium text-foreground underline">{rowList(r.rows)}</a></span>
                    {r.methods.map((m) => <LensName key={m} m={m} className="text-xs" />)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Every transfer" lead="Tinted rows are flagged. The number in the first column is the arrow's label in the graph.">
        <Transfers chainId={chainId} transfers={transfers} numbered />
      </Section>
    </>
  );
}
