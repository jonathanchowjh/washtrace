import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { moneyFor } from '@washtrace/detect';
import { NO_FILTER } from '@washtrace/detect/trades';
import { Elsewhere, Empty, Ext, Head, Silent } from '@/components/ui';
import { Facts, HowSure, NotCounted, ReadingStrip, TopList, YourLenses } from '@/components/overview';
import { SQUARES, SalesStrip } from '@/components/sales-strip';
import { RingsTable } from '@/components/rings';
import { RangeBar, RangeFigure, RangeKey, VolumeDetail } from '@/components/methods';
import { Refresh } from '@/components/refresh';
import { readerZone } from '@/lib/api';
import { mayWrite } from '@/lib/auth';
import { chainName } from '@/lib/chains';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { analysisWaitText, analyzingOn } from '@/lib/coverage';
import { num, plural, short } from '@/lib/format';
import { collectionLinks, explorerAddress } from '@/lib/links';
import { lensContext, range } from '@/lib/metrics';
import { addressOf, chainOf } from '@/lib/params';
import { pipeline } from '@/lib/pipeline';
import { configFromSources } from '@/lib/settings';
import { workerSilent } from '@/lib/status';
import { store, storedEntry } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';

/** The top tokens and wallets the overview lists; the rest are a click away. */
const TOP = 5;

/** The top rings, under Who did it. */
const RINGS_TOP = 3;

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** What the lens panel read from this page's address bar before it moved to Methods: such a link is sent on there. */
const PANEL_PARAMS = ['method', 'lens', 'tp', 'ts', 'tq', 'wp', 'ws', 'wq'];

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const c = chainId === null || address === null ? null : await collectionOf(chainId, address);
  return { title: c?.name ?? short(p.address) };
}

/**
 * One collection at a glance: how far it is read, the answer as a range, how
 * sure each end is, every sale in order, where the flagged ETH went, what is
 * left out and why, and your lenses. Each part opens what it counts; the
 * lenses, their history and the six reading stages are on Methods.
 */
export default async function CollectionPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const base = `/c/${chainId}/${address}`;
  const sp = await searchParams;
  // An old link into the lens panel: its lens, editor and list pages are on Methods now.
  const panel = new URLSearchParams();
  for (const k of PANEL_PARAMS) { const v = sp[k]; if (typeof v === 'string') panel.set(k, v); }
  if (panel.size > 0) redirect(`${base}/methods?${panel}`);
  const s = store();
  const c = await collectionOf(chainId, address);
  if (!c) notFound();
  const runs = await runsOf(c.id);
  const zone = await readerZone();
  const ctx = { money: moneyFor(chainId), zone, ...lensContext(c.latest, runs) };
  const a = c.latest;
  // The lists are Linked wallets', the ceiling: the widest counted lens, so every flagged token and wallet is in them.
  const listed = ctx.ran.includes('AC');
  const top = { sort: 'volume', find: null, limit: TOP, offset: 0 } as const;
  // A small collection's strip is a square per sale, oldest first: every sale is read, and the strip checks it has them all.
  const few = a !== null && a.totals.A.sales <= SQUARES;
  // Who did it: the top rings, once the latest analysis's are worked out.
  const ringed = a !== null && (a.rings ?? 0) > 0;
  const [profile, timeline, tokens, wallets, passes, all, sources, settings, entry, sold, rings] = await Promise.all([
    s.profile(c.id), a ? s.timeline(c.id, zone) : null,
    listed ? s.lensTokens(c.id, 'AC', top, ctx) : null, listed ? s.lensWallets(c.id, 'AC', top, ctx) : null,
    s.passes(), s.collections(), s.sources(), s.settings(), storedEntry(chainId, address),
    few ? s.trades(c.id, { ...NO_FILTER, sort: 'date', dir: 'asc' }, ctx, SQUARES + 1, 0) : null,
    ringed ? s.rings(c.id, ctx, RINGS_TOP, 0) : null,
  ]);
  const config = configFromSources(sources, settings);
  const rpcChains = new Set(config.chains);
  const silent = workerSilent(passes, Date.now());
  const stages = pipeline({ c, entry, rpcChains, funding: config.funding, analyzing: analyzingOn(passes, c.id), silent: silent !== null });
  const why = analysisWaitText(c, passes.find((x) => x.job === 'analyze'), new Map(all.map((o) => [o.id, o.name ?? short(o.address)])), rpcChains, Date.now(), zone, silent !== null);
  const writable = mayWrite(process.env, await headers());
  const sales = a === null ? null : range(a.totals, 'sales');
  const volume = a === null ? null : range(a.totals, 'volume');
  const apart = (timeline?.points ?? []).reduce((n, x) => n + x.apartSales, 0);

  return (
    <>
      <Head
        kind="collection"
        title={c.name ?? short(address)}
        sub={<>{chainName(chainId)}{c.contract?.symbol ? ` · ${c.contract.symbol}` : ''} · <Ext href={explorerAddress(chainId, address)} className="font-mono">{short(address)}</Ext></>}
      >
        <Elsewhere links={collectionLinks(chainId, address)} />
        <Refresh />
      </Head>
      <div className="-mt-2 mb-4"><Facts profile={profile} creator={c.contract?.creator ?? null} base={base} chainId={chainId} /></div>

      {silent ? <Silent silent={silent} /> : null}
      <div className="mb-4"><ReadingStrip stages={stages} base={base} /></div>

      {a === null ? <Empty>{why}</Empty> : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <section aria-label="The answer" className="rounded-lg border bg-card p-4">
              {sales === null ? <p className="text-sm text-muted-foreground">No sale read yet.</p> : (
                <>
                  <p className="text-sm font-medium text-foreground">{sales.highShare === 0 ? 'Nothing looks like wash trading' : 'Looks like wash trading'}</p>
                  <p className="mt-1 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                      <RangeFigure range={sales} end={(text, m) => <Link href={tradesHref(base, { caught: [m] })} className="hover:underline">{text}</Link>} />
                    </span>
                    <span className="text-sm text-muted-foreground">of sales</span>
                  </p>
                  <RangeBar range={sales} className="mt-2" />
                  <div className="mt-1.5"><RangeKey range={sales} /></div>
                  <p className="mt-3 text-sm tabular-nums text-muted-foreground">
                    <Link href={tradesHref(base, { caught: [sales.low] })} className="hover:underline">{num(a.totals[sales.low].flaggedSales)}</Link>
                    {sales.low === sales.high ? null : <>–<Link href={tradesHref(base, { caught: [sales.high] })} className="hover:underline">{num(a.totals[sales.high].flaggedSales)}</Link></>}
                    {' of '}<Link href={tradesHref(base, {})} className="hover:underline">{num(a.totals.A.sales)}</Link> sales
                    {volume === null ? null : <> · <VolumeDetail volume={volume} totals={a.totals} base={base} /></>}
                  </p>
                </>
              )}
              <Link href={tradesHref(base, {})} className="mt-3 block text-sm font-medium text-foreground hover:underline">All {plural(a.totals.A.sales, 'trade')} ›</Link>
            </section>
            <HowSure totals={a.totals} base={base} apart={timeline === null ? undefined : apart} />
          </div>

          {timeline ? <SalesStrip timeline={timeline} base={base} zone={zone} chainId={chainId} sales={sold} /> : null}

          {rings && rings.total > 0 ? (
            <section aria-label="Who did it">
              <h2 className="mb-2 flex items-baseline justify-between gap-3 text-sm font-medium text-foreground">
                <span>Who did it</span>
                <span className="text-xs font-normal text-muted-foreground">Top {Math.min(RINGS_TOP, rings.total)} of {plural(rings.total, 'ring')}: wallets the evidence ties together, not one person</span>
              </h2>
              <RingsTable rows={rings.rows} base={base} chainId={chainId} total={rings.total} />
            </section>
          ) : null}

          {tokens && wallets ? (
            <div className="grid gap-4 md:grid-cols-2">
              <TopList kind="tokens" rows={tokens.rows} total={tokens.total} base={base} chainId={chainId} />
              <TopList kind="wallets" rows={wallets.rows} total={wallets.total} base={base} chainId={chainId} />
            </div>
          ) : null}

          <NotCounted apart={apart} base={base} />
          <YourLenses runs={runs} base={base} writable={writable} />
        </div>
      )}
    </>
  );
}
