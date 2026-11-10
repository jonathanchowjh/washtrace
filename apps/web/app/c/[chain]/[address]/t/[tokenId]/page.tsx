import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { isOwnKey, type LensKey } from '@washtrace/detect/trades';
import { ConnectedRail, railTxs, walletRoles } from '@/components/connected-rail';
import { WhereItSits } from '@/components/sales-strip';
import { Answer, Elsewhere, Empty, Head, MoreLink, Section, SectionHead, Segmented } from '@/components/ui';
import { LensName } from '@/components/methods';
import { Pager } from '@/components/pager';
import { TokenLoops } from '@/components/token-graph';
import { EvidenceGlyph, KindIcon, VerdictChip } from '@/components/kit';
import { Transfers, because, ownBecause, rowList } from '@/components/transfers';
import { LENSES, andList, lensInfo, lensList, notRunAll, num, short, tokenLabel } from '@/lib/format';
import { chainName } from '@/lib/chains';
import { lensTabHref, tokenLinks } from '@/lib/links';
import { layout, reasons } from '@/lib/layout';
import { addressOf, chainOf, pageOf, pages, tokenIdOf } from '@/lib/params';
import { tradesHref } from '@/lib/trades-url';
import { HEADLINE } from '@washtrace/detect';
import { APART_WHY, FLAGGED_ONLY_AU, NOT_JUDGED, TINT_LEAD, answer, counted, toneOf } from '@/lib/metrics';
import { coverage, progress, unread } from '@/lib/coverage';
import { readerZone } from '@/lib/api';
import { configFromSources } from '@/lib/settings';
import { workerSilent } from '@/lib/status';
import { store } from '@/lib/store';
import { tokenView, type EmptyToken } from '@/lib/views';
import { collectionOf } from '@/lib/collection-reads';
import { Suspense } from 'react';
import { RingChips } from '@/components/rings';
import { StepLine } from '@/components/step-line';

/** Transfers on one page of the table; the graph still draws every one. */
const PAGE = 100;

const SHOWS = ['all', 'flagged', 'sales'] as const;
type Show = (typeof SHOWS)[number];
const SHOW_NAME: Record<Show, string> = { all: 'All', flagged: 'Flagged', sales: 'Sales' };

type Props = { params: Promise<{ chain: string; address: string; tokenId: string }>; searchParams: Promise<{ page?: string; show?: string; loop?: string; method?: string; from?: string }> };

/** The token, then its collection, as a ring's page and the lists name theirs. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const c = chainId === null || address === null ? null : await collectionOf(chainId, address);
  const token = `#${tokenIdOf(p.tokenId) === null ? p.tokenId : tokenLabel(p.tokenId)}`;
  return { title: c === null ? token : `${token} · ${c.name ?? short(c.address)}` };
}

/**
 * One token: whether its trades look washed, why, in a sentence per pattern,
 * the graph that shows the pattern, and every transfer it is drawn from.
 */
export default async function TokenPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const sp = await searchParams;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const tokenId = tokenIdOf(p.tokenId);
  if (chainId === null || address === null || tokenId === null) notFound();
  const view = await tokenView(chainId, address, tokenId);
  if (view === 'not-watched') notFound();
  if ('empty' in view) return noTransfer(view.c, tokenId, `/c/${chainId}/${address}`);
  // tokenView has already dropped the lenses that did not run.
  const { collection, flows, middles, transfers, washTrade, judged: judgedAll, by, apartOnly, notRun, own, ownLenses } = view;
  const name = collection.name ?? short(address);
  const base = `/c/${chainId}/${address}`;
  // Counted as the wallet page counts: a transfer flagged only by Money loops back is shown grey, and said apart.
  const flagged = transfers.filter(counted).length;
  const apart = transfers.filter((t) => toneOf(t) === 'apart').length;
  const lenses = by.filter((m) => HEADLINE.includes(m));
  const apartNote = apart === 0 ? '' : ` ${apart} more ${apart === 1 ? 'is' : 'are'} ${FLAGGED_ONLY_AU}`;
  // Your lenses' catches, said apart: the verdict and its title stay the built-ins'.
  const ownByRow = new Map<string, LensKey[]>();
  for (const f of own) {
    const keys = ownByRow.get(`${f.txHash}:${f.logIndex}`) ?? [];
    if (!keys.includes(`L${f.lensId}`)) keys.push(`L${f.lensId}`);
    ownByRow.set(`${f.txHash}:${f.logIndex}`, keys);
  }
  const ownNames = [...new Set(own.map((f): LensKey => `L${f.lensId}`))].flatMap((k) => lensInfo(k, ownLenses)?.name ?? []);
  const ownLine = ownByRow.size === 0 ? '' : ` Your lenses also catch ${ownByRow.size} of its trades: ${andList(ownNames)}.`;
  const { title, tone } = answer(view, by.includes('A') ? 'Its trades go round in circles' : 'Its buyers and sellers are linked by money', ownByRow.size > 0);
  const why = reasons(transfers);

  // A row's number is its place in the whole chain order. The filter keeps some of them, the page shows a hundred of those.
  const show = SHOWS.find((s) => s === sp.show) ?? 'all';
  const keeps = (t: (typeof transfers)[number]) => show === 'all' || (show === 'sales' ? t.marketplace !== null : METHODS.some((m) => t.flags[m]));
  const kept = transfers.flatMap((t, i) => (keeps(t) ? [i + 1] : []));
  const pageCount = pages(kept.length, PAGE);
  const page = Math.min(pageCount, pageOf(sp.page));
  const shown = kept.slice((page - 1) * PAGE, page * PAGE);
  const shownFlagged = kept.filter((n) => METHODS.some((m) => transfers[n - 1]!.flags[m])).length;
  const here = `${base}/t/${tokenId}`;
  /** A link to a page of a filter. Absolute, because the pager's page box takes its form action from it. */
  const hrefFor = (pg: number, s: Show) => {
    const query = [pg > 1 ? `page=${pg}` : '', s === 'all' ? '' : `show=${s}`].filter(Boolean);
    return query.length === 0 ? here : `${here}?${query.join('&')}`;
  };
  const place = new Map(kept.map((n, i) => [n, i + 1]));
  /** Where row n is: on its page of this filter, or, if the filter hides it, of the whole list. */
  const rowHref = (n: number) => {
    const at = place.get(n);
    const s = at === undefined ? 'all' : show;
    const target = Math.ceil((at ?? n) / PAGE);
    const query = [target > 1 ? `page=${target}` : '', s === 'all' ? '' : `show=${s}`].filter(Boolean);
    // An empty query would stay on the page being viewed, which may be another page or filter.
    if (query.length === 0 && (page > 1 || show !== 'all')) query.push('page=1');
    return `${query.length === 0 ? '' : `?${query.join('&')}`}#t${n}`;
  };

  const drawing = layout(transfers, flows, middles, own, ownLenses);
  // The table's link to every row the graph numbers, built here because only the server knows which page of the filter holds a row.
  const rowHrefs = Object.fromEntries(drawing.edges.flatMap((e) => (e.row === null ? [] : [[e.row, rowHref(e.row)] as const])));
  // A loop the link names wins over a lens; one that matches nothing lights nothing.
  const lens: LensKey | undefined = sp.method === undefined ? undefined : METHODS.find((m) => m === sp.method) ?? (isOwnKey(sp.method) ? sp.method : undefined);
  const initial = sp.loop ? { loop: sp.loop } : lens !== undefined ? { method: lens } : null;
  // Row numbers are 1-based, as the graph labels them.
  const rowOf = new Map(transfers.map((t, i) => [`${t.txHash}:${t.logIndex}`, i + 1]));
  const ownLoops = drawing.loops.slice(why.length);

  // The list it was opened from, if any: its stepper reads that list in a Suspense of its own.
  return (
    <>
      <Suspense fallback={null}><StepLine chainId={chainId} address={address} from={sp.from} of={{ token: tokenId }} /></Suspense>
      <Head
        kind="token"
        title={`${name} #${tokenLabel(tokenId)}`}
        sub={`${chainName(chainId)} · ${transfers.length} transfers, in the order the chain recorded them`}
        part={<><VerdictChip tone={washTrade === null ? null : tone} /><Suspense fallback={null}><RingChips chainId={chainId} address={address} of={{ token: tokenId }} /></Suspense></>}
      >
        <Elsewhere links={tokenLinks(chainId, address, tokenId)} />
      </Head>

      <Answer tone={tone} title={title}>
        {washTrade === null ? (
          <>
            {NOT_JUDGED}
            {/* Not judged means no counted lens flags any of it (verdict), so only an apart flag is left to say. */}
            {apart > 0 ? ` ${apart} of ${transfers.length} transfers are ${FLAGGED_ONLY_AU}` : ''}
            {notRun.length > 0 ? ` ${notRunAll(notRun)}` : ''}
          </>
        ) : apartOnly ? (
          <>{apart} of {transfers.length} transfers flagged, by {lensList(by)}: {APART_WHY}.</>
        ) : by.length === 0 ? (
          <>None of its {transfers.length} transfers is flagged by {ownByRow.size > 0 ? 'the built-in lenses' : notRun.length > 0 ? 'the lenses that ran' : 'any lens'}{ownByRow.size > 0 && notRun.length > 0 ? ' that ran' : ''}.{notRun.length > 0 ? ` ${notRunAll(notRun)}` : ''}</>
        ) : (
          <>
            {flagged} of {transfers.length} transfers flagged, by {lensList(lenses)}.{' '}
            They count toward <Link href={lensTabHref(base, lenses[0]!)} className="underline hover:text-foreground">{name}&rsquo;s share</Link> under each of those lenses.{apartNote}
          </>
        )}
        {ownLine}
        {by.length > 0 && !apartOnly ? (
          <p className="mt-2 text-muted-foreground">
            <b className="font-medium text-foreground">What this means:</b>{' '}
            {by.includes('A')
              ? 'Its trades return to a wallet that sold it. The loop is drawn below.'
              : `${lensList(lenses)} found this: a buyer and a seller of the token are linked by money. The money paths are the dashed arrows below.`}
          </p>
        ) : null}
      </Answer>

      <Suspense fallback={null}><WhereItSits chainId={chainId} address={address} of={{ token: tokenId }} /></Suspense>
      <Suspense fallback={null}>{/* Its sales are the Every transfer table's; the rail names only the payments, which no table here lists. */}
      <ConnectedRail chainId={chainId} address={address} wallets={walletRoles(transfers, flows, middles)} txs={railTxs([], flows)} /></Suspense>

      <TokenLoops
        drawing={drawing} chainId={chainId} base={base} rowHrefs={rowHrefs} initial={initial}
        graphHead={<SectionHead title="What it looks like" lead="Each circle is a wallet: click one to light its arrows, and again to open it. Solid arrows are the token changing hands, numbered as in the table below, and click to open the trade; dashed arrows are money between the same wallets." />}
        whyHead={<SectionHead title={apartOnly && own.length === 0 ? `Why ${LENSES.AU.name} flags it` : 'Why it was flagged'} lead={drawing.loops.length === 0 ? undefined : `One line per pattern found, with the transfers it covers and the lenses that agree on it${own.length === 0 ? '' : ', then one per loop a lens of yours found'}. Show in graph lights the pattern.`} />}
        empty={<Empty>{judgedAll ? <>No lens found a pattern: the token never returns to a wallet that held it{notRun.length > 0 ? `. ${notRunAll(notRun)}` : ', and no buyer and seller are linked by money.'}</> : NOT_JUDGED}</Empty>}
        items={[
          ...why.map((r, i) => ({
            key: drawing.loops[i]!.key,
            body: <span className="flex items-start gap-3"><EvidenceGlyph witness={r.witness} className="mt-0.5" /><span>{because(r.witness, chainId, base)}</span></span>,
            meta: (
              <>
                <span>transfer{r.rows.length === 1 ? '' : 's'} <RowLinks rows={r.rows} rowHref={rowHref} /></span>
                {r.methods.map((m) => <LensName key={m} m={m} className="text-xs" href={lensTabHref(base, m, { evidence: true })} />)}
              </>
            ),
          })),
          // layout() draws your lenses' loops after the built-ins', one per flag in `own`'s order.
          ...own.map((f, i) => {
            const row = rowOf.get(`${f.txHash}:${f.logIndex}`);
            const key: LensKey = `L${f.lensId}`;
            return {
              key: ownLoops[i]!.key,
              body: ownBecause(f),
              meta: (
                <>
                  {row === undefined ? null : <span>transfer <RowLinks rows={[row]} rowHref={rowHref} /></span>}
                  <LensName m={key} own={ownLenses} className="text-xs" href={lensTabHref(base, key, { evidence: true })} />
                </>
              ),
            };
          }),
        ]}
      />

      <Section title="Every transfer" lead={`${TINT_LEAD} The number in the first column is the arrow's label in the graph.`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <Segmented label="Show all, flagged or sales transfers" items={SHOWS.map((s) => ({ key: s, href: hrefFor(1, s), label: SHOW_NAME[s], current: s === show }))} />
          {/* With more than one page the pager below says which rows these are; the flagged count is all that is left to say here. */}
          <p className="text-sm text-muted-foreground tabular-nums">
            {pageCount > 1 ? null : <>Showing {num(shown[0] === undefined ? 0 : 1)}–{num(shown.length)} of {num(kept.length)} transfers</>}
            {shownFlagged === 0 ? null : <>{pageCount > 1 ? null : ' · '}{show === 'all' ? <Link href={hrefFor(1, 'flagged')} prefetch={false} className="hover:underline">{num(shownFlagged)} flagged</Link> : `${num(shownFlagged)} flagged`}</>}
          </p>
        </div>
        {kept.length === 0 ? (
          <Empty>None of its transfers is {show === 'sales' ? 'a sale' : 'flagged'}.</Empty>
        ) : (
          <>
            <Transfers chainId={chainId} transfers={shown.map((n) => transfers[n - 1]!)} numbers={shown} numbered base={base} within={base} own={ownByRow} names={ownLenses} />
            {pageCount > 1 ? <Pager total={kept.length} page={page} size={PAGE} href={(n) => hrefFor(n, show)} label="transfers" /> : null}
          </>
        )}
        {/* The same transfers in the Trades view, to filter, group or download. */}
        <MoreLink href={tradesHref(base, { kind: 'all', token: tokenId })} className="mt-3">Every trade of this token →</MoreLink>
      </Section>
    </>
  );
}

/** A watched collection that has no transfer of this token: still being read, or never had one. */
async function noTransfer(c: EmptyToken['c'], tokenId: string, base: string) {
  const s = store();
  const [passes, sources, settings, zone] = await Promise.all([s.passes(), s.sources(), s.settings(), readerZone()]);
  const config = configFromSources(sources, settings);
  const cov = coverage(c, new Set(config.chains), Date.now(), zone, config.funding, workerSilent(passes, Date.now()) !== null);
  const name = c.name ?? short(c.address);
  const reading = unread(cov);
  // Shaped as every token page is, chip and answer, so a token with nothing read never reads as missing or as clean.
  return (
    <>
      <Head kind="token" title={`${name} #${tokenLabel(tokenId)}`} sub={chainName(c.chainId)} part={<VerdictChip tone={null} />} />
      <Answer tone="clean" title="No transfer of this token is read">
        {reading ? `No transfer of #${tokenId} is read yet · history ${progress(cov.blocks ?? 0)} read` : `No transfer of #${tokenId} is in ${name}'s history.`}
        <p className="mt-2 text-muted-foreground">
          <b className="font-medium text-foreground">What this means:</b>{' '}
          {reading
            ? 'Its transfers may be in the part of the history still to read, or it may not be minted. Nothing about it is judged, which is not the same as clean.'
            : 'It may not be minted, or the number is not one of this collection’s. Nothing about it is judged, which is not the same as clean.'}
        </p>
      </Answer>
      <Link href={base} className="btn mt-4 inline-flex items-center gap-1.5 text-sm"><KindIcon kind="collection" />Back to {name}</Link>
    </>
  );
}

/** The rows a pattern covers, each a link to its page; a run of three or more is one link to its first. */
function RowLinks({ rows, rowHref }: { rows: readonly number[]; rowHref: (n: number) => string }) {
  const cls = 'font-medium text-foreground underline';
  const sorted = [...rows].sort((a, b) => a - b);
  if (sorted.length > 2 && rowList(rows).includes('–')) return <a href={rowHref(sorted[0]!)} className={cls}>{rowList(rows)}</a>;
  return <>{sorted.map((n, i) => <span key={n}>{i > 0 ? ', ' : ''}<a href={rowHref(n)} className={cls}>{n}</a></span>)}</>;
}
