import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { moneyFor } from '@washtrace/detect';
import { Empty, Head, MoreLink, Section } from '@/components/ui';
import { KindIcon, TierMark } from '@/components/kit';
import { RingFigure, ringName, ringTone } from '@/components/rings';
import { Time } from '@/components/time';
import { collectionOf } from '@/lib/collection-reads';
import { eth, num, plural, short, tokenLabel } from '@/lib/format';
import { cardSrc, walletHref } from '@/lib/links';
import { HoverCard } from '@/components/hover-card';
import { addressOf, chainOf } from '@/lib/params';
import { store } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';
import { cache, Suspense } from 'react';
import { StepLine } from '@/components/step-line';

type Props = { params: Promise<{ chain: string; address: string; anchor: string }>; searchParams?: Promise<{ from?: string }> };

/** Under a day apart, its first and last trades read as one date. */
const DAY = 86_400_000;

/** The ring of a collection named by `anchor`, read once a request: its tab title and its page both need it. Cached on the path's words, which both are given. */
const ringAt = cache(async (chain: string, collection: string, at: string) => {
  const chainId = chainOf(chain);
  const address = addressOf(collection);
  const anchor = addressOf(at);
  if (chainId === null || address === null || anchor === null) return null;
  const c = await collectionOf(chainId, address);
  if (!c) return null;
  const ring = await store().ring(c.id, anchor, { money: moneyFor(chainId) });
  return { chainId, address, anchor, c, ring };
});

async function ringOf({ params }: Props) {
  const p = await params;
  return ringAt(p.chain, p.address, p.anchor);
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await ringOf(props);
  return { title: r?.ring ? `${ringName(r.ring.line)} · ${r.c.name ?? short(r.address)}` : 'Ring' };
}

/**
 * One ring: who is in it (those that traded, and those that only moved the
 * money), the tokens its flagged sales were of, and what they add up to. Its
 * sales are on Trades, filtered to the ring.
 */
export default async function RingPage(props: Props) {
  await connection();
  const r = await ringOf(props);
  if (r === null) notFound();
  const { chainId, address, anchor, ring } = r;
  const base = `/c/${chainId}/${address}`;
  if (ring === null) {
    return (
      <>
        <Head kind="ring" title={`The ring of ${short(anchor)}`} />
        <Empty>No ring of the latest analysis is named by {short(anchor)}. A new analysis can join rings or split them; the list has today&rsquo;s.</Empty>
        <MoreLink href={`${base}/rings`}>All rings</MoreLink>
      </>
    );
  }
  const { line, wallets, walletsCut, tokens } = ring;
  const from = (await props.searchParams)?.from;
  const traders = wallets.filter((w) => w.traded);
  const movers = wallets.filter((w) => !w.traded);
  const sales = tradesHref(base, { ring: anchor });
  return (
    <>
      {from === undefined ? null : <Suspense fallback={null}><StepLine c={r.c} from={from} id={anchor} /></Suspense>}
      <Head
        kind="ring" title={ringName(line)}
        sub={<>{plural(line.wallets, 'wallet')} · {plural(line.tokens, 'token')} · {line.firstAt === null ? null : line.lastAt! - line.firstAt < DAY ? <><Time ms={line.firstAt} style="date" /> · </> : <><Time ms={line.firstAt} style="date" /> to <Time ms={line.lastAt!} style="date" /> · </>}named by <span className="font-mono">{short(anchor)}</span></>}
        part={<span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium"><TierMark tone={ringTone(line)} />{line.floorSales > 0 ? 'Round trips · the floor' : 'Linked by money · the ceiling'}</span>}
      />

      <section aria-label="What it adds up to" className="flex flex-wrap items-center gap-6 rounded-lg border bg-card p-4">
        <RingFigure wallets={wallets} total={line.wallets} />
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">Flagged sales</dt><dd className="text-xl font-semibold tabular-nums"><Link href={sales} className="hover:underline">{num(line.sales)}</Link></dd></div>
          <div><dt className="text-xs text-muted-foreground">Of them round trips</dt><dd className="text-xl font-semibold tabular-nums"><Link href={tradesHref(base, { ring: anchor, caught: ['A'] })} className="hover:underline">{num(line.floorSales)}</Link></dd></div>
          <div><dt className="text-xs text-muted-foreground">ETH they moved</dt><dd className="text-xl font-semibold tabular-nums"><Link href={tradesHref(base, { ring: anchor, sort: 'price', dir: 'desc' })} className="hover:underline">{eth(line.volumeWei, '')}</Link></dd></div>
        </dl>
        <MoreLink href={sales} className="basis-full">All its {plural(line.sales, 'sale')} →</MoreLink>
      </section>

      <Section title="Who is in it" lead={`Those that traded, then those that only moved the money: a funder, a middle, a payee. A ring is wallets the evidence joins, not one person.${walletsCut ? ` The first ${num(wallets.length)} of ${num(line.wallets)} are listed.` : ''}`}>
        <div className="grid gap-4 md:grid-cols-2">
          {[{ title: `Traded (${num(traders.length)})`, list: traders }, { title: `Only moved the money (${num(movers.length)})`, list: movers }].map((g) => (
            <div key={g.title} className="rounded-lg border bg-card">
              <h3 className="border-b px-4 py-2 text-sm font-medium">{g.title}</h3>
              {g.list.length === 0 ? <p className="px-4 py-2 text-sm text-muted-foreground">None.</p> : (
                <ul className="divide-y">
                  {g.list.map((w) => (
                    <li key={w.address}>
                      <HoverCard className="block" src={cardSrc(base, 'wallet', w.address)}>
                        <Link href={walletHref(chainId, w.address, base)} className="flex items-center gap-2 px-4 py-1.5 font-mono text-sm hover:bg-muted/60">
                          <KindIcon kind="wallet" className={w.traded ? 'text-foreground' : 'text-flow'} />{short(w.address)}
                        </Link>
                      </HoverCard>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Which tokens" lead="The tokens its flagged sales were of, the most ETH first. Open one to see the loop.">
        {tokens.length === 0 ? <Empty>None of its flagged trades is a counted sale.</Empty> : (
          <ul className="divide-y rounded-lg border bg-card">
            {tokens.map((t) => (
              <li key={t.tokenId} className="flex items-center gap-3 px-4 py-2 text-sm">
                <HoverCard className="flex flex-1" src={cardSrc(base, 'token', t.tokenId)}><Link href={`${base}/t/${t.tokenId}`} className="flex items-center gap-2 font-mono font-medium hover:underline"><KindIcon kind="token" />#{tokenLabel(t.tokenId)}</Link></HoverCard>
                <Link href={tradesHref(base, { ring: anchor, token: t.tokenId })} className="text-xs text-muted-foreground tabular-nums hover:underline">{plural(t.sales, 'sale')}</Link>
                <Link href={tradesHref(base, { ring: anchor, token: t.tokenId, sort: 'price', dir: 'desc' })} className="w-20 text-right tabular-nums hover:underline">{eth(t.volumeWei)}</Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
