import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { moneyFor } from '@washtrace/detect';
import { ConnectedRail, walletRoles } from '@/components/connected-rail';
import { WhereItSits } from '@/components/sales-strip';
import { Answer, Empty, Head, MoreLink, Section } from '@/components/ui';
import { KindIcon, VerdictChip } from '@/components/kit';
import { RingFigure, ringTone } from '@/components/rings';
import { Time } from '@/components/time';
import { collectionOf } from '@/lib/collection-reads';
import { eth, num, plural, ringName, short, tokenLabel } from '@/lib/format';
import { cardSrc, txHref, walletHref, withFrom } from '@/lib/links';
import { fromParam } from '@/lib/step';
import { layout } from '@/lib/layout';
import { ringDrawing } from '@/lib/views';
import { LoopFigure } from '@/components/token-graph';
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
  // A member opened from here steps through the ring's wallets or tokens, and leads back to it.
  const member = (of: 'wallets' | 'tokens') => fromParam('ring', new URLSearchParams({ anchor, of }), 1);
  // Its loops drawn as a token's are, for a ring small enough to read; the list below holds every wallet either way.
  const drawn = walletsCut ? null : await ringDrawing(store(), chainId, r.c, ring);
  const drawing = drawn === null ? null : layout(drawn.transfers, drawn.flows, drawn.middles);
  // Its wallets on the rail as every item page lists them: a trader by its side of the sales drawn, else "traded"; the rest moved money.
  const sides = new Map((drawn === null ? [] : walletRoles(drawn.transfers, [], [])).map((w) => [w.address, w.role]));
  const railWallets = wallets.map((w) => ({ address: w.address, role: w.traded ? sides.get(w.address) ?? 'traded' : 'moved money' }));
  const name = r.c.name ?? short(address);
  // An empty group is noise beside the other: it is said in the lead instead.
  const groups = [{ title: `Traded (${num(traders.length)})`, list: traders }, { title: `Only moved the money (${num(movers.length)})`, list: movers }].filter((g) => g.list.length > 0);
  return (
    <>
      <Suspense fallback={null}><StepLine chainId={chainId} address={address} from={from} of={{ ring: anchor }} /></Suspense>
      <Head
        kind="ring" title={ringName(line)}
        sub={<>{plural(line.wallets, 'wallet')} · {plural(line.tokens, 'token')} · {line.firstAt === null ? null : line.lastAt! - line.firstAt < DAY ? <><Time ms={line.firstAt} style="date" /> · </> : <><Time ms={line.firstAt} style="date" /> to <Time ms={line.lastAt!} style="date" /> · </>}named by <span className="font-mono">{short(anchor)}</span></>}
        part={<VerdictChip tone={ringTone(line)} />}
      />

      <Answer tone={ringTone(line)} title={line.sales === 0 ? `${plural(line.wallets, 'wallet')}, with no counted sale` : `${plural(line.wallets, 'wallet')} joined by ${plural(line.sales, 'flagged sale')}`}>
        {walletsCut ? null : movers.length === 0 ? 'Every one traded the tokens. ' : traders.length === 0 ? 'Each only moved the money. ' : <>{num(traders.length)} traded the tokens and {num(movers.length)} only moved the money. </>}
        {line.sales === 0 ? 'None of its flagged trades is a counted sale.'
          : <>Its {plural(line.sales, 'flagged sale')}, {num(line.floorSales)} of them round trips, moved {eth(line.volumeWei)} across {plural(line.tokens, 'token')}.</>}
        <p className="mt-2 text-muted-foreground">
          <b className="font-medium text-foreground">What this means:</b>{' '}
          {line.floorSales > 0
            ? 'Tokens went round among these wallets, back to one that sold them. '
            : 'Buyers and sellers among these wallets are linked by money. '}
          A ring is wallets the evidence joins, not one person{line.sales === 0 ? '.' : <>; its sales count toward <Link href={base} className="underline hover:text-foreground">{name}&rsquo;s share</Link>.</>}
        </p>
      </Answer>

      <section aria-label="What it adds up to" className="flex flex-wrap items-center gap-6 rounded-lg border bg-card p-4">
        <RingFigure wallets={wallets} total={line.wallets} />
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">Flagged sales</dt><dd className="text-xl font-semibold tabular-nums"><Link href={sales} prefetch={false} className="hover:underline">{num(line.sales)}</Link></dd></div>
          <div><dt className="text-xs text-muted-foreground">Of them round trips</dt><dd className="text-xl font-semibold tabular-nums"><Link href={tradesHref(base, { ring: anchor, caught: ['A'] })} prefetch={false} className="hover:underline">{num(line.floorSales)}</Link></dd></div>
          <div><dt className="text-xs text-muted-foreground">ETH they moved</dt><dd className="text-xl font-semibold tabular-nums"><Link href={tradesHref(base, { ring: anchor, sort: 'price', dir: 'desc' })} prefetch={false} className="hover:underline">{eth(line.volumeWei, '')}</Link></dd></div>
        </dl>
        <MoreLink href={sales} className="basis-full">All its {plural(line.sales, 'sale')} →</MoreLink>
      </section>

      <Suspense fallback={null}><WhereItSits chainId={chainId} address={address} of={{ ring: anchor }} /></Suspense>
      <Suspense fallback={null}><ConnectedRail chainId={chainId} address={address} wallets={railWallets} salesOf={{ ring: anchor }} /></Suspense>

      {drawing === null || drawn === null ? null : (
        <Section title="What it looks like" lead="Each circle is a wallet of the ring. Solid arrows are its tokens changing hands between them, numbered by block, each opening its trade; dashed arrows are money between them.">
          <LoopFigure drawing={drawing} chainId={chainId} lit={{ edges: [], nodes: [] }} base={base} label={`Transfers and money among the wallets of ${ringName(line)}`}
            rowHrefs={Object.fromEntries(drawn.transfers.map((t, i) => [i + 1, txHref(chainId, t.txHash, base)]))} />
        </Section>
      )}

      <Section title="Who is in it" lead={`Those that traded, then those that only moved the money: a funder, a middle, a payee. A ring is wallets the evidence joins, not one person.${movers.length === 0 ? ' Every wallet listed traded; none only moved the money.' : traders.length === 0 ? ' None listed traded; each only moved the money.' : ''}${walletsCut ? ` The first ${num(wallets.length)} of ${num(line.wallets)} are listed.` : ''}`}>
        <div className="grid gap-4 md:grid-cols-2">
          {groups.map((g) => (
            <div key={g.title} className="rounded-lg border bg-card">
              <h3 className="border-b px-4 py-2 text-sm font-medium">{g.title}</h3>
              <ul className="divide-y">
                {g.list.map((w) => (
                  <li key={w.address}>
                    <HoverCard className="block" src={cardSrc(base, 'wallet', w.address)}>
                      <Link href={withFrom(walletHref(chainId, w.address, base), member('wallets'))} prefetch={false} className="flex items-center gap-2 px-4 py-1.5 font-mono text-sm hover:bg-muted/60">
                        <KindIcon kind="wallet" className={w.traded ? 'text-foreground' : 'text-flow'} />{short(w.address)}
                      </Link>
                    </HoverCard>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Which tokens" lead="The tokens its flagged sales were of, the most ETH first. Open one to see the loop.">
        {tokens.length === 0 ? <Empty>None of its flagged trades is a counted sale.</Empty> : (
          <ul className="divide-y rounded-lg border bg-card">
            {tokens.map((t) => (
              <li key={t.tokenId} className="flex items-center gap-3 px-4 py-2 text-sm">
                <HoverCard className="flex flex-1" src={cardSrc(base, 'token', t.tokenId)}><Link href={withFrom(`${base}/t/${t.tokenId}`, member('tokens'))} prefetch={false} className="flex items-center gap-2 font-mono font-medium hover:underline"><KindIcon kind="token" />#{tokenLabel(t.tokenId)}</Link></HoverCard>
                <Link href={tradesHref(base, { ring: anchor, token: t.tokenId })} prefetch={false} className="text-xs text-muted-foreground tabular-nums hover:underline">{plural(t.sales, 'sale')}</Link>
                <Link href={tradesHref(base, { ring: anchor, token: t.tokenId, sort: 'price', dir: 'desc' })} prefetch={false} className="w-20 text-right tabular-nums hover:underline">{eth(t.volumeWei)}</Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
