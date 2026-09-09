import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ReadingPanel, ReadingSummary } from '@/components/coverage';
import { Elsewhere, Empty, Head, Section } from '@/components/head';
import { History, LensCards, RangeBar, RangeKey, Ranked, Trend } from '@/components/methods';
import { Refresh } from '@/components/refresh';
import { Time } from '@/components/time';
import { Wallet } from '@/components/transfers';
import { CollectionControls } from '@/components/watch';
import { addressOf, chainOf, methodOf } from '@/lib/api';
import { chainName } from '@/lib/chains';
import { LENSES, eth, ethRange, explorer, pct, plural, short } from '@/lib/format';
import type { CollectionProfile, CollectionRow } from '@washtrace/detect';
import { collectionLinks, venues } from '@/lib/links';
import { coverage, unread, range, rangeText, summary, waiting, type Range } from '@/lib/metrics';
import { configFromSources } from '@/lib/settings';
import { store, storedEntry } from '@/lib/store';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';

/** Rows of each ranking shown in the lens panel; the rest are a page away. */
const TOP = 10;

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<{ method?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: short(address) };
}

/**
 * One collection, top down: how far the reading has got in one line, the
 * answer, the three lenses it is made of with the tokens and wallets behind
 * the chosen one, how it has moved, and last the reading step by step. Each
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
  const method = methodOf((await searchParams).method);
  // The reader's zone, detected in the browser: the history is bucketed by their calendar. UTC until it is known.
  const zone = parseZone((await cookies()).get(ZONE_COOKIE)?.value)?.zone ?? 'UTC';
  const [history, timeline, tokens, wallets, profile, passes, all, sources, settings] = await Promise.all([s.history(c.id), c.latest ? s.timeline(c.id, zone) : null, s.topTokens(c.id, method, TOP), s.topWallets(c.id, method, TOP), s.profile(c.id), s.passes(), s.collections(), s.sources(), s.settings()]);
  const why = waiting(c, passes.find((p) => p.job === 'analyze'), new Map(all.map((o) => [o.id, o.name ?? short(o.address)])), Date.now(), zone);
  const base = `/c/${chainId}/${address}`;
  const a = c.latest;
  // The chains the worker can read: with none for this one, its stored data is all there is.
  const config = configFromSources(sources, settings);
  const rpcChains = new Set(config.chains);
  // The manifest entry: how many traders the loaded money trail checked (when it is the one loaded), and how big the trail is while it downloads.
  const entry = await storedEntry(chainId, address);
  const trail = entry?.trail && entry.trail.sha256 === c.trailImportedSha ? { checked: entry.trail.checked, of: entry.trail.of } : null;
  // What the worker gives the next analysis: a key, or this collection's own trail with checked wallets (Worker.analyze).
  const funded = config.funding || (c.trailImportedSha !== null && await s.importedFunding(c.id));
  const cov = coverage(c, rpcChains, Date.now(), zone, config.funding);
  const name = c.name ?? short(address);
  const lens = LENSES[method];
  const t = a?.totals[method];

  return (
    <>
      <Head
        title={name}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>{chainName(chainId)}{c.contract?.symbol ? ` · ${c.contract.symbol}` : ''} · <a className="font-mono hover:underline" href={`${explorer(chainId)}/address/${address}`} target="_blank" rel="noreferrer">{address}</a></>}
      >
        <Refresh />
      </Head>

      <About c={c} profile={profile} />

      <div className="mb-4"><ReadingSummary c={c} cov={cov} href="#reading" /></div>

      {a === null ? (
        <Empty>{why}</Empty>
      ) : (
        <section aria-label="The answer" className="rounded-lg border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">How much of its trading looks like wash trading</p>
          </div>
          <div className="mt-3 grid gap-6 sm:grid-cols-2">
            <Headline r={range(a.totals, 'sales')} of="of sales" none="No sale read yet."
              detail={(r) => `${a.totals[r.low].flaggedSales.toLocaleString()}${r.low === r.high ? '' : `–${a.totals[r.high].flaggedSales.toLocaleString()}`} of ${a.totals.A.sales.toLocaleString()} sales`} />
            <Headline r={range(a.totals, 'volume')} of="of volume" none="No priced sale read yet, so there is no volume to share."
              detail={(r) => `${ethRange(a.totals[r.low].flaggedVolumeWei, a.totals[r.high].flaggedVolumeWei)} of ${eth(a.totals.A.volumeWei)}`} />
          </div>
          <p className="mt-4 max-w-3xl text-sm text-body">{summary(a.totals)}</p>
        </section>
      )}

      {a ? (
        <Section id="evidence" title="How was it found?" lead="Three lenses, strictest first; each is one end, or the middle, of the range above. Choose one to see the tokens and wallets it flags.">
          <LensCards totals={a.totals} selected={method} href={(m) => `${base}?method=${m}`} floor={cov.floor} trail={c.trailImportedSha !== null} funded={funded}>
            <p className="mb-4 text-sm text-muted-foreground">
              {t?.available
                ? <>What <span className="font-medium text-foreground">{lens.name}</span> flags most: its {pct(t.flaggedSales, t.sales)} of sales, token by token and wallet by wallet. Open a token to see why each trade was flagged.</>
                : <><span className="font-medium text-foreground">{lens.name}</span> did not run, so it flags nothing. Choose another lens above.</>}
            </p>
            <div className="grid gap-6 lg:grid-cols-2">
              <Ranked
                title="Tokens" unit="trades" empty={`${lens.name} flags no token.`}
                more={t && t.tokens > TOP ? { href: `${base}/flagged?method=${method}&kind=tokens`, label: `See all ${t.tokens.toLocaleString()} tokens` } : null}
                rows={tokens.map((r) => ({ key: r.tokenId, label: <Link href={`${base}/t/${r.tokenId}`} className="font-mono font-medium text-foreground hover:underline">#{r.tokenId.length > 14 ? `${r.tokenId.slice(0, 12)}…` : r.tokenId}</Link>, flagged: r.flagged, of: r.transfers }))}
                tone={lens.tone}
              />
              <Ranked
                title="Wallets" unit="trades it was in" empty={`${lens.name} flags no wallet.`}
                more={t && t.wallets > TOP ? { href: `${base}/flagged?method=${method}&kind=wallets`, label: `See all ${t.wallets.toLocaleString()} wallets` } : null}
                rows={wallets.map((w) => ({ key: w.address, label: <Wallet chainId={chainId} address={w.address} />, flagged: w.flagged, of: w.transfers }))}
                tone={lens.tone}
              />
            </div>
          </LensCards>
        </Section>
      ) : null}

      {a && timeline && timeline.points.length > 0 ? (
        <Section
          title="When did it happen?"
          lead={<>Each lens&rsquo;s share of the sales in each {timeline.bucket}, across the collection&rsquo;s life from its first trade{unread(cov) ? '. The shaded stretch is history the worker has not read yet' : ''}. A sale here is any marketplace fill, so a month can sit a little under the headline, which also drops custody moves.{timeline.untimed > 0 ? ` ${plural(timeline.untimed, 'transfer')} without a block time are left out.` : ''}</>}
        >
          <History timeline={{ ...timeline, readThrough: unread(cov) ? timeline.readThrough : null }} totals={a.totals} floor={cov.floor} now={Date.now()} zone={zone} />
        </Section>
      ) : null}

      <Section id="reading" title="How far has it read?" lead="The three steps under every number on this page, in the order the worker runs them, each with the numbers it holds up.">
        <ReadingPanel c={c} cov={cov} why={why} rpcChains={rpcChains} funding={config.funding} funded={funded} trail={trail} trailBytes={entry?.trail?.bytes ?? null} now={Date.now()} />
        {history.length > 1 ? (
          <details className="group mt-3">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">How the answer settled as the reading filled in, at each of {history.length} analyses</summary>
            <div className="mt-2"><Trend history={history} zone={zone} /></div>
          </details>
        ) : null}
      </Section>

      <Section title="Reading this collection" lead={c.pausedAt === null ? 'Pause stops the worker reading new blocks and keeps what it has read. Only a paused collection can have its data deleted.' : 'Paused: the worker is not reading new blocks, and its data is kept. Resume to read on, or delete its data.'}>
        <CollectionControls chainId={chainId} address={address} paused={c.pausedAt !== null} priority={c.priority} />
      </Section>
    </>
  );
}

/**
 * The collection itself, before any verdict on it: what exists, who holds it,
 * when and where it traded, and who made it. Counted from the transfers read
 * so far, so it fills in with the reading.
 */
function About({ c, profile: p }: { c: CollectionRow; profile: CollectionProfile }) {
  const sold = venues(p.marketplaces);
  return (
    <section aria-label="The collection" className="mb-4 rounded-lg border bg-card p-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Tokens" note="minted and not burned">{p.supply.toLocaleString()}</Fact>
        <Fact label="Holders" note="wallets holding one now">{p.holders.toLocaleString()}</Fact>
        <Fact label="First minted">{p.firstMint === null ? '—' : <Time ms={p.firstMint} style="date" />}</Fact>
        <Fact label="Traded" note="first sale to latest">
          {p.firstSale === null || p.lastSale === null ? 'No sale yet' : <><Time ms={p.firstSale} style="month" /> – <Time ms={p.lastSale} style="month" /></>}
        </Fact>
        <Fact label="Sold on" note="sales per marketplace">
          {sold.length === 0 ? '—' : sold.slice(0, 3).map((v) => <span key={v.name} className="block">{v.name} <span className="font-normal text-muted-foreground">{v.sales.toLocaleString()}</span></span>)}
          {sold.length > 3 ? <span className="block text-xs font-normal text-muted-foreground">and {sold.slice(3).map((v) => v.name).join(', ')}</span> : null}
        </Fact>
        <Fact label="Deployed by" note={c.contract?.creationTx ? <a href={`${explorer(c.chainId)}/tx/${c.contract.creationTx}`} target="_blank" rel="noreferrer" className="hover:underline">deployment tx ↗</a> : undefined}>
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

function Headline({ r, of, none, detail }: { r: Range | null; of: string; none: string; detail: (r: Range) => string }) {
  if (r === null) return <p className="text-sm text-muted-foreground">{none}</p>;
  return (
    <div>
      <p className="flex items-baseline gap-2">
        <span className="text-4xl font-semibold tracking-tight text-foreground tabular-nums">{rangeText(r)}</span>
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
