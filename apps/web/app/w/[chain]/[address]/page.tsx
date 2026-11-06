import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { Flow, FlowDir, PartnerSort } from '@washtrace/detect';
import { findOf } from '@washtrace/detect/trades';
import { Answer, Elsewhere, Empty, Head, Section } from '@/components/head';
import { Pager } from '@/components/pager';
import { Transfers, Wallet } from '@/components/transfers';
import { addressOf, chainOf } from '@/lib/api';
import { chainName } from '@/lib/chains';
import { LENSES, eth, explorer, lensList, plural, short } from '@/lib/format';
import { walletLinks } from '@/lib/links';
import { HEADLINE, TINT_LEAD, answer, counted, toneOf, type Tone } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { COUNTERPARTIES, FLOWS, TRADES, walletOpts, walletView, type WalletOpts } from '@/lib/views';
import { Time } from '@/components/time';

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: short(address) };
}

/**
 * This page with `o`'s lists, filter and pages, defaults left out. Every link
 * and pager here builds on the page as shown, so moving one list keeps the
 * others where they are.
 */
function hrefOf(base: string, o: WalletOpts): string {
  const sp = new URLSearchParams();
  const f = o.filter;
  if (f.collection !== undefined) sp.set('collection', f.collection);
  if (f.flaggedOnly) sp.set('flagged', '1');
  if (f.find !== undefined) sp.set('q', f.find);
  if (o.trades > 1) sp.set('trades', String(o.trades));
  if (o.psort !== 'flows') sp.set('psort', o.psort);
  if (o.partners > 1) sp.set('partners', String(o.partners));
  if (f.with !== undefined) {
    sp.set('with', f.with);
    if (o.dir !== 'both') sp.set('dir', o.dir);
    if (o.flows > 1) sp.set('flows', String(o.flows));
  }
  const q = sp.toString();
  return q === '' ? base : `${base}?${q}`;
}

/** The partner table's sortable columns, by the order each sets. */
const PARTNER_COLUMNS: readonly { sort: PartnerSort; label: string; right: boolean }[] = [
  { sort: 'watched', label: 'Also trades a watched collection', right: false },
  { sort: 'flows', label: 'Payments in all', right: true },
  { sort: 'sent', label: 'Payments sent to it', right: true },
  { sort: 'received', label: 'Payments received from it', right: true },
];

/** How each payment between two wallets moved, in words. */
const FLOW_KIND: Readonly<Record<Flow['kind'], string>> = { native: 'direct', internal: 'inside a contract call', token: 'wrapped ETH' };

/** A flagged wallet's card: the page verdict's tone when it is a flagged one, else money's. */
function flaggedTone(page: Tone | null): Tone {
  return page === 'cycle' || page === 'money' ? page : 'money';
}

/** One wallet: whether its trades look washed, which ones, and the money links the lenses followed to say so. */
export default async function WalletPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const asked = walletOpts(await searchParams);
  const view = await walletView(chainId, address, asked);
  const { funding, collections, counterparties, transfers, counts, pages, between, by, washTrade } = view;
  // The page as shown: every page clamped to the last there is.
  const o: WalletOpts = { ...asked, trades: pages.trades.page, partners: pages.partners.page, flows: pages.flows.page };
  const base = `/w/${chainId}/${address}`;
  const href = (over: Partial<WalletOpts>) => hrefOf(base, { ...o, ...over });
  const { with: other, ...narrow } = o.filter;
  const narrowed = Object.keys(narrow).length > 0;

  const hits = transfers.filter(counted);
  // Shown tinted grey, yet outside the verdict: say so, or the title and the rows contradict each other.
  const apart = transfers.filter((t) => toneOf(t) === 'apart').length;
  const tokens = new Set(hits.map((t) => `${t.collection?.address}:${t.tokenId}`)).size;
  const linked = counterparties.filter((c) => c.watched).length;
  // The title counts every trade it has: the flagged count opens the flagged-only list, the total all of them.
  // A flagged wallet titles from its counts, though the page shown holds none of them, and is never in a clean or grey card:
  // the page's verdict gives its tone when that is a flagged one, else it is money's. The notes stay the page's own.
  const flaggedTitle = <>In <Link href={`${base}?flagged=1`} className="hover:underline">{counts.flagged.toLocaleString()}</Link> flagged {counts.flagged === 1 ? 'trade' : 'trades'} out of <Link href={base} className="hover:underline">{counts.trades.toLocaleString()}</Link></>;
  const { title, tone } = counts.trades === 0 ? { title: 'Not in any watched collection', tone: 'clean' as const }
    : counts.flagged > 0 ? { title: flaggedTitle, tone: flaggedTone(transfers.length === 0 ? null : answer(view, null).tone) }
    : transfers.length === 0 ? { title: 'No trade of it matches these filters', tone: 'clean' as const }
    : answer(view, flaggedTitle);
  // Where the title's flagged trades are not: a filter whose list is one page holds none, else they are on other pages.
  const elsewhere = counts.flagged === 0 || hits.length > 0 ? null
    : narrowed && pages.trades.pages <= 1 ? 'None of them matches these filters.' : 'None of them is on this page.';
  // Only an apart title says it already; beside counted trades the grey ones are "more", alone they are not.
  const apartNote = apart === 0 || tone === 'apart' ? null
    : `${apart}${hits.length > 0 ? ' more' : ''} ${apart === 1 ? 'is' : 'are'} flagged only by ${LENSES.AU.name}, which is not counted.`;

  const money = funding === null ? 'Its money is not read: it never traded a watched collection.'
    : funding.status === 'pending' ? `Its money is not read yet: queued behind busier wallets (it is in ${plural(funding.transfers, 'transfer')}). Until it is, ${LENSES.AU.name} and ${LENSES.AC.name} cannot see its links.`
    : funding.status === 'failed' ? `Reading its money failed: ${funding.error ?? 'unknown error'}. Retried hourly; until then ${LENSES.AU.name} and ${LENSES.AC.name} cannot see its links.`
    : <>Its money was read {funding.fetchedAt === null ? 'from stored data' : <Time ms={funding.fetchedAt} />}{funding.truncated ? '. It has more history than Etherscan pages through, so it is never treated as the shared funder between two others' : ''}.</>;

  const first = (pages.trades.page - 1) * TRADES + 1;
  // The title counts flagged trades this page or filter does not hold, so then the verdict covers more than these.
  const covers = (them: string) => (elsewhere === null ? `; the verdict above covers ${them}.` : '.');
  const shown = narrowed || pages.trades.pages > 1
    ? transfers.length === 1
      ? `Trade ${first.toLocaleString()} of ${pages.trades.total.toLocaleString()} is shown${covers('it')}`
      : `Trades ${first.toLocaleString()}–${(first + transfers.length - 1).toLocaleString()} of ${pages.trades.total.toLocaleString()} are shown${covers('these')}`
    : 'Every transfer it sent or received in a watched collection.';
  const named = narrow.find === undefined ? null : findOf(narrow.find);
  const unreadable = named !== null && named.kind !== 'token' && named.kind !== 'address' && named.kind !== 'prefix';
  const partnerFirst = (pages.partners.page - 1) * COUNTERPARTIES + 1;

  return (
    <>
      <Head
        title={<span className="font-mono">{short(address)}</span>}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>Wallet on {chainName(chainId)} · <a className="font-mono hover:underline" href={`${explorer(chainId)}/address/${address}`} target="_blank" rel="noopener noreferrer">{address} ↗</a></>}
      >
        <Elsewhere links={walletLinks(chainId, address)} />
      </Head>

      <Answer tone={tone} title={title}>
        {elsewhere === null ? null : <p>{elsewhere} <Link href={`${base}?flagged=1`} className="font-medium hover:underline">Show the flagged ones</Link></p>}
        {transfers.length > 0 && washTrade === null ? <p>Some of its trades are read, but no analysis has covered them yet. That is not the same as clean.</p> : null}
        {hits.length > 0 ? <p>Across {plural(tokens, 'token')}, flagged by {lensList(by.filter((m) => HEADLINE.includes(m)))}.</p> : null}
        {apartNote === null ? null : <p className="text-muted-foreground">{apartNote}</p>}
        <p className="text-muted-foreground">{money}</p>
      </Answer>

      <Section title="Which of its trades?" lead={<>{transfers.length > 0 ? `${shown} ` : ''}{TINT_LEAD} Open the token to see the pattern.</>}>
        {counts.trades === 0 ? null : (
          <form action={base} method="get" role="search" aria-label="Narrow its trades" className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            {/* The other lists stay where they are; the trades start again at their first page. */}
            {o.psort !== 'flows' ? <input type="hidden" name="psort" value={o.psort} /> : null}
            {o.partners > 1 ? <input type="hidden" name="partners" value={o.partners} /> : null}
            {other !== undefined ? <input type="hidden" name="with" value={other} /> : null}
            {other !== undefined && o.dir !== 'both' ? <input type="hidden" name="dir" value={o.dir} /> : null}
            {other !== undefined && o.flows > 1 ? <input type="hidden" name="flows" value={o.flows} /> : null}
            <select name="collection" defaultValue={narrow.collection ?? ''} aria-label="Only its trades in this collection" className="rounded-md border bg-card px-2 py-1">
              <option value="">Every collection</option>
              {collections.map((c) => <option key={c.address} value={c.address}>{c.name ?? short(c.address)} ({c.trades.toLocaleString()})</option>)}
            </select>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="flagged" value="1" defaultChecked={narrow.flaggedOnly === true} />
              Flagged only
            </label>
            <input
              type="search" name="q" defaultValue={narrow.find ?? ''} placeholder="Find a token number or wallet (0x…)"
              aria-label="Find its trades of a token, by its number, or with a wallet, by its address or the start of it"
              className="w-64 rounded-md border bg-card px-2 py-1"
            />
            <button type="submit" className="rounded-md border bg-card px-2.5 py-1 font-medium hover:bg-muted">Show</button>
          </form>
        )}
        {narrowed ? (
          <p className="mb-2 text-sm text-muted-foreground">
            {pages.trades.total.toLocaleString()} of {plural(counts.trades, 'trade')} {pages.trades.total === 1 ? 'matches' : 'match'} · <Link href={href({ filter: other === undefined ? {} : { with: other }, trades: 1 })} className="font-medium text-foreground hover:underline">Show every trade</Link>
            {unreadable ? <> · “{narrow.find}” is not a token number, or a wallet address or the start of one, so it matches nothing.</> : null}
          </p>
        ) : null}
        {narrowed && transfers.length === 0 ? <Empty>No trade of it matches these filters.</Empty> : <Transfers chainId={chainId} transfers={transfers} collection />}
        {pages.trades.total > TRADES ? <Pager total={pages.trades.total} page={pages.trades.page} size={TRADES} href={(n) => href({ trades: n })} label="trades" pageParam="trades" /> : null}
      </Section>

      <Section
        title="Who did it move money with?"
        lead={<>{pages.partners.pages > 1 ? `${partnerFirst.toLocaleString()}–${(partnerFirst + counterparties.length - 1).toLocaleString()} of ${pages.partners.total.toLocaleString()} counterparties. ` : ''}These are the links {LENSES.AU.name} and {LENSES.AC.name} follow. A counterparty that also trades a watched collection is the kind of link that flags a trade{linked > 0 ? `: ${linked} here do` : ''}. Each count opens the payments it counts, and the trades between the two.</>}
        aside="native, internal and wrapped-native flows, both directions"
      >
        {counterparties.length === 0 ? <Empty>No money flows read for this wallet.</Empty> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">Wallet</th>
                  {PARTNER_COLUMNS.map((c) => (
                    <th key={c.sort} aria-sort={o.psort === c.sort ? 'descending' : undefined} className={cn('px-3 py-2 font-medium', c.right ? 'text-right' : '')}>
                      <Link href={href({ psort: c.sort, partners: 1 })} title="Sort by this, most first" className={cn('hover:underline', o.psort === c.sort ? 'text-foreground' : '')}>
                        {c.label}{o.psort === c.sort ? ' ↓' : ''}
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {counterparties.map((c) => {
                  const opens = (n: number, dir: FlowDir) => n === 0 ? <span className="text-muted-foreground">0</span>
                    : <Link href={`${href({ filter: { ...o.filter, with: c.address }, dir, flows: 1 })}#between`} className="font-medium hover:underline">{n.toLocaleString()}</Link>;
                  return (
                    <tr key={c.address} className={c.watched ? 'border-b bg-muted/60 last:border-b-0' : 'border-b last:border-b-0'}>
                      <td className="px-3 py-1.5"><Wallet chainId={chainId} address={c.address} /></td>
                      <td className="px-3 py-1.5">{c.watched ? <span className="font-medium text-foreground">yes</span> : <span className="text-muted-foreground">no</span>}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{opens(c.flows, 'both')}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{opens(c.sent, 'sent')}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{opens(c.received, 'received')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages.partners.pages > 1 ? <Pager total={pages.partners.total} page={pages.partners.page} size={COUNTERPARTIES} href={(n) => href({ partners: n })} label="counterparties" pageParam="partners" /> : null}
      </Section>

      {between === null || other === undefined ? null : (
        <Section id="between" title={`What passed between this wallet and ${short(other)}?`}
          lead={<>The trades where one sold to the other, either way, and the payments between them. <Wallet chainId={chainId} address={other} /> opens its own page.</>}>
          <h3 className="mb-1.5 text-sm font-medium">Which trades were between them?</h3>
          {between.tradesTotal === 0 ? <Empty>Neither sold the other a token in a watched collection.</Empty> : (
            <>
              <Transfers chainId={chainId} transfers={between.trades} collection />
              {between.tradesTotal > TRADES ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  The latest {TRADES} of {between.tradesTotal.toLocaleString()} are shown. <Link href={href({ filter: { find: other, with: other }, trades: 1 })} className="font-medium text-foreground hover:underline">Page through all of them</Link> in its trades above.
                </p>
              ) : null}
            </>
          )}
          <div className="mt-6 mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Which payments passed between them?</h3>
            <nav aria-label="Which way" className="text-xs text-muted-foreground">
              {([['sent', 'it sent'], ['received', 'it received'], ['both', 'both ways']] as const).map(([d, label], i) => (
                <span key={d}>
                  {i > 0 ? ' · ' : ''}
                  <Link href={`${href({ dir: d, flows: 1 })}#between`} aria-current={o.dir === d ? 'true' : undefined} className={cn('hover:underline', o.dir === d ? 'font-medium text-foreground' : '')}>{label}</Link>
                </span>
              ))}
            </nav>
          </div>
          {between.flowsTotal === 0 ? <Empty>No payments {o.dir === 'sent' ? 'from it to' : o.dir === 'received' ? 'to it from' : 'either way with'} this wallet were read.</Empty> : (
            <>
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full min-w-[30rem] text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-3 py-2 font-medium">When</th>
                      <th className="px-3 py-2 font-medium">Which way</th>
                      <th className="px-3 py-2 font-medium">How</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-3 py-2 font-medium">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {between.flows.map((f) => (
                      <tr key={`${f.txHash}:${f.kind}:${f.from}:${f.token}:${f.valueWei}`} className="border-b last:border-b-0">
                        <td className="px-3 py-1.5 whitespace-nowrap text-xs tabular-nums"><Time ms={f.blockTime * 1000} /></td>
                        <td className="px-3 py-1.5">{f.from === address ? 'it sent' : 'it received'}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{FLOW_KIND[f.kind]}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{eth(f.valueWei, f.kind === 'token' ? 'WETH' : 'ETH')}</td>
                        <td className="px-3 py-1.5"><a href={`${explorer(chainId)}/tx/${f.txHash}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs hover:underline">{short(f.txHash)} ↗</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager total={between.flowsTotal} page={pages.flows.page} size={FLOWS} href={(n) => `${href({ flows: n })}#between`} label="payments" pageParam="flows" />
            </>
          )}
        </Section>
      )}
    </>
  );
}
