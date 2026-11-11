import Link from 'next/link';
import type { FlowDir, PartnerSort } from '@washtrace/detect';
import { findOf } from '@washtrace/detect/trades';
import { ConnectedRail, OpenUnder, ParentLine, type Home } from '@/components/connected-rail';
import { middleWords, partnersOf } from '@/lib/why';
import { VerdictChip } from '@/components/kit';
import { WhereItSits } from '@/components/sales-strip';
import { Answer, Elsewhere, Empty, Head, Section, SortHead } from '@/components/ui';
import { MatchLine } from '@/components/lens-lists';
import { Pager } from '@/components/pager';
import { Payments, TokenLink, Transfers, Wallet } from '@/components/transfers';
import { chainName } from '@/lib/chains';
import { MONEY_LENSES, lensList, plural, short, num } from '@/lib/format';
import { carry, walletHref, walletLinks } from '@/lib/links';
import { HEADLINE } from '@washtrace/detect';
import { FLAGGED_ONLY_AU, NOT_JUDGED, TINT_LEAD, answer, counted, toneOf, type Tone } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { hrefOf, walletOpts, type WalletOpts } from '@/lib/params';
import { contextOf } from '@/lib/step';
import { COUNTERPARTIES, FLOWS, TRADES, walletView } from '@/lib/views';
import { EvidenceLine } from '@/components/coverage';
import { Fragment, Suspense } from 'react';
import { RingChips } from '@/components/rings';
import { StepLine } from '@/components/step-line';

/** The partner table's sortable columns, by the order each sets. */
const PARTNER_COLUMNS: readonly { sort: PartnerSort; label: string; right: boolean }[] = [
  { sort: 'watched', label: 'Also trades a watched collection', right: false },
  { sort: 'flows', label: 'Payments in all', right: true },
  { sort: 'sent', label: 'Payments sent to it', right: true },
  { sort: 'received', label: 'Payments received from it', right: true },
];

/** A flagged wallet's card: the page verdict's tone when it is a flagged one, else the ceiling's. */
function flaggedTone(page: Tone | null): Tone {
  return page === 'cycle' || page === 'ceiling' ? page : 'ceiling';
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
  const { collections, counterparties, middles, partnerMiddles, middleIn, transfers, counts, pages, between, by, washTrade } = view;
  // The page as shown: every page clamped to the last there is.
  const o: WalletOpts = { ...asked, trades: pages.trades.page, partners: pages.partners.page, flows: pages.flows.page };
  const scope = within?.base;
  const base = walletHref(chainId, address, scope);
  // Under a collection's tabs a link keeps the lens and the list the page was opened with; one to another kind of item keeps the lens only.
  const ctx = scope === undefined ? {} : contextOf(sp);
  const away = { method: ctx.method };
  const href = (over: Partial<WalletOpts>) => hrefOf(base, { ...o, ...over }, ctx);
  const { with: other, ...narrow } = o.filter;
  const narrowed = Object.keys(narrow).length > 0;

  const hits = transfers.filter(counted);
  // Shown tinted grey, yet outside the verdict: say so, or the title and the rows contradict each other.
  const apart = transfers.filter((t) => toneOf(t) === 'apart').length;
  const tokens = new Set(hits.map((t) => `${t.collection?.address}:${t.tokenId}`)).size;
  const linked = counterparties.filter((c) => c.watched).length;
  // The title counts every transfer it sent or received, a mint among them, so it says transfers: the flagged count opens the flagged-only list, the total all of them.
  // A flagged wallet titles from its counts, though the page shown holds none of them, and is never in a clean or grey card:
  // the page's verdict gives its tone when that is a flagged one, else it is money's. The notes stay the page's own.
  const flaggedTitle = <>In <Link href={carry(`${base}?flagged=1`, ctx)} prefetch={false} className="hover:underline">{num(counts.flagged)}</Link> flagged {counts.flagged === 1 ? 'transfer' : 'transfers'} out of <Link href={carry(base, ctx)} prefetch={false} className="hover:underline">{num(counts.trades)}</Link></>;
  // It sold nothing there, but a middle of linked pairs leads with that role: Linked wallets' evidence, so the ceiling's tone, not a clean one.
  // Across every collection it names each it is a middle in, opening its page there, where the pairs are read.
  const moreTokens = middles.tokens - 1;
  const { title, tone } = counts.trades === 0 && scope !== undefined && middles.rows.length > 0
    ? { title: <>{middleWords(middles.rows)} <TokenLink base={scope} tokenId={middles.rows[0]!.tokenId} method={ctx.method} />{moreTokens > 0 ? ` and ${moreTokens} more` : ''}</>, tone: 'ceiling' as const }
    : counts.trades === 0 && middleIn.length > 0
    ? { title: <>Is in between sellers and buyers in {middleIn.map((c, i) => <Fragment key={c.address}>{i === 0 ? '' : i === middleIn.length - 1 ? ' and ' : ', '}<Link href={walletHref(chainId, address, `/c/${chainId}/${c.address}`)} prefetch={false} className="hover:underline">{c.name ?? short(c.address)}</Link></Fragment>)}</>, tone: 'ceiling' as const }
    : counts.trades === 0 ? { title: within === undefined ? 'Not in any watched collection' : `No transfer of it in ${within.name}`, tone: 'clean' as const }
    : counts.flagged > 0 ? { title: flaggedTitle, tone: flaggedTone(transfers.length === 0 ? null : answer(view, null).tone) }
    : transfers.length === 0 ? { title: 'No transfer of it matches these filters', tone: 'clean' as const }
    : answer(view, flaggedTitle);
  // Where the title's flagged trades are not: a filter whose list is one page holds none, else they are on other pages.
  const elsewhere = counts.flagged === 0 || hits.length > 0 ? null
    : narrowed && pages.trades.pages <= 1 ? 'None of them matches these filters.' : 'None of them is on this page.';
  // Only an apart title says it already; beside counted trades the grey ones are "more", alone they are not.
  const apartNote = apart === 0 || tone === 'apart' ? null
    : `${apart}${hits.length > 0 ? ' more' : ''} ${apart === 1 ? 'is' : 'are'} ${FLAGGED_ONLY_AU}`;

  const first = (pages.trades.page - 1) * TRADES + 1;
  // The title counts flagged trades this page or filter does not hold, so then the verdict covers more than these.
  const covers = (them: string) => (elsewhere === null ? `; the verdict above covers ${them}.` : '.');
  const shown = narrowed || pages.trades.pages > 1
    ? transfers.length === 1
      ? `Transfer ${num(first)} of ${num(pages.trades.total)} is shown${covers('it')}`
      : `Transfers ${num(first)}–${num(first + transfers.length - 1)} of ${num(pages.trades.total)} are shown${covers('these')}`
    : `Every transfer it sent or received in ${scope === undefined ? 'a watched collection' : 'this collection'}.`;
  const named = narrow.find === undefined ? null : findOf(narrow.find);
  const unreadable = named !== null && named.kind !== 'token' && named.kind !== 'address' && named.kind !== 'prefix';
  const partnerFirst = (pages.partners.page - 1) * COUNTERPARTIES + 1;

  // Outside the tabs: the way into each collection it traded, and that collection's panels when it traded only one.
  const ways: Home[] = within !== undefined ? [] : collections.map((c) => {
    const b = `/c/${chainId}/${c.address}`;
    return { base: b, name: c.name ?? short(c.address), href: walletHref(chainId, address, b) };
  });
  const home = within?.collection ?? (collections.length === 1 ? collections[0]!.address : undefined);
  return (
    <>
      {within === undefined ? null : <Suspense fallback={null}><StepLine chainId={chainId} address={within.collection} from={ctx.from} method={ctx.method} of={{ wallet: address }} /></Suspense>}
      {/* Under a collection's tabs its parent line is the layout's; outside them this page draws one the same way. */}
      {within === undefined ? <ParentLine home={ways.length === 1 ? ways[0] : undefined} leaf={short(address)} /> : null}
      <Head
        kind="wallet"
        title={<span className="font-mono break-all">{address}</span>}
        part={<>{counts.trades === 0 ? null : <VerdictChip tone={view.washTrade === null ? null : tone} />}{home === undefined ? null : <Suspense fallback={null}><RingChips chainId={chainId} address={home} of={{ wallet: address }} /></Suspense>}</>}
        sub={<>Wallet on {chainName(chainId)}
          {scope === undefined ? null : <> · its trades here · <Link href={walletHref(chainId, address)} className="hover:text-foreground hover:underline">in every collection</Link></>}</>}
      >
        <OpenUnder homes={ways} />
        <Elsewhere links={walletLinks(chainId, address)} />
      </Head>

      {/* The answer, the strip and the rail are cards of their own, apart from each other. */}
      <div className="space-y-4">
        <Answer tone={tone} title={title}>
          {elsewhere === null ? null : <p>{elsewhere} <Link href={carry(`${base}?flagged=1`, ctx)} className="font-medium hover:underline">Show the flagged ones</Link></p>}
          {transfers.length > 0 && washTrade === null ? <p>{NOT_JUDGED}</p> : null}
          {hits.length > 0 ? <p>Across {plural(tokens, 'token')}, flagged by {lensList(by.filter((m) => HEADLINE.includes(m)))}.</p> : null}
          {apartNote === null ? null : <p className="text-muted-foreground">{apartNote}</p>}
          {/* As the token page says it: what the flag means for this wallet, in a line of its own. */}
          {hits.length > 0 ? (
            <p className="mt-2 text-muted-foreground">
              <b className="font-medium text-foreground">What this means:</b>{' '}
              {by.includes('A')
                ? 'Tokens it traded came back to a wallet that sold them. Open a token below to see the loop.'
                : `${lensList(by.filter((m) => HEADLINE.includes(m)))} found this: it and a wallet it traded with are linked by money. The payments are under Who did it move money with, below.`}
            </p>
          ) : null}
          <Suspense fallback={null}><EvidenceLine chainId={chainId} wallets={[address]} home={home} viaPartners={counts.trades === 0 && counterparties.length > 0} untraded={counts.trades === 0} className="mt-2" /></Suspense>
        </Answer>

        {/* Its one collection's panels, here or under its tabs: across several there is no one strip or rail. */}
        {home === undefined ? null : <Suspense fallback={null}><WhereItSits chainId={chainId} address={home} of={{ wallet: address }} transfers={counts.trades} /></Suspense>}
        {/* A wallet with no transfer here is part of nothing here: the rail would name the collection and its share as if it were. */}
        {home === undefined || counts.trades === 0 ? null : <Suspense fallback={null}><ConnectedRail chainId={chainId} address={home} ctx={away} wallets={partnersOf(transfers, counterparties, address, partnerMiddles)} /></Suspense>}
      </div>

      <Section title="Which of its transfers?" lead={<>{transfers.length > 0 ? `${shown} ` : ''}{TINT_LEAD} Open the token to see the pattern.</>}>
        {counts.trades === 0 ? null : (
          <form action={base} method="get" role="search" aria-label="Narrow its trades" className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            {/* The other lists stay where they are; the trades start again at their first page. */}
            {ctx.method !== undefined ? <input type="hidden" name="method" value={ctx.method} /> : null}
            {ctx.from !== undefined ? <input type="hidden" name="from" value={ctx.from} /> : null}
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
          <MatchLine n={pages.trades.total} of={plural(counts.trades, 'transfer')} query={narrow.find ?? null} clear={href({ filter: other === undefined ? {} : { with: other }, trades: 1 })}>
            {unreadable ? <> · “{narrow.find}” is not a token number, or a wallet address or the start of one, so it matches nothing.</> : null}
          </MatchLine>
        ) : null}
        {counts.trades === 0 ? <Empty>No transfer of it is read in {within?.name ?? 'a watched collection'}.</Empty>
          : narrowed && transfers.length === 0 ? <Empty>No transfer of it matches these filters.</Empty> : <Transfers chainId={chainId} transfers={transfers} collection within={scope} ctx={away} />}
        {pages.trades.total > TRADES ? <Pager total={pages.trades.total} page={pages.trades.page} size={TRADES} href={(n) => href({ trades: n })} label="transfers" pageParam="trades" /> : null}
      </Section>

      <Section
        title="Who did it move money with?"
        lead={<>{pages.partners.pages > 1 ? `${num(partnerFirst)}–${num(partnerFirst + counterparties.length - 1)} of ${num(pages.partners.total)} counterparties. ` : ''}These are the links {MONEY_LENSES} follow. A counterparty that also trades a watched collection is the kind of link that flags a trade{linked > 0 ? `: ${linked} here do` : ''}. Each count opens the payments it counts, and the trades between the two. Payments are native, internal and wrapped-native, both directions.</>}
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
                      <td className="px-3 py-1.5"><Wallet chainId={chainId} address={c.address} within={scope} ctx={away} /></td>
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
          lead={<>The trades where one sold to the other, either way, and the payments between them. <Wallet chainId={chainId} address={other} within={scope} ctx={away} /> opens its own page.</>}>
          <h3 className="mb-1.5 text-sm font-medium">Which trades were between them?</h3>
          {between.tradesTotal === 0 ? <Empty>Neither sold the other a token in a watched collection.</Empty> : (
            <>
              <Transfers chainId={chainId} transfers={between.trades} collection within={scope} ctx={away} />
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
              <Payments chainId={chainId} flows={between.flows} self={address} within={scope} ctx={away} />
              <Pager total={between.flowsTotal} page={pages.flows.page} size={FLOWS} href={(n) => `${href({ flows: n })}#between`} label="payments" pageParam="flows" />
            </>
          )}
        </Section>
      )}
    </>
  );
}
