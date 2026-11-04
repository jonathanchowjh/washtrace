import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Answer, Elsewhere, Head, Section } from '@/components/head';
import { LensName } from '@/components/methods';
import { TokenGraph } from '@/components/token-graph';
import { Transfers, because, reasons, rowList } from '@/components/transfers';
import { addressOf, chainOf, tokenIdOf } from '@/lib/api';
import { lensList, short } from '@/lib/format';
import { tokenLinks } from '@/lib/links';
import { layout } from '@/lib/layout';
import { verdict } from '@/lib/metrics';
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
  // tokenView has already dropped the lenses that did not run.
  const { collection, flows, middles, latest, transfers } = view;
  const name = collection.name ?? short(address);
  const base = `/c/${chainId}/${address}`;
  const { washTrade, judged: judgedAll, by, apartOnly, notRun } = verdict(transfers.map((t) => ({ t, latest })));
  const flagged = transfers.filter((t) => by.some((m) => t.flags[m])).length;
  const title = washTrade === true ? (by.includes('A') ? 'Its trades go round in circles' : 'Its buyers and sellers are linked by money')
    : washTrade === null ? 'Not judged yet'
    : apartOnly ? 'Flagged only by Money loops back, which is not counted'
    : notRun.length === 0 ? 'No sign of wash trading'
    : 'Not flagged by the lenses that ran';
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
        title={title}
      >
        {washTrade === null ? (
          <>
            Its transfers are read, but no analysis has covered them yet. That is not the same as clean.
            {by.length > 0 ? ` ${flagged} of ${transfers.length} transfers are flagged by ${lensList(by)}.` : ''}
            {notRun.length > 0 ? ` ${lensList(notRun)} did not run.` : ''}
          </>
        ) : apartOnly ? (
          <>{flagged} of {transfers.length} transfers flagged, by {lensList(by)}. It flags about as many sales as randomly paired wallets do, so it is not counted.</>
        ) : by.length === 0 ? (
          <>None of its {transfers.length} transfers is flagged by {notRun.length > 0 ? 'the lenses that ran' : 'any lens'}.{notRun.length > 0 ? ` ${lensList(notRun)} did not run.` : ''}</>
        ) : (
          <>
            {flagged} of {transfers.length} transfers flagged, by {lensList(by)}.{' '}
            They count toward <Link href={`${base}?method=${by[0]}`} className="underline hover:text-foreground">{name}&rsquo;s share</Link> under each of those lenses.
          </>
        )}
        {by.length > 0 && !apartOnly ? (
          <p className="mt-2 text-muted-foreground">
            <b className="font-medium text-foreground">What this means:</b>{' '}
            {by.includes('A')
              ? 'This is the strictest lens: its trades return to a wallet that sold it. The loop is drawn below.'
              : `${lensList(by)} found this: a buyer and a seller of the token are linked by money. The money paths are the dashed arrows below.`}
          </p>
        ) : null}
      </Answer>

      <div className="grid gap-x-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title="What it looks like" lead="Each circle is a wallet. Solid arrows are the token changing hands, numbered as in the table below; dashed arrows are money between the same wallets.">
          <TokenGraph drawing={layout(transfers, flows, middles)} chainId={chainId} />
        </Section>
        <Section title="Why it was flagged" lead={why.length === 0 ? undefined : 'One line per pattern found, with the transfers it covers and the lenses that agree on it.'}>
          {why.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">{judgedAll ? <>No lens found a pattern: the token never returns to a wallet that held it{notRun.length > 0 ? `, and ${lensList(notRun)} did not run` : ', and no buyer and seller are linked by money'}.</> : 'No analysis has covered these transfers yet, so no lens has looked for a pattern.'}</p>
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
