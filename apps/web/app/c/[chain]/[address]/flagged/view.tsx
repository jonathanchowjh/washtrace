import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { moneyFor, type TokenLine, type TokenSort, type TradeGroup, type TradeRow, type WalletLine, type WalletSort } from '@washtrace/detect';
import { NO_FILTER, isOwnKey, type LensKey, type TradeContext, type TradeGroupBy, type TradeQuery } from '@washtrace/detect/trades';
import { Empty, Head } from '@/components/ui';
import { LensList } from '@/components/lens-lists';
import { LensName } from '@/components/methods';
import { TierMark } from '@/components/kit';
import { Pager } from '@/components/pager';
import { FilterBar, GroupBy, TradesTable } from '@/components/trades';
import { lensKeyOf, readerZone } from '@/lib/api';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { LENSES, NOT_JUDGED_YET, lensInfo, notRunAll, notRunHere, plural, short, num } from '@/lib/format';
import { behindLine, behindOf } from '@/lib/lens-state';
import { listHref } from '@/lib/links';
import { lensContext, ownLenses, SHOWN } from '@/lib/metrics';
import { addressOf, chainOf, pages } from '@/lib/params';
import { store } from '@/lib/store';
import { TRADES_PAGE, holdsNothing, parseView, tradesHref } from '@/lib/trades-url';
import { cn } from '@/lib/utils';
import { listView } from '@/lib/params';
import { LIST_PAGE, clampedPage } from '@/lib/views';
import { fromParam } from '@/lib/step';


type Kind = 'tokens' | 'wallets' | 'trades';
type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const WORD = { tokens: 'Tokens', wallets: 'Wallets', trades: 'Trades' } as const;

/** Each lens's standing in plain words, said after its name wherever the page names it. */
const TIER = { cycle: LENSES.A.tier, money: LENSES.AC.tier, apart: LENSES.AU.tier, own: 'your lens' } as const;

/** The lens a list opens on, whose count its tab shows: the title names a lens only when it is another. */
const OPENS_ON = lensKeyOf(null, {});

/** The tab title as every page under a collection writes it, "<Page> · <Collection>", with a chosen lens between. */
function titleOf(kind: Kind, name: string, method: LensKey, lens: string): string {
  return kind === 'trades' || method === OPENS_ON ? `${WORD[kind]} · ${name}` : `${WORD[kind]} · ${lens} · ${name}`;
}

/** The kind and lens the URL asks for, as the page reads them. */
export function askedOf(q: Record<string, string | string[] | undefined>) {
  const one = (k: string) => { const v = q[k]; return Array.isArray(v) ? v[0] : v; };
  const kind = one('kind') === 'wallets' ? 'wallets' : one('kind') === 'trades' ? 'trades' : 'tokens';
  return { one, kind } as const;
}

/** The tab title of a page showing `kind`. */
export async function metadataOf(kind: Kind, { params, searchParams }: Props): Promise<Metadata> {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  const c = chainId === null || address === null ? null : await collectionOf(chainId, address);
  if (!c) return { title: WORD[kind] };
  const { one } = askedOf(await searchParams);
  const own = ownLenses(await runsOf(c.id));
  const method = lensKeyOf(one('method'), own);
  return { title: titleOf(kind, c.name ?? short(c.address), method, lensInfo(method, own)!.name) };
}

/**
 * Every token or wallet one lens flags, a page at a time: the collection
 * page's top ten, continued; or, as kind trades, the collection's trades
 * under any filters. Lens, kind and filters stay in the URL, so a page can be
 * shared and the way back keeps the same lens.
 */
export async function FlaggedView({ kind, params, searchParams }: Props & { kind: Kind }) {
  await connection();
  const p = await params;
  const q = await searchParams;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const s = store();
  const c = await collectionOf(chainId, address);
  if (!c) notFound();
  const { one } = askedOf(q);
  // The reader's zone, detected in the browser: months and dates are read in their calendar. UTC until it is known.
  const zone = await readerZone();
  // The lenses of yours that exist and the ones that ran: a key outside the first is dropped like junk, one outside the second holds nothing.
  const runs = await runsOf(c.id);
  const own = ownLenses(runs);
  // Your lenses are read only through the block their run read.
  const lenses = lensContext(c.latest, runs);
  const { ran } = lenses;
  const { q: asked, view } = parseView(q, zone, new Set(Object.keys(own)));
  // A sort on a lens that did not run has nothing to sort by: it falls back to the default order, and says nothing.
  const unrunSort = asked.sort.startsWith('lens-') && !ran.includes(asked.sort.slice(5) as LensKey);
  const query: TradeQuery = unrunSort ? { ...asked, sort: NO_FILTER.sort, dir: NO_FILTER.dir } : asked;
  // On Trades the Tokens and Wallets tabs keep the first lens the list is filtered to.
  const method: LensKey = kind === 'trades' ? (SHOWN.find((m) => query.caught.includes(m)) ?? query.caught[0] ?? lensKeyOf(one('method'), own)) : lensKeyOf(one('method'), own);
  const list = kind === 'trades' ? 'tokens' : kind;
  // On Trades, sort, q and page are the Trades list's own, so the lists' are their defaults.
  const lv = listView(list, kind === 'trades' ? {} : { page: one('page'), sort: one('sort'), find: one('q') });
  const base = `/c/${chainId}/${address}`;
  const lens = lensInfo(method, own)!;
  // Only a lens that ran is listed: when funding did not, the money lenses hold Round trips' flags, copied.
  const ctx = { money: moneyFor(chainId), zone, ...lenses };
  const read = (o: { sort: string; find: string | null; limit: number; offset: number }) =>
    list === 'tokens' ? s.lensTokens(c.id, method, { ...o, sort: o.sort as TokenSort }, ctx) : s.lensWallets(c.id, method, { ...o, sort: o.sort as WalletSort }, ctx);
  const listed = kind !== 'trades' && ctx.ran.includes(method);
  // With a Find the list is also counted without it, for "2 of 644": a limit of 0 reads the count alone.
  const [rows, unfound] = await Promise.all([
    listed ? clampedPage<TokenLine | WalletLine>(lv.page, LIST_PAGE, (offset) => read({ sort: lv.sort, find: lv.find, limit: LIST_PAGE, offset })) : null,
    listed && lv.find !== null ? read({ sort: 'caught', find: null, limit: 0, offset: 0 }) : null,
  ]);
  // The list's own count, never the analysis totals: those also count a token or wallet whose every flagged trade is uncounted.
  const of = unfound?.total ?? rows?.total ?? 0;
  /** This list with its lens, order, Find or page changed; another lens keeps the order and Find. */
  const href = (over: { method?: string; page?: number; sort?: string }) =>
    listHref(base, list, { method: over.method ?? method, sort: over.sort ?? lv.sort, q: lv.find, page: over.page });

  const trades = kind === 'trades' ? await tradesOf(s, c, query, view.by, view.page, ctx) : null;
  // The lenses of yours in view whose figures are behind, said above the list: every one Trades draws a column for, or the list's own.
  const inView = runs.filter((r) => (kind === 'trades' ? ran.includes(r.lens.key) : r.lens.key === method));
  const behind = behindLine(inView.flatMap((r) => { const b = behindOf(r.run, r.lens, c.latest); return b === null ? [] : [{ name: r.lens.name, behind: b }]; }));

  // A built-in's sentence is about the latest analysis once there is one; one of yours says it in the words its panel uses.
  const notRun = (m: LensKey) => (isOwnKey(m) ? notRunHere(lensInfo(m, own)!.name) : notRunAll([m], c.latest !== null));
  const skipped = trades === null ? '' : query.notCaught.filter((m) => !(trades.ran as readonly string[]).includes(m)).map((m) => ` ${notRun(m)} It is left out of "not flagged by".`).join('');
  const csv = `/api/collections/${chainId}/${address}/trades?format=csv${tradesHref(base, query).slice(`${base}/trades`.length).replace('?', '&')}`;
  const lensHref = (m: LensKey) => kind === 'trades' ? tradesHref(base, { ...query, caught: [m] }, { by: view.by }) : href({ method: m });
  const lensOn = (m: LensKey) => kind === 'trades' ? query.caught.length === 1 && query.caught[0] === m : m === method;

  return (
    <>
      {/* The tab bar names the collection, so the heading names the list; the count is said once, by the pager under it. */}
      <Head
        title={kind === 'trades' ? WORD.trades : `${WORD[kind]} flagged by ${lens.name}`}
        part={kind === 'trades' ? undefined : <span className="chip font-medium"><TierMark tone={lens.tone} />{lens.name} · {TIER[lens.tone]}</span>}
        sub={kind === 'trades'
          ? `${query.kind === 'all' ? 'Every change of owner' : 'Every sale'}, filtered by what you ask: a lens, a marketplace, a price, a wallet. Open a date to see the trade itself.`
          : `Each count opens the trades it counts. ${kind === 'tokens' ? 'Open a token to see why each trade was flagged.' : 'Open a wallet to see its trades and who it moved money with.'}`}
      />

      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Lens" className="flex flex-wrap gap-1.5">
          {[...SHOWN, ...Object.keys(own) as LensKey[]].map((m) => (
            <Link key={m} href={lensHref(m)} prefetch={false} aria-current={lensOn(m) ? 'page' : undefined}
              className={cn('rounded-md border px-2.5 py-1 text-sm', lensOn(m) ? 'bg-card ring-1 ring-foreground' : 'bg-muted/50 hover:bg-card')}>
              <LensName m={m} own={own} /><span className="text-muted-foreground"> · {TIER[lensInfo(m, own)?.tone ?? 'own']}</span>
            </Link>
          ))}
        </nav>
      </div>

      {behind ? <p className="mt-4 max-w-3xl text-sm text-muted-foreground">{behind}</p> : null}

      {trades ? (
        <>
          <FilterBar base={base} q={query} view={view} zone={zone} own={own} />
          {trades.state === 'absent' ? (
            <div className="mt-4 max-w-3xl space-y-2">
              {trades.absent.map((m) => <Empty key={m}>{notRun(m)}</Empty>)}
            </div>
          ) : trades.state === 'unreadable' ? (
            <div className="mt-4 max-w-3xl"><Empty>“{query.find}” is not a token number, wallet address or transaction hash.</Empty></div>
          ) : (
            <>
              {trades.total === 0 ? (
                <div className="mt-4 max-w-3xl space-y-2">
                  <Empty>No trade matches these filters.</Empty>
                  {skipped ? <p className="text-sm text-muted-foreground">{skipped.trim()}</p> : null}
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">
                  {plural(trades.total, 'trade')} match{trades.total === 1 ? 'es' : ''} · everything is in the address bar, so this view can be shared.
                  {trades.unjudged > 0 ? ` ${unjudged(c.latest, trades.unjudged)}` : ''}
                  {skipped}
                </p>
              )}
              <GroupBy base={base} q={query} view={view} zone={zone} own={own} groups={trades.groups} ran={trades.ran} />
              {trades.total === 0 ? null : (
                <>
                  <TradesTable base={base} q={query} view={view} zone={zone} own={own} chainId={chainId} rows={trades.rows} ran={trades.ran} through={ctx.through} money={trades.money}
                    from={fromParam('trades', new URL(tradesHref(base, query, { by: view.by }), 'http://x.invalid').searchParams, trades.page)} />
                  <Pager total={trades.total} page={trades.page} size={TRADES_PAGE} href={(n) => tradesHref(base, query, { by: view.by, page: n })} label="trades" />
                  <p className="mt-3 text-sm"><a href={csv} className="font-medium hover:underline">Download CSV ↓</a></p>
                </>
              )}
            </>
          )}
        </>
      ) : (
        // As wide as the tab bar over it, like every other page's list; only a sentence keeps to a reading width.
        <div className="mt-4">
          {rows === null ? (
            <div className="max-w-3xl"><Empty>{notRun(method)}</Empty></div>
          ) : (
            <LensList
              kind={list} method={method} own={own} base={base} chainId={chainId} rows={rows.rows as TokenLine[] | WalletLine[]} total={rows.total} of={of}
              sort={lv.sort} sortHref={(sort) => href({ sort })} find={lv.find} findParam="q"
              pager={{ page: rows.page, size: LIST_PAGE, href: (n) => href({ page: n }) }} empty={`${lens.name} flags no ${list === 'tokens' ? 'token' : 'wallet'}.`}
              from={fromParam(list, new URL(href({}), 'http://x.invalid').searchParams, rows.page)}
            />
          )}
        </div>
      )}
    </>
  );
}

type Store = ReturnType<typeof store>;
type Coll = NonNullable<Awaited<ReturnType<Store['collection']>>>;

/**
 * Why some matching trades are not judged: newer than the latest analysis,
 * or every one of them when there is none, or when it predates trade facts
 * (no loops counted) and the migration that queues such collections has run.
 */
function unjudged(latest: Coll['latest'], n: number): string {
  if (latest === null) return `${NOT_JUDGED_YET}.`;
  if (latest.loops === null) return 'The latest analysis predates these figures; this collection is queued to be analyzed again.';
  return `${num(n)} of them are newer than the latest analysis and not judged yet.`;
}

/**
 * What the Trades view needs from the store. Only the lenses that ran are read.
 * A filter on one that did not, or a Find the store cannot read, reads nothing:
 * the page says why instead. A page past the last is clamped before the offset
 * is computed, so it shows the last page's rows.
 */
async function tradesOf(s: Store, c: Coll, query: TradeQuery, by: TradeGroupBy | null, asked: number, ctx: TradeContext) {
  const { ran } = ctx;
  const nothing = holdsNothing(query, ran);
  const none = { ran, money: ctx.money, absent: nothing?.state === 'absent' ? nothing.absent : [], total: 0, unjudged: 0, page: 1, rows: [] as TradeRow[], groups: null as TradeGroup[] | null };
  if (nothing !== null) return { ...none, state: nothing.state };
  const { total, unjudged } = await s.tradeCount(c.id, query, ctx);
  const page = Math.min(pages(total, TRADES_PAGE), asked);
  const [rows, groups] = await Promise.all([s.trades(c.id, query, ctx, TRADES_PAGE, (page - 1) * TRADES_PAGE), by !== null && total > 0 ? s.tradeGroups(c.id, query, by, ctx) : null]);
  return { ...none, state: 'ok' as const, total, unjudged, page, rows, groups };
}
