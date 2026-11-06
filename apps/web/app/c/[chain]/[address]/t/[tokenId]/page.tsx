import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS, type Method } from '@washtrace/detect';
import { Answer, Elsewhere, Head, Section, SectionHead } from '@/components/head';
import { LensName } from '@/components/methods';
import { Pager } from '@/components/pager';
import { TokenLoops } from '@/components/token-graph';
import { Transfers, because, rowList } from '@/components/transfers';
import { addressOf, chainOf, tokenIdOf } from '@/lib/api';
import { lensList, short } from '@/lib/format';
import { tokenLinks } from '@/lib/links';
import { layout, reasons } from '@/lib/layout';
import { tradesHref } from '@/lib/trades';
import { APART_WHY, HEADLINE, NOT_JUDGED, TINT_LEAD, answer, counted, toneOf } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { tokenView } from '@/lib/views';

/** Transfers on one page of the table; the graph still draws every one. */
const PAGE = 100;

const SHOWS = ['all', 'flagged', 'sales'] as const;
type Show = (typeof SHOWS)[number];
const SHOW_NAME: Record<Show, string> = { all: 'All', flagged: 'Flagged', sales: 'Sales' };

type Props = { params: Promise<{ chain: string; address: string; tokenId: string }>; searchParams: Promise<{ page?: string; show?: string; loop?: string; method?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tokenId } = await params;
  return { title: `#${tokenId}` };
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
  if (view === null) notFound();
  // tokenView has already dropped the lenses that did not run.
  const { collection, flows, middles, transfers, washTrade, judged: judgedAll, by, apartOnly, notRun } = view;
  const name = collection.name ?? short(address);
  const base = `/c/${chainId}/${address}`;
  // Counted as the wallet page counts: a transfer flagged only by Money loops back is shown grey, and said apart.
  const flagged = transfers.filter(counted).length;
  const apart = transfers.filter((t) => toneOf(t) === 'apart').length;
  const lenses = by.filter((m) => HEADLINE.includes(m));
  const apartNote = apart === 0 ? '' : ` ${apart} more ${apart === 1 ? 'is' : 'are'} flagged only by Money loops back, which is not counted.`;
  const { title, tone } = answer(view, by.includes('A') ? 'Its trades go round in circles' : 'Its buyers and sellers are linked by money');
  const why = reasons(transfers);

  // A row's number is its place in the whole chain order. The filter keeps some of them, the page shows a hundred of those.
  const show = SHOWS.find((s) => s === sp.show) ?? 'all';
  const keeps = (t: (typeof transfers)[number]) => show === 'all' || (show === 'sales' ? t.marketplace !== null : METHODS.some((m) => t.flags[m]));
  const kept = transfers.flatMap((t, i) => (keeps(t) ? [i + 1] : []));
  const pages = Math.max(1, Math.ceil(kept.length / PAGE));
  const asked = Number(sp.page ?? '1');
  const page = Number.isSafeInteger(asked) ? Math.min(pages, Math.max(1, asked)) : 1;
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

  const drawing = layout(transfers, flows, middles);
  // The table's link to every row the graph numbers, built here because only the server knows which page of the filter holds a row.
  const rowHrefs = Object.fromEntries(drawing.edges.flatMap((e) => (e.row === null ? [] : [[e.row, rowHref(e.row)] as const])));
  // A loop the link names wins over a lens; one that matches nothing lights nothing.
  const initial = sp.loop ? { loop: sp.loop } : METHODS.find((m) => m === sp.method) ? { method: sp.method as Method } : null;

  return (
    <>
      <Head
        title={`${name} #${tokenId.length > 20 ? `${tokenId.slice(0, 18)}…` : tokenId}`}
        crumb={[{ href: '/', label: 'Collections' }, { href: base, label: name }]}
        sub={`${transfers.length} transfers, in the order the chain recorded them`}
      >
        <Elsewhere links={tokenLinks(chainId, address, tokenId)} />
      </Head>

      <Answer tone={tone} title={title}>
        {washTrade === null ? (
          <>
            {NOT_JUDGED}
            {/* Not judged means no counted lens flags any of it (verdict), so only an apart flag is left to say. */}
            {apart > 0 ? ` ${apart} of ${transfers.length} transfers are flagged only by Money loops back, which is not counted.` : ''}
            {notRun.length > 0 ? ` ${lensList(notRun)} did not run.` : ''}
          </>
        ) : apartOnly ? (
          <>{apart} of {transfers.length} transfers flagged, by {lensList(by)}: {APART_WHY}.</>
        ) : by.length === 0 ? (
          <>None of its {transfers.length} transfers is flagged by {notRun.length > 0 ? 'the lenses that ran' : 'any lens'}.{notRun.length > 0 ? ` ${lensList(notRun)} did not run.` : ''}</>
        ) : (
          <>
            {flagged} of {transfers.length} transfers flagged, by {lensList(lenses)}.{' '}
            They count toward <Link href={`${base}?method=${lenses[0]}`} className="underline hover:text-foreground">{name}&rsquo;s share</Link> under each of those lenses.{apartNote}
          </>
        )}
        {by.length > 0 && !apartOnly ? (
          <p className="mt-2 text-muted-foreground">
            <b className="font-medium text-foreground">What this means:</b>{' '}
            {by.includes('A')
              ? 'Its trades return to a wallet that sold it. The loop is drawn below.'
              : `${lensList(lenses)} found this: a buyer and a seller of the token are linked by money. The money paths are the dashed arrows below.`}
          </p>
        ) : null}
      </Answer>

      <TokenLoops
        drawing={drawing} chainId={chainId} rowHrefs={rowHrefs} initial={initial}
        graphHead={<SectionHead title="What it looks like" lead="Each circle is a wallet: click one to light its arrows, and again to open it. Solid arrows are the token changing hands, numbered as in the table below, and click to open the trade; dashed arrows are money between the same wallets." />}
        whyHead={<SectionHead title={apartOnly ? 'Why Money loops back flags it' : 'Why it was flagged'} lead={why.length === 0 ? undefined : 'One line per pattern found, with the transfers it covers and the lenses that agree on it. Show in graph lights the pattern.'} />}
        empty={<p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">{judgedAll ? <>No lens found a pattern: the token never returns to a wallet that held it{notRun.length > 0 ? `, and ${lensList(notRun)} did not run` : ', and no buyer and seller are linked by money'}.</> : 'No analysis has covered these transfers yet, so no lens has looked for a pattern.'}</p>}
        items={why.map((r, i) => ({
          key: drawing.loops[i]!.key,
          body: because(r.witness, chainId),
          meta: (
            <>
              <span>transfer{r.rows.length === 1 ? '' : 's'} <RowLinks rows={r.rows} rowHref={rowHref} /></span>
              {r.methods.map((m) => <LensName key={m} m={m} className="text-xs" href={`${base}?method=${m}#evidence`} />)}
            </>
          ),
        }))}
      />

      <Section title="Every transfer" lead={`${TINT_LEAD} The number in the first column is the arrow's label in the graph.`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Show" className="flex rounded-md border bg-card p-0.5 text-sm">
            {SHOWS.map((s) => (
              <Link key={s} href={hrefFor(1, s)} aria-current={s === show ? 'page' : undefined}
                className={cn('rounded px-3 py-1', s === show ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
                {SHOW_NAME[s]}
              </Link>
            ))}
          </nav>
          <p className="text-sm text-muted-foreground tabular-nums">
            Showing {(shown[0] === undefined ? 0 : (page - 1) * PAGE + 1).toLocaleString()}–{((page - 1) * PAGE + shown.length).toLocaleString()} of {kept.length.toLocaleString()} transfers
            {shownFlagged === 0 ? null : show === 'all' ? <> · <Link href={hrefFor(1, 'flagged')} className="hover:underline">{shownFlagged.toLocaleString()} flagged</Link></> : ` · ${shownFlagged.toLocaleString()} flagged`}
          </p>
        </div>
        {kept.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">None of its transfers is {show === 'sales' ? 'a sale' : 'flagged'}.</p>
        ) : (
          <>
            <Transfers chainId={chainId} transfers={shown.map((n) => transfers[n - 1]!)} numbers={shown} numbered base={base} />
            {pages > 1 ? <Pager total={kept.length} page={page} size={PAGE} href={(n) => hrefFor(n, show)} label="transfers" /> : null}
          </>
        )}
        {/* The same transfers in the Trades view, to filter, group or download. */}
        <p className="mt-3 text-sm"><Link href={tradesHref(base, { kind: 'all', token: tokenId })} className="font-medium hover:underline">Every trade of this token →</Link></p>
      </Section>
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
