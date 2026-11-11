import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Pipeline } from '@/components/pipeline';
import { ReadingSummary } from '@/components/coverage';
import { Empty, Head, MoreLink, Section, Silent } from '@/components/ui';
import { LensList } from '@/components/lens-lists';
import { Compare } from '@/components/compare';
import { LensEditor } from '@/components/lens-editor';
import { LensTabs } from '@/components/lens-tabs';
import { History, LensStats, Trend } from '@/components/methods';
import { Refresh } from '@/components/refresh';
import { lensKeyOf, readerZone } from '@/lib/api';
import { editorStart } from '@/lib/lens-api';
import { mayWrite } from '@/lib/auth';
import { rulesNote } from '@/lib/collections';
import { NOT_RUN_LATEST, lensInfo, pct, pctTenth, plural, short } from '@/lib/format';
import { builtinCauses, runStateWords, shareQualifier } from '@/lib/lens-state';
import { type Method, type MethodTotals, type TokenSort, type WalletSort } from '@washtrace/detect';
import { listHref } from '@/lib/links';
import { collectionAt, runsOf, tradeContextOf } from '@/lib/collection-reads';
import { coverage, unread } from '@/lib/coverage';
import { chartLenses, evidenceLead, leftOut, ownLenses } from '@/lib/metrics';
import { trailComing } from '@/lib/pipeline';
import { store, storedEntry } from '@/lib/store';
import { listView } from '@/lib/params';
import { fromParam } from '@/lib/step';
import { LIST_PAGE, clampedPage, collectionStatus, collectionView } from '@/lib/views';

/** Rows of each lens list a page in the lens panel; the flagged page has all of them. */
const TOP = 10;

/**
 * The lens, and each list's page, order and Find: tokens' `tp`, `ts` and
 * `tq`, wallets' `wp`, `ws` and `wq`, so the two lists page apart.
 */
type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<{ method?: string; lens?: string; tp?: string; ts?: string; tq?: string; wp?: string; ws?: string; wq?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = await collectionAt(await params);
  return { title: c ? `Methods · ${c.name ?? short(c.address)}` : 'Methods' };
}

/**
 * What the collection's overview stands on: the lenses its range is made of,
 * with the tokens and wallets behind the chosen one and your own lenses; each
 * lens's share over time; and the reading, stage by stage. The overview links
 * here from its "How sure" ladder.
 */
export default async function MethodsPage({ params, searchParams }: Props) {
  await connection();
  const c = (await collectionAt(await params)) ?? notFound();
  const { chainId, address } = c;
  const s = store();
  const sp = await searchParams;
  // Your lenses on this collection with their runs: ?method=L<id> picks one that exists, and an unknown or deleted one falls back like an unknown method.
  const runs = await runsOf(c.id);
  const own = ownLenses(runs);
  const method = lensKeyOf(sp.method, own);
  // Compare is a tab, not a lens: lensKeyOf reads it as the default lens, which the panel then does not list.
  const comparing = sp.method === 'compare';
  const yours = Object.hasOwn(own, method) ? runs.find((r) => r.lens.key === method)! : null;
  // The reader's zone, detected in the browser: the history is bucketed by their calendar. UTC until it is known.
  const zone = await readerZone();
  const base = `/c/${chainId}/${address}`;
  const tv = listView('tokens', { page: sp.tp, sort: sp.ts, find: sp.tq });
  const wv = listView('wallets', { page: sp.wp, sort: sp.ws, find: sp.wq });
  // Only a lens that ran is listed: when funding did not, the money lenses hold Round trips' flags, copied. Yours join once they have
  // figures, and are read only through the block their run read.
  const ctx = await tradeContextOf(c);
  const listed = !comparing && ctx.ran.includes(method);
  // The over-time chart draws at most three of yours (the chosen one first); the timeline counts just those.
  const chart = chartLenses(runs, method);
  // With a Find, each list is also counted without it, for "2 of 644": a limit of 0 reads the count alone.
  const [history, timeline, tokens, wallets, tokensOf, walletsOf, passes, all, sources, settings, grid] = await Promise.all([
    s.history(c.id), c.latest ? s.timeline(c.id, zone, chart.drawn.map((o) => ({ lensId: o.lens.id, through: o.run!.throughBlock }))) : null,
    listed ? clampedPage(tv.page, TOP, (offset) => s.lensTokens(c.id, method, { sort: tv.sort as TokenSort, find: tv.find, limit: TOP, offset }, ctx)) : null,
    listed ? clampedPage(wv.page, TOP, (offset) => s.lensWallets(c.id, method, { sort: wv.sort as WalletSort, find: wv.find, limit: TOP, offset }, ctx)) : null,
    listed && tv.find !== null ? s.lensTokens(c.id, method, { sort: 'caught', find: null, limit: 0, offset: 0 }, ctx) : null,
    listed && wv.find !== null ? s.lensWallets(c.id, method, { sort: 'caught', find: null, limit: 0, offset: 0 }, ctx) : null,
    s.passes(), s.collections(), s.sources(), s.settings(),
    comparing ? s.compare(c.id, ctx) : null,
  ]);
  // The list's own count, never the analysis totals: those also count a token or wallet whose every flagged trade is uncounted.
  const tokenCount = tokensOf?.total ?? tokens?.total ?? 0;
  const walletCount = walletsOf?.total ?? wallets?.total ?? 0;
  const writable = mayWrite(process.env, await headers());
  const editing = writable ? editorStart(sp.lens, runs.map((r) => r.lens)) : null;
  // This page with one list's page, order or Find changed, the other kept, back at the lens panel.
  const here = (over: Partial<{ tp: number; ts: string; tq: string | null; wp: number; ws: string; wq: string | null }>) => {
    const v = { tp: tokens?.page ?? 1, ts: tv.sort, tq: tv.find, wp: wallets?.page ?? 1, ws: wv.sort, wq: wv.find, ...over };
    const pairs: [string, string | null][] = [
      ['method', method], ['ts', v.ts === 'caught' ? null : v.ts], ['tq', v.tq], ['tp', v.tp > 1 ? String(v.tp) : null],
      ['ws', v.ws === 'caught' ? null : v.ws], ['wq', v.wq], ['wp', v.wp > 1 ? String(v.wp) : null],
    ];
    return `${base}/methods?${pairs.filter(([, x]) => x !== null).map(([k, x]) => `${k}=${encodeURIComponent(x!)}`).join('&')}#evidence`;
  };
  const flagged = (kind: 'tokens' | 'wallets', view: { sort: string; find: string | null }) => listHref(base, kind, { method, sort: view.sort, q: view.find });
  // The Tokens or Wallets list this panel's rows are the head of, as an item's `from`: its page holds this panel's ten, which never straddle two.
  const fromList = (kind: 'tokens' | 'wallets', view: { sort: string; find: string | null }, page: number) =>
    fromParam(kind, new URL(flagged(kind, view), 'http://x.invalid').searchParams, Math.floor(((page - 1) * TOP) / LIST_PAGE) + 1);
  const a = c.latest;
  const rules = rulesNote(c.rules);
  // The chains the worker can read: with none for this one, its stored data is all there is.
  // The manifest entry: how many traders the loaded money trail checked (when it is the one loaded), and how big the trail is while it downloads.
  const entry = await storedEntry(chainId, address);
  const trail = entry?.trail && entry.trail.sha256 === c.trailImportedSha ? { checked: entry.trail.checked, of: entry.trail.of } : null;
  // What the worker gives the next analysis: a key, or this collection's own trail with checked wallets (Worker.analyze).
  // A trail with checked wallets not loaded yet: stage 5 and the lens cards wait for it rather than saying they need a key.
  const coming = trailComing(c, entry);
  const { config, rpcChains, silent, stages, why } = collectionStatus(c, { passes, all, sources, settings, entry, zone });
  const cov = coverage(c, rpcChains, Date.now(), zone, config.funding, silent !== null);
  const { funded, needs, qualifier, moneyReasons, tokens: tokensFloor, chartOwn, chartLeft, chartNotRun } = await collectionView(s, c, runs, { config, cov, editing, watched: all.length, yours, chart });
  const lens = lensInfo(method, own)!;
  // The chosen lens's figures: the latest analysis's for a built-in, its last finished run's for yours (a lens being run again keeps showing them).
  const t: MethodTotals | null | undefined = yours ? yours.run?.totals : a?.totals[method as Method];

  return (
    <>
      <Head
        title="Methods and numbers"
        sub={<>What <Link href={base} className="hover:text-foreground hover:underline">the overview</Link>&rsquo;s range is made of: each lens, how its share moved, and how far the reading has got.</>}
      >
        <Refresh />
      </Head>

      {silent ? <Silent silent={silent} /> : null}

      <div className="mb-4"><ReadingSummary c={c} cov={cov} href="#reading" stages={stages} /></div>

      {a === null && runs.length === 0 ? <Empty>{why}</Empty> : null}

      {a || runs.length > 0 ? (
        <Section id="evidence" title="How was it found?" lead={a ? evidenceLead(a.totals) : 'Your lenses run on this collection once its first analysis is in.'}>
          {/* These are the rules now set, which the latest analysis may not have run under yet. */}
          {rules ? <p className="mb-4 text-sm text-muted-foreground">{rules}</p> : null}
          <LensTabs
            base={base} chainId={chainId} address={address} selected={comparing ? 'compare' : method} totals={a?.totals ?? null} latestId={a?.id ?? null} paused={c.pausedAt !== null} runs={runs} notFinal={cov.notFinal} moneyReasons={moneyReasons} tokens={tokensFloor}
            coverage={{ trail: c.trailImportedSha !== null, funded, funding: config.funding, coming, silent: silent !== null }} writable={writable}
            // A new lens or a copy lights + New lens; an edit stays under the lens it changes.
            drafting={Boolean(editing && needs) && editing?.lensId === undefined}
            editor={editing && needs ? <LensEditor key={sp.lens} base={base} chainId={chainId} address={address} selected={comparing ? 'compare' : method} writable notFinal={cov.notFinal} funded={funded} needs={needs} {...editing}
              others={all.filter((o) => o.id !== c.id).map((o) => ({ chainId: o.chainId, address: o.address, name: o.name ?? short(o.address) }))} /> : null}
          >
            {comparing ? <Compare base={base} both={grid?.both ?? {}} not={grid?.not ?? {}} keys={ctx.ran} own={own} left={leftOut(a, runs, ctx.ran, { trail: c.trailImportedSha !== null, funded, coming, silent: silent !== null })} /> : null}
            {t && !comparing ? <LensStats m={method} t={t} own={own} loops={!yours && a?.loops && ctx.ran.includes(method) ? a.loops[method as Method] : null} base={base}
              qualifier={yours ? qualifier : shareQualifier(builtinCauses(method as Method, cov.notFinal, funded, config.funding))} /> : null}
            {a && !comparing ? (
              <p className="mb-4 text-sm text-muted-foreground">
                {t?.available
                  ? <>What <span className="font-medium text-foreground">{lens.name}</span> flags most: {yours ? `${qualifier === 'at least' ? 'at least ' : 'its '}${pctTenth(t.flaggedSales, t.sales)}` : `its ${pct(t.flaggedSales, t.sales)}`} of sales{yours && qualifier === 'so far' ? ' so far' : ''}, token by token and wallet by wallet. Open a token to see why each trade was flagged.</>
                  : <><span className="font-medium text-foreground">{lens.name}</span> {yours ? runStateWords(yours.run)?.full : NOT_RUN_LATEST} Choose another lens above.</>}
              </p>
            ) : null}
            {tokens && wallets ? (
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <LensList
                    kind="tokens" method={method} own={own} base={base} chainId={chainId} rows={tokens.rows} total={tokens.total} of={tokenCount} flaggedWei={t?.flaggedVolumeWei ?? null}
                    sort={tv.sort} sortHref={(ts) => here({ ts, tp: 1 })} find={tv.find} findParam="tq"
                    pager={{ page: tokens.page, size: TOP, href: (tp) => here({ tp }), param: 'tp' }} empty={`${lens.name} flags no token.`}
                    from={fromList('tokens', tv, tokens.page)}
                  />
                  <MoreLink href={flagged('tokens', tv)} className="mt-2">All {plural(tokenCount, 'token')} ›</MoreLink>
                </div>
                <div>
                  <LensList
                    kind="wallets" method={method} own={own} base={base} chainId={chainId} rows={wallets.rows} total={wallets.total} of={walletCount} flaggedWei={t?.flaggedVolumeWei ?? null}
                    sort={wv.sort} sortHref={(ws) => here({ ws, wp: 1 })} find={wv.find} findParam="wq"
                    pager={{ page: wallets.page, size: TOP, href: (wp) => here({ wp }), param: 'wp' }} empty={`${lens.name} flags no wallet.`}
                    from={fromList('wallets', wv, wallets.page)}
                  />
                  <MoreLink href={flagged('wallets', wv)} className="mt-2">All {plural(walletCount, 'wallet')} ›</MoreLink>
                </div>
              </div>
            ) : null}
          </LensTabs>
        </Section>
      ) : null}

      {a && timeline && timeline.points.length > 0 ? (
        <Section
          title="When did it happen?"
          lead={<>{timeline.points.length === 1
            // One period draws no chart (History says it in words), so the lead names no bar and no shaded stretch.
            ? <>Every trade so far falls in one {timeline.bucket}, so each lens&rsquo;s share of its sales is said in words. The period opens its trades; the list leaves out mints and custody moves.</>
            : <>Each lens&rsquo;s share of the sales in each {timeline.bucket}, across the collection&rsquo;s life from its first trade{unread(cov) ? '. The shaded stretch is history the worker has not read yet' : ''}. A period opens its trades; the list leaves out mints and custody moves, so it can be a little shorter than the bar.</>}
            {timeline.untimed > 0 ? ` ${plural(timeline.untimed, 'transfer')} without a block time are left out.` : ''}</>}
        >
          <History timeline={{ ...timeline, readThrough: unread(cov) ? timeline.readThrough : null }} totals={a.totals} notFinal={cov.notFinal} funded={funded} funding={config.funding} now={Date.now()} zone={zone} base={base}
            own={chartOwn} ownLeft={chartLeft} ownNotRun={chartNotRun} />
        </Section>
      ) : null}

      <Section id="reading" title="How far has it read?" lead="The six reading stages under every number on this page; the worker's jobs do the work, these say how far this collection has got. Stages 4 and 5 run side by side, and a money trail can still be loading after stage 3.">
        <Pipeline c={c} stages={stages} cov={cov} why={why} rpcChains={rpcChains} funding={config.funding} funded={funded} trail={trail} trailBytes={entry?.trail?.bytes ?? null} transfersBytes={entry?.transfers.bytes ?? null} trailComing={coming} now={Date.now()} />
        {history.length > 1 ? (
          <details className="group mt-3">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">How the answer settled as the reading filled in, at each of {history.length} analyses</summary>
            <div className="mt-2"><Trend history={history} zone={zone} /></div>
          </details>
        ) : null}
      </Section>
    </>
  );
}
