import Link from 'next/link';
import type { Flow, FlowDir, PartnerSort } from '@washtrace/detect';
import { findOf } from '@washtrace/detect/trades';
import { ConnectedRail, OpenUnder, ParentLine, partnersOf, type Home } from '@/components/connected-rail';
import { VerdictChip } from '@/components/kit';
import { WhereItSits } from '@/components/sales-strip';
import { Answer, Elsewhere, Empty, Ext, Head, Section, SortHead } from '@/components/ui';
import { MatchLine } from '@/components/lens-lists';
import { Pager } from '@/components/pager';
import { Transfers, Wallet } from '@/components/transfers';
import { chainName } from '@/lib/chains';
import { LENSES, eth, lensList, plural, short, num } from '@/lib/format';
import { explorerAddress, explorerTx, walletHref, walletLinks } from '@/lib/links';
import { HEADLINE } from '@washtrace/detect';
import { FLAGGED_ONLY_AU, NOT_JUDGED, TINT_LEAD, answer, counted, toneOf, type Tone } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { walletOpts, type WalletOpts } from '@/lib/params';
import { COUNTERPARTIES, FLOWS, TRADES, walletView } from '@/lib/views';
import { Time } from '@/components/time';
import { Suspense } from 'react';
import { RingChips } from '@/components/rings';
import { StepLine } from '@/components/step-line';

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

/**
 * One wallet: whether its trades look washed, which ones, and the money links
 * the lenses followed to say so. `within` is a collection's base: the page
 * under that collection's tabs, its trades narrowed to the collection and its
 * links kept inside it. Without it, the wallet across every collection.
 */
export async function WalletView({ chainId, address, sp, within }: {
  chainId: number; address: string; sp: Record<string, string | string[] | undefined>;
  within?: { base: string; collection: string; name: string; id: number };
}) {
  const parsed = walletOpts(sp);
  // Under a collection's tabs the collection is the route's: a ?collection= there narrows nothing further.
  const filter = { ...parsed.filter };
  if (within !== undefined) delete filter.collection;
  const asked: WalletOpts = { ...parsed, filter };
  const view = await walletView(chainId, address, asked, within?.collection);
  const { funding, collections, counterparties, transfers, counts, pages, between, by, washTrade } = view;
  // The page as shown: every page clamped to the last there is.
  const o: WalletOpts = { ...asked, trades: pages.trades.page, partners: pages.partners.page, flows: pages.flows.page };
  const scope = within?.base;
  const base = walletHref(chainId, address, scope);
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
  const flaggedTitle = <>In <Link href={`${base}?flagged=1`} prefetch={false} className="hover:underline">{num(counts.flagged)}</Link> flagged {counts.flagged === 1 ? 'trade' : 'trades'} out of <Link href={base} prefetch={false} className="hover:underline">{num(counts.trades)}</Link></>;
  const { title, tone } = counts.trades === 0 ? { title: within === undefined ? 'Not in any watched collection' : `No trade in ${within.name}`, tone: 'clean' as const }
    : counts.flagged > 0 ? { title: flaggedTitle, tone: flaggedTone(transfers.length === 0 ? null : answer(view, null).tone) }
    : transfers.length === 0 ? { title: 'No trade of it matches these filters', tone: 'clean' as const }
    : answer(view, flaggedTitle);
  // Where the title's flagged trades are not: a filter whose list is one page holds none, else they are on other pages.
  const elsewhere = counts.flagged === 0 || hits.length > 0 ? null
    : narrowed && pages.trades.pages <= 1 ? 'None of them matches these filters.' : 'None of them is on this page.';
  // Only an apart title says it already; beside counted trades the grey ones are "more", alone they are not.
  const apartNote = apart === 0 || tone === 'apart' ? null
    : `${apart}${hits.length > 0 ? ' more' : ''} ${apart === 1 ? 'is' : 'are'} ${FLAGGED_ONLY_AU}`;

  const money = funding === null ? 'Its money is not read: it never traded a watched collection.'
    : funding.status === 'pending' ? `Its money is not read yet: queued behind busier wallets (it is in ${plural(funding.transfers, 'transfer')}). Until it is, ${LENSES.AU.name} and ${LENSES.AC.name} cannot see its links.`
    : funding.status === 'failed' ? `Reading its money failed: ${funding.error ?? 'unknown error'}. Retried hourly; until then ${LENSES.AU.name} and ${LENSES.AC.name} cannot see its links.`
    : <>Its money was read {funding.fetchedAt === null ? 'from stored data' : <Time ms={funding.fetchedAt} />}{funding.truncated ? '. It has more history than Etherscan pages through, so it is never treated as the shared funder between two others' : ''}.</>;

  const first = (pages.trades.page - 1) * TRADES + 1;
  // The title counts flagged trades this page or filter does not hold, so then the verdict covers more than these.
  const covers = (them: string) => (elsewhere === null ? `; the verdict above covers ${them}.` : '.');
  const shown = narrowed || pages.trades.pages > 1
    ? transfers.length === 1
      ? `Trade ${num(first)} of ${num(pages.trades.total)} is shown${covers('it')}`
      : `Trades ${num(first)}–${num(first + transfers.length - 1)} of ${num(pages.trades.total)} are shown${covers('these')}`
    : `Every transfer it sent or received in ${scope === undefined ? 'a watched collection' : 'this collection'}.`;
  const named = narrow.find === undefined ? null : findOf(narrow.find);
  const unreadable = named !== null && named.kind !== 'token' && named.kind !== 'address' && named.kind !== 'prefix';
  const partnerFirst = (pages.partners.page - 1) * COUNTERPARTIES + 1;

  const from = within === undefined ? undefined : sp.from;
  // Outside the tabs: the way into each collection it traded, and that collection's panels when it traded only one.
  const ways: Home[] = within !== undefined ? [] : collections.map((c) => {
    const b = `/c/${chainId}/${c.address}`;
    return { base: b, name: c.name ?? short(c.address), href: walletHref(chainId, address, b) };
  });
  const home = within?.collection ?? (collections.length === 1 ? collections[0]!.address : undefined);
  return (
    <>
      {within === undefined ? null : <Suspense fallback={null}><StepLine chainId={chainId} address={within.collection} from={from} of={{ wallet: address }} /></Suspense>}
      {/* Under a collection's tabs its parent line is the layout's; outside them this page draws one the same way. */}
      {within === undefined ? <ParentLine home={ways.length === 1 ? ways[0] : undefined} /> : null}
      <Head
        kind="wallet"
        title={<span className="font-mono">{short(address)}</span>}
        part={<>{counts.trades === 0 ? null : <VerdictChip tone={view.washTrade === null ? null : tone} />}{home === undefined ? null : <Suspense fallback={null}><RingChips chainId={chainId} address={home} of={{ wallet: address }} /></Suspense>}</>}
        sub={<>Wallet on {chainName(chainId)} · <Ext href={explorerAddress(chainId, address)} className="font-mono">{address}</Ext>
          {scope === undefined ? null : <> · its trades here · <Link href={walletHref(chainId, address)} className="hover:text-foreground hover:underline">in every collection</Link></>}</>}
      >
        <OpenUnder homes={ways} />
        <Elsewhere links={walletLinks(chainId, address)} />
      </Head>

      <Answer tone={tone} title={title}>
        {elsewhere === null ? null : <p>{elsewhere} <Link href={`${base}?flagged=1`} className="font-medium hover:underline">Show the flagged ones</Link></p>}
        {transfers.length > 0 && washTrade === null ? <p>{NOT_JUDGED}</p> : null}
        {hits.length > 0 ? <p>Across {plural(tokens, 'token')}, flagged by {lensList(by.filter((m) => HEADLINE.includes(m)))}.</p> : null}
        {apartNote === null ? null : <p className="text-muted-foreground">{apartNote}</p>}
        <p className="text-muted-foreground">{money}</p>
        {/* As the token page says it: what the flag means for this wallet, in a line of its own. */}
        {hits.length > 0 ? (
          <p className="mt-2 text-muted-foreground">
            <b className="font-medium text-foreground">What this means:</b>{' '}
            {by.includes('A')
              ? 'Tokens it traded came back to a wallet that sold them. Open a token below to see the loop.'
              : `${lensList(by.filter((m) => HEADLINE.includes(m)))} found this: it and a wallet it traded with are linked by money. The payments are under Who did it move money with, below.`}
          </p>
        ) : null}
      </Answer>

      {/* Its one collection's panels, here or under its tabs: across several there is no one strip or rail. */}
      {home === undefined ? null : <Suspense fallback={null}><WhereItSits chainId={chainId} address={home} of={{ wallet: address }} /></Suspense>}
      {home === undefined ? null : <Suspense fallback={null}><ConnectedRail chainId={chainId} address={home} wallets={partnersOf(transfers, counterparties, address)} /></Suspense>}

      <Section title="Which of its trades?" lead={<>{transfers.length > 0 ? `${shown} ` : ''}{TINT_LEAD} Open the token to see the pattern.</>}>
        {counts.trades === 0 ? null : (
          <form action={base} method="get" role="search" aria-label="Narrow its trades" className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            {/* The other lists stay where they are; the trades start again at their first page. */}
            {o.psort !== 'flows' ? <input type="hidden" name="psort" value={o.psort} /> : null}
            {o.partners > 1 ? <input type="hidden" name="partners" value={o.partners} /> : null}
            {other !== undefined ? <input type="hidden" name="with" value={other} /> : null}
            {other !== undefined && o.dir !== 'both' ? <input type="hidden" name="dir" value={o.dir} /> : null}
            {other !== undefined && o.flows > 1 ? <input type="hidden" name="flows" value={o.flows} /> : null}
            {scope === undefined ? (
              <select name="collection" defaultValue={narrow.collection ?? ''} aria-label="Only its trades in this collection" className="field">
                <option value="">Every collection</option>
                {collections.map((c) => <option key={c.address} value={c.address}>{c.name ?? short(c.address)} ({num(c.trades)})</option>)}
              </select>
            ) : null}
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="flagged" value="1" defaultChecked={narrow.flaggedOnly === true} />
              Flagged only
            </label>
            <input
              type="search" name="q" defaultValue={narrow.find ?? ''} placeholder="Find a token number or wallet (0x…)"
              aria-label="Find its trades of a token, by its number, or with a wallet, by its address or the start of it"
              className="field w-64"
            />
            <button type="submit" className="btn-secondary">Find</button>
          </form>
        )}
        {narrowed ? (
          <MatchLine n={pages.trades.total} of={plural(counts.trades, 'trade')} query={narrow.find ?? null} clear={href({ filter: other === undefined ? {} : { with: other }, trades: 1 })}>
            {unreadable ? <> · “{narrow.find}” is not a token number, or a wallet address or the start of one, so it matches nothing.</> : null}
          </MatchLine>
        ) : null}
        {narrowed && transfers.length === 0 ? <Empty>No trade of it matches these filters.</Empty> : <Transfers chainId={chainId} transfers={transfers} collection within={scope} />}
        {pages.trades.total > TRADES ? <Pager total={pages.trades.total} page={pages.trades.page} size={TRADES} href={(n) => href({ trades: n })} label="trades" pageParam="trades" /> : null}
      </Section>

      <Section
        title="Who did it move money with?"
        lead={<>{pages.partners.pages > 1 ? `${num(partnerFirst)}–${num(partnerFirst + counterparties.length - 1)} of ${num(pages.partners.total)} counterparties. ` : ''}These are the links {LENSES.AU.name} and {LENSES.AC.name} follow. A counterparty that also trades a watched collection is the kind of link that flags a trade{linked > 0 ? `: ${linked} here do` : ''}. Each count opens the payments it counts, and the trades between the two. Payments are native, internal and wrapped-native, both directions.</>}
      >
        {counterparties.length === 0 ? <Empty>No money flows read for this wallet.</Empty> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">Wallet</th>
                  {PARTNER_COLUMNS.map((c) => (
                    <SortHead key={c.sort} href={href({ psort: c.sort, partners: 1 })} dir={o.psort === c.sort ? 'desc' : null} title="Sort by this, most first" right={c.right}>{c.label}</SortHead>
                  ))}
                </tr>
              </thead>
              <tbody>
                {counterparties.map((c) => {
                  const opens = (n: number, dir: FlowDir) => n === 0 ? <span className="text-muted-foreground">0</span>
                    : <Link href={`${href({ filter: { ...o.filter, with: c.address }, dir, flows: 1 })}#between`} prefetch={false} className="font-medium text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground">{num(n)}</Link>;
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
              <Transfers chainId={chainId} transfers={between.trades} collection within={scope} />
              {between.tradesTotal > TRADES ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  The latest {TRADES} of {num(between.tradesTotal)} are shown. <Link href={href({ filter: { find: other, with: other }, trades: 1 })} className="font-medium text-foreground hover:underline">Page through all of them</Link> in its trades above.
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
                  <Link href={`${href({ dir: d, flows: 1 })}#between`} prefetch={false} aria-current={o.dir === d ? 'true' : undefined} className={cn('hover:underline', o.dir === d ? 'font-medium text-foreground' : '')}>{label}</Link>
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
                    {between.flows.map((f) => {
                      const tx = explorerTx(chainId, f.txHash);
                      return (
                      <tr key={`${f.txHash}:${f.kind}:${f.from}:${f.token}:${f.valueWei}`} className="border-b last:border-b-0">
                        <td className="px-3 py-1.5 whitespace-nowrap text-xs tabular-nums"><Time ms={f.blockTime * 1000} /></td>
                        <td className="px-3 py-1.5">{f.from === address ? 'it sent' : 'it received'}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{FLOW_KIND[f.kind]}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{eth(f.valueWei, f.kind === 'token' ? 'WETH' : 'ETH')}</td>
                        <td className="px-3 py-1.5 text-xs">{tx === null ? <span className="font-mono">{short(f.txHash)}</span> : <Ext href={tx} title={f.txHash}>tx</Ext>}</td>
                      </tr>
                      );
                    })}
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
