import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Pipeline, ReadingSummary } from '@/components/coverage';
import { Elsewhere, Empty, Head, Section, Silent } from '@/components/head';
import { LensList, clampedPage, listView } from '@/components/lens-lists';
import { History, LensCards, LensStats, RangeBar, RangeKey, Trend } from '@/components/methods';
import { Refresh } from '@/components/refresh';
import { Time } from '@/components/time';
import { Wallet } from '@/components/transfers';
import { CollectionControls } from '@/components/watch';
import { addressOf, chainOf, methodOf } from '@/lib/api';
import { LOCAL_ONLY, mayWrite } from '@/lib/auth';
import { rulesNote } from '@/lib/collections';
import { chainName } from '@/lib/chains';
import { LENSES, eth, explorer, pct, plural, short } from '@/lib/format';
import { moneyFor, type CollectionProfile, type Method, type CollectionRow, type TokenSort, type WalletSort } from '@washtrace/detect';
import { collectionLinks, venues } from '@/lib/links';
import { analyzingOn, coverage, evidenceLead, lensesRan, unread, range, rangeEnds, summary, waiting, type Range } from '@/lib/metrics';
import { pipeline, trailComing } from '@/lib/pipeline';
import { configFromSources } from '@/lib/settings';
import { workerSilent } from '@/lib/status';
import { store, storedEntry } from '@/lib/store';
import { tradesHref } from '@/lib/trades';
import { cn } from '@/lib/utils';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';

/** Rows of each lens list a page in the lens panel; the flagged page has all of them. */
const TOP = 10;

/**
 * The lens, and each list's page, order and Find: tokens' `tp`, `ts` and
 * `tq`, wallets' `wp`, `ws` and `wq`, so the two lists page apart.
 */
type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<{ method?: string; tp?: string; ts?: string; tq?: string; wp?: string; ws?: string; wq?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: short(address) };
}

/**
 * One collection, top down: how far the reading has got in one line, the
 * answer, the three lenses it is made of with the tokens and wallets behind
 * the chosen one, how it has moved, and last the reading stage by stage. Each
 * section says which part of the answer it holds up.
 */
export default async function CollectionPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const s = store();
  const c = await s.collection(chainId, address);
  if (!c) notFound();
  const sp = await searchParams;
  const method = methodOf(sp.method);
  // The reader's zone, detected in the browser: the history is bucketed by their calendar. UTC until it is known.
  const zone = parseZone((await cookies()).get(ZONE_COOKIE)?.value)?.zone ?? 'UTC';
  const base = `/c/${chainId}/${address}`;
  const tv = listView('tokens', { page: sp.tp, sort: sp.ts, find: sp.tq });
  const wv = listView('wallets', { page: sp.wp, sort: sp.ws, find: sp.wq });
  // Only a lens that ran is listed: when funding did not, the money lenses hold Round trips' flags, copied.
  const ctx = { money: moneyFor(chainId), ran: lensesRan(c.latest), zone };
  const listed = ctx.ran.includes(method);
  // With a Find, each list is also counted without it, for "2 of 644": a limit of 0 reads the count alone.
  const [history, timeline, tokens, wallets, tokensOf, walletsOf, profile, passes, all, sources, settings] = await Promise.all([
    s.history(c.id), c.latest ? s.timeline(c.id, zone) : null,
    listed ? clampedPage(tv.page, TOP, (offset) => s.lensTokens(c.id, method, { sort: tv.sort as TokenSort, find: tv.find, limit: TOP, offset }, ctx)) : null,
    listed ? clampedPage(wv.page, TOP, (offset) => s.lensWallets(c.id, method, { sort: wv.sort as WalletSort, find: wv.find, limit: TOP, offset }, ctx)) : null,
    listed && tv.find !== null ? s.lensTokens(c.id, method, { sort: 'caught', find: null, limit: 0, offset: 0 }, ctx) : null,
    listed && wv.find !== null ? s.lensWallets(c.id, method, { sort: 'caught', find: null, limit: 0, offset: 0 }, ctx) : null,
    s.profile(c.id), s.passes(), s.collections(), s.sources(), s.settings(),
  ]);
  // The list's own count, never the analysis totals: those also count a token or wallet whose every flagged trade is uncounted.
  const tokenCount = tokensOf?.total ?? tokens?.total ?? 0;
  const walletCount = walletsOf?.total ?? wallets?.total ?? 0;
  const writable = mayWrite(process.env, await headers());
  // This page with one list's page, order or Find changed, the other kept, back at the lens panel.
  const here = (over: Partial<{ tp: number; ts: string; tq: string | null; wp: number; ws: string; wq: string | null }>) => {
    const v = { tp: tokens?.page ?? 1, ts: tv.sort, tq: tv.find, wp: wallets?.page ?? 1, ws: wv.sort, wq: wv.find, ...over };
    const pairs: [string, string | null][] = [
      ['method', method], ['ts', v.ts === 'caught' ? null : v.ts], ['tq', v.tq], ['tp', v.tp > 1 ? String(v.tp) : null],
      ['ws', v.ws === 'caught' ? null : v.ws], ['wq', v.wq], ['wp', v.wp > 1 ? String(v.wp) : null],
    ];
    return `${base}?${pairs.filter(([, x]) => x !== null).map(([k, x]) => `${k}=${encodeURIComponent(x!)}`).join('&')}#evidence`;
  };
  const flagged = (kind: 'tokens' | 'wallets', view: { sort: string; find: string | null }) =>
    `${base}/flagged?method=${method}&kind=${kind}${view.sort === 'caught' ? '' : `&sort=${view.sort}`}${view.find === null ? '' : `&q=${encodeURIComponent(view.find)}`}`;
  const a = c.latest;
  const rules = rulesNote(c.rules);
  // The chains the worker can read: with none for this one, its stored data is all there is.
  const config = configFromSources(sources, settings);
  const rpcChains = new Set(config.chains);
  // The manifest entry: how many traders the loaded money trail checked (when it is the one loaded), and how big the trail is while it downloads.
  const entry = await storedEntry(chainId, address);
  const trail = entry?.trail && entry.trail.sha256 === c.trailImportedSha ? { checked: entry.trail.checked, of: entry.trail.of } : null;
  // What the worker gives the next analysis: a key, or this collection's own trail with checked wallets (Worker.analyze).
  // A trail with checked wallets not loaded yet: stage 5 and the lens cards wait for it rather than saying they need a key.
  const coming = trailComing(c, entry);
  const funded = config.funding || (c.trailImportedSha !== null && await s.importedFunding(c.id));
  const silent = workerSilent(passes, Date.now());
  const why = waiting(c, passes.find((p) => p.job === 'analyze'), new Map(all.map((o) => [o.id, o.name ?? short(o.address)])), rpcChains, Date.now(), zone, silent !== null);
  const cov = coverage(c, rpcChains, Date.now(), zone, config.funding, silent !== null);
  const stages = pipeline({ c, entry, rpcChains, funding: config.funding, analyzing: analyzingOn(passes, c.id), silent: silent !== null });
  const name = c.name ?? short(address);
  const lens = LENSES[method];
  const t = a?.totals[method];

  return (
    <>
      <Head
        title={name}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>{chainName(chainId)}{c.contract?.symbol ? ` · ${c.contract.symbol}` : ''} · <a className="font-mono hover:underline" href={`${explorer(chainId)}/address/${address}`} target="_blank" rel="noopener noreferrer">{address} ↗</a></>}
      >
        <Refresh />
      </Head>

      <About c={c} profile={profile} base={base} />

      {silent ? <Silent silent={silent} /> : null}

      <div className="mb-4"><ReadingSummary c={c} cov={cov} href="#reading" stages={stages} /></div>

      {a === null ? (
        <Empty>{why}</Empty>
      ) : (
        <section aria-label="The answer" className="rounded-lg border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">How much of its trading looks like wash trading</p>
          </div>
          <div className="mt-3 grid gap-6 sm:grid-cols-2">
            <Headline r={range(a.totals, 'sales')} of="of sales" none="No sale read yet." base={base}
              detail={(r) => <>
                <FigureLink href={tradesHref(base, { caught: [r.low] })}>{a.totals[r.low].flaggedSales.toLocaleString()}</FigureLink>
                {r.low === r.high ? null : <>–<FigureLink href={tradesHref(base, { caught: [r.high] })}>{a.totals[r.high].flaggedSales.toLocaleString()}</FigureLink></>}
                {' of '}<FigureLink href={tradesHref(base, {})}>{a.totals.A.sales.toLocaleString()}</FigureLink> sales
              </>} />
            <Headline r={range(a.totals, 'volume')} of="of volume" none="No priced sale read yet, so there is no volume to share." base={base} priciest
              detail={(r) => {
                // Each end opens what it counts, biggest first, as the stat line does; the total opens every sale.
                const priciest = { sort: 'price', dir: 'desc' } as const;
                const end = (m: Method) => tradesHref(base, { caught: [m], ...priciest });
                const lo = a.totals[r.low].flaggedVolumeWei, hi = a.totals[r.high].flaggedVolumeWei;
                return <>
                  {lo === hi ? <FigureLink href={end(r.high)}>{eth(hi)}</FigureLink>
                    : <><FigureLink href={end(r.low)}>{eth(lo, '').trim()}</FigureLink>–<FigureLink href={end(r.high)}>{eth(hi)}</FigureLink></>}
                  {' of '}<FigureLink href={tradesHref(base, priciest)}>{eth(a.totals.A.volumeWei)}</FigureLink>
                </>;
              }} />
          </div>
          <Link href={tradesHref(base, {})} className="mt-4 inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline">Dig into its trades →</Link>
          <p className="mt-4 max-w-3xl text-sm text-body">{summary(a.totals)}</p>
        </section>
      )}

      {a ? (
        <Section id="evidence" title="How was it found?" lead={evidenceLead(a.totals)}>
          {/* These are the rules now set, which the latest analysis may not have run under yet. */}
          {rules ? <p className="mb-4 text-sm text-muted-foreground">{rules}</p> : null}
          <LensCards totals={a.totals} selected={method} href={(m) => `${base}?method=${m}`} notFinal={cov.notFinal} trail={c.trailImportedSha !== null} funded={funded} coming={coming} silent={silent !== null}>
            {t ? <LensStats m={method} t={t} loops={a.loops && ctx.ran.includes(method) ? a.loops[method] : null} base={base} notFinal={cov.notFinal} /> : null}
            <p className="mb-4 text-sm text-muted-foreground">
              {t?.available
                ? <>What <span className="font-medium text-foreground">{lens.name}</span> flags most: its {pct(t.flaggedSales, t.sales)} of sales, token by token and wallet by wallet. Open a token to see why each trade was flagged.</>
                : <><span className="font-medium text-foreground">{lens.name}</span> did not run, so it flags nothing. Choose another lens above.</>}
            </p>
            {tokens && wallets ? (
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <LensList
                    kind="tokens" method={method} base={base} chainId={chainId} rows={tokens.rows} total={tokens.total} of={tokenCount}
                    sort={tv.sort} sortHref={(ts) => here({ ts, tp: 1 })} find={tv.find} findParam="tq"
                    pager={{ page: tokens.page, size: TOP, href: (tp) => here({ tp }), param: 'tp' }} empty={`${lens.name} flags no token.`}
                  />
                  <Link href={flagged('tokens', tv)} className="mt-2 inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline">All {plural(tokenCount, 'token')} →</Link>
                </div>
                <div>
                  <LensList
                    kind="wallets" method={method} base={base} chainId={chainId} rows={wallets.rows} total={wallets.total} of={walletCount}
                    sort={wv.sort} sortHref={(ws) => here({ ws, wp: 1 })} find={wv.find} findParam="wq"
                    pager={{ page: wallets.page, size: TOP, href: (wp) => here({ wp }), param: 'wp' }} empty={`${lens.name} flags no wallet.`}
                  />
                  <Link href={flagged('wallets', wv)} className="mt-2 inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline">All {plural(walletCount, 'wallet')} →</Link>
                </div>
              </div>
            ) : null}
          </LensCards>
        </Section>
      ) : null}

      {a && timeline && timeline.points.length > 0 ? (
        <Section
          title="When did it happen?"
          lead={<>Each lens&rsquo;s share of the sales in each {timeline.bucket}, across the collection&rsquo;s life from its first trade{unread(cov) ? '. The shaded stretch is history the worker has not read yet' : ''}. A period opens its trades; the list leaves out mints and custody moves, so it can be a little shorter than the bar.{timeline.untimed > 0 ? ` ${plural(timeline.untimed, 'transfer')} without a block time are left out.` : ''}</>}
        >
          <History timeline={{ ...timeline, readThrough: unread(cov) ? timeline.readThrough : null }} totals={a.totals} notFinal={cov.notFinal} now={Date.now()} zone={zone} base={base} />
        </Section>
      ) : null}

      <Section id="reading" title="How far has it read?" lead="The six stages under every number on this page. Stages 4 and 5 run side by side, and a money trail can still be loading after stage 3.">
        <Pipeline c={c} stages={stages} cov={cov} why={why} rpcChains={rpcChains} funding={config.funding} funded={funded} trail={trail} trailBytes={entry?.trail?.bytes ?? null} transfersBytes={entry?.transfers.bytes ?? null} trailComing={coming} now={Date.now()} />
        {history.length > 1 ? (
          <details className="group mt-3">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">How the answer settled as the reading filled in, at each of {history.length} analyses</summary>
            <div className="mt-2"><Trend history={history} zone={zone} /></div>
          </details>
        ) : null}
      </Section>

      <Section title="Reading this collection" lead={c.pausedAt === null ? 'Pause stops the worker reading new blocks and keeps what it has read. Only a paused collection can have its data deleted.' : 'Paused: the worker is not reading new blocks, and its data is kept. Resume to read on, or delete its data.'}>
        {writable ? null : <p className="mb-2 text-xs text-muted-foreground">{LOCAL_ONLY}</p>}
        <CollectionControls writable={writable} chainId={chainId} address={address} paused={c.pausedAt !== null} priority={c.priority} />
      </Section>
    </>
  );
}

/**
 * The collection itself, before any verdict on it: what exists, who holds it,
 * when and where it traded, and who made it. Counted from the transfers read
 * so far, so it fills in with the reading.
 */
function About({ c, profile: p, base }: { c: CollectionRow; profile: CollectionProfile; base: string }) {
  const sold = venues(p.marketplaces);
  return (
    <section aria-label="The collection" className="mb-4 rounded-lg border bg-card p-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Tokens" note="minted and not burned">{p.supply.toLocaleString()}</Fact>
        <Fact label="Holders" note="wallets holding one now">{p.holders.toLocaleString()}</Fact>
        <Fact label="First minted">{p.firstMint === null ? '—' : <Time ms={p.firstMint} style="date" />}</Fact>
        <Fact label="Traded" note="first sale to latest">
          {p.firstSale === null || p.lastSale === null ? 'No sale yet'
            : <FigureLink href={tradesHref(base, { sort: 'date', dir: 'asc' })}><Time ms={p.firstSale} style="month" /> – <Time ms={p.lastSale} style="month" /></FigureLink>}
        </Fact>
        <Fact label="Sold on" note="sales per marketplace">
          {sold.length === 0 ? '—' : sold.slice(0, 3).map((v) => <span key={v.name} className="block">{v.name} <FigureLink href={tradesHref(base, { venues: [v.key] })} className="font-normal text-muted-foreground">{v.sales.toLocaleString()}</FigureLink></span>)}
          {sold.length > 3 ? <span className="block text-xs font-normal text-muted-foreground">and {sold.slice(3).map((v) => v.name).join(', ')}</span> : null}
        </Fact>
        <Fact label="Deployed by" note={c.contract?.creationTx ? <a href={`${explorer(c.chainId)}/tx/${c.contract.creationTx}`} target="_blank" rel="noopener noreferrer" className="hover:underline">deployment tx ↗</a> : undefined}>
          {c.contract?.creator ? <Wallet chainId={c.chainId} address={c.contract.creator} /> : <span className="text-muted-foreground">{c.contract === null ? 'not read yet' : 'unknown'}</span>}
        </Fact>
      </dl>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t pt-3">
        <Elsewhere links={collectionLinks(c.chainId, c.address)} />
        <a href="#reading" className="text-xs text-muted-foreground hover:text-foreground hover:underline">Counted from the transfers read so far ↓</a>
      </div>
    </section>
  );
}

function Fact({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground tabular-nums">{children}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

/** A figure that opens the list it counts. */
function FigureLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return <Link href={href} className={cn('hover:underline', className)}>{children}</Link>;
}

/** `priciest` sorts what each end opens by price, for a range of volume. */
function Headline({ r, of, none, detail, base, priciest = false }: { r: Range | null; of: string; none: string; detail: (r: Range) => ReactNode; base: string; priciest?: boolean }) {
  if (r === null) return <p className="text-sm text-muted-foreground">{none}</p>;
  const e = rangeEnds(r);
  const end = (text: string, m: Method) => <FigureLink href={tradesHref(base, priciest ? { caught: [m], sort: 'price', dir: 'desc' } : { caught: [m] })}>{text}</FigureLink>;
  return (
    <div>
      <p className="flex items-baseline gap-2">
        <span className="text-4xl font-semibold tracking-tight text-foreground tabular-nums">{e.same ? end(e.high, r.high) : <>{end(e.low, r.low)}–{end(e.high, r.high)}</>}</span>
        <span className="text-sm text-muted-foreground">{of}</span>
      </p>
      <RangeBar range={r} className="mt-2 max-w-sm" />
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm tabular-nums">{detail(r)}</span>
        <RangeKey range={r} />
      </div>
    </div>
  );
}
