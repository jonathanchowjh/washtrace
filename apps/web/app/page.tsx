import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { connection } from 'next/server';
import Link from 'next/link';
import { messageOf, type CollectionRow as Collection } from '@washtrace/detect';
import { Empty, Head, Problem, Silent } from '@/components/head';
import { HowWeLook } from '@/components/methods';
import { CollectionRow, COLS } from '@/components/collection-row';
import { Refresh } from '@/components/refresh';
import { CollectionTabs, type Tab } from '@/components/tabs';
import { AddCollection, Suggested, WatchPanel } from '@/components/watch';
import { LOCAL_ONLY, mayWrite } from '@/lib/auth';
import { ConfigError } from '@/lib/config';
import { short, storedSizes } from '@/lib/format';
import { homeHref } from '@/lib/links';
import { range, tabCounts, waiting } from '@/lib/metrics';
import { configFromSources } from '@/lib/settings';
import { workerSilent } from '@/lib/status';
import { store, storedManifest } from '@/lib/store';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';

export const metadata: Metadata = { title: 'Collections' };


/** The four store reads, and whether this request may write, in one go, or why they failed: the page shows the failure as a Problem. */
async function load() {
  try {
    const s = store();
    const [rows, passes, sources, settings, head] = await Promise.all([s.collections(), s.passes(), s.sources(), s.settings(), headers()]);
    // The chains the worker reports it can read, and a console RPC saved since: a collection on none shows its stored data only.
    const config = configFromSources(sources, settings);
    // Whether a key is set, as the status report reads it: without one no wallet is being checked.
    return { ok: true as const, rows, passes, analyze: passes.find((p) => p.job === 'analyze'), rpcChains: new Set(config.chains) as ReadonlySet<number>, funding: config.funding, writable: mayWrite(process.env, head) };
  } catch (err) {
    return { ok: false as const, err };
  }
}

const SORTS = ['washed', 'volume', 'sales', 'name', 'analysed'] as const;
type Sort = (typeof SORTS)[number];
type Dir = 'asc' | 'desc';

/** What each sort link says, and what the column it sits on is for. */
const SORT_LABEL: Record<Sort, string> = { washed: 'washed', volume: 'volume', sales: 'sales', name: 'name', analysed: 'last analysed' };

/** Names read A to Z first; every measure reads biggest, or latest, first. */
function defaultDir(sort: Sort): Dir {
  return sort === 'name' ? 'asc' : 'desc';
}

/** A row's value to sort on, or null when it has none: a row with no analysis, or no sale to take a share of. */
function sortKey(c: Collection, sort: Sort): string | number | bigint | null {
  const a = c.latest;
  if (sort === 'name') return (c.name ?? c.address).toLowerCase();
  if (a === null) return null;
  if (sort === 'sales') return a.totals.A.sales;
  if (sort === 'analysed') return a.ranAt;
  if (sort === 'washed') return range(a.totals, 'sales')?.highShare ?? null;
  const r = range(a.totals, 'volume');
  return r && BigInt(a.totals[r.high].flaggedVolumeWei);
}

/** The rows in the asked order. A row with no value goes last either way; ties keep the list's order. */
function sorted(rows: Collection[], sort: Sort | null, dir: Dir): Collection[] {
  if (sort === null) return rows;
  const keyed = rows.map((c) => ({ c, k: sortKey(c, sort) }));
  const sign = dir === 'asc' ? 1 : -1;
  keyed.sort((x, y) => {
    if (x.k === null || y.k === null) return x.k === y.k ? 0 : x.k === null ? 1 : -1;
    return x.k < y.k ? -sign : x.k > y.k ? sign : 0;
  });
  return keyed.map((x) => x.c);
}

type View = { tab?: string; find?: string; sort?: string; dir?: string };

/** The link to sort by one measure; on the sort already chosen it flips the direction, and shows which way it runs. */
function SortLink({ to, view, sort, dir, children }: { to: Sort; view: View; sort: Sort | null; dir: Dir; children: React.ReactNode }) {
  const current = sort === to;
  const next = current ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir(to);
  const href = homeHref({ ...view, sort: to, dir: next === defaultDir(to) ? undefined : next });
  return (
    <Link href={href} aria-current={current ? 'true' : undefined} className={`hover:text-foreground hover:underline ${current ? 'font-medium text-foreground' : ''}`}>
      {children}{current ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </Link>
  );
}

/**
 * Find narrows the list to the collections whose name or address holds the
 * text; the sort links order it. The form shows only Find, so the tab and
 * sort ride along as hidden inputs.
 */
function FindAndSort({ view, sort, dir, find, matched, of }: { view: View; sort: Sort | null; dir: Dir; find: string; matched: number; of: number }) {
  return (
    <div className="mt-4 space-y-2">
      <form method="get" action="/" role="search" className="flex flex-wrap items-center gap-2">
        {view.tab ? <input type="hidden" name="tab" value={view.tab} /> : null}
        {view.sort ? <input type="hidden" name="sort" value={view.sort} /> : null}
        {view.dir ? <input type="hidden" name="dir" value={view.dir} /> : null}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Find
          <input
            type="search" name="find" defaultValue={find} placeholder="name or address"
            className="w-56 rounded-[5px] border bg-card px-2 py-1 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          />
        </label>
        <button type="submit" className="rounded-md border bg-card px-3 py-1 text-sm font-medium text-foreground hover:bg-muted">Find</button>
      </form>
      {find ? (
        <p className="text-xs text-muted-foreground">{matched} of {of} collections in this tab match “{find}” · <Link href={homeHref({ ...view, find: undefined })} className="underline hover:text-foreground">Clear</Link></p>
      ) : null}
      {/* Also on the column headers on a wide screen; here at every width. */}
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        Sort:
        {SORTS.map((s, i) => (
          <span key={s}>{i > 0 ? <span aria-hidden className="mr-1.5">·</span> : null}<SortLink to={s} view={view} sort={sort} dir={dir}>{SORT_LABEL[s]}</SortLink></span>
        ))}
      </p>
    </div>
  );
}

/**
 * Every watched collection with its answer: how much of its trading looks
 * like wash trading, as a range from Round trips to Linked wallets, and how far the
 * reading under that answer has got. The paper's Table 3, kept current.
 */
export default async function Collections({ searchParams }: { searchParams: Promise<{ tab?: string; find?: string; sort?: string; dir?: string }> }) {
  await connection();
  const q = await searchParams;
  const asked = q.tab;
  const tab: Tab = asked === 'paused' || asked === 'all' ? asked : 'sync';
  // Junk in the URL is dropped: an unknown sort keeps the list's order, and a direction is asc or desc.
  const find = typeof q.find === 'string' ? q.find.trim() : '';
  const sort = SORTS.find((s) => s === q.sort) ?? null;
  const askedDir: Dir | undefined = q.dir === 'asc' || q.dir === 'desc' ? q.dir : undefined;
  const dir = askedDir ?? (sort ? defaultDir(sort) : 'desc');
  // Only a tab the URL named is carried, so a visit with none can still open on the remembered one.
  const view = { tab: asked === 'paused' || asked === 'all' || asked === 'sync' ? asked : undefined, find: find || undefined, sort: sort ?? undefined, dir: sort ? askedDir : undefined };
  const read = await load();
  if (!read.ok) {
    return (
      <>
        <Head title="Collections" />
        <Problem title={read.err instanceof ConfigError ? 'washtrace is not configured' : 'The store did not answer'}>{messageOf(read.err)}</Problem>
      </>
    );
  }
  const { rows, passes, analyze, rpcChains, funding, writable } = read;
  // What the worker last fetched from the Hub; null until it has, which the list says.
  const stored = storedSizes(await storedManifest());
  const counts = tabCounts(rows, rpcChains);
  const inTab = tab === 'all' ? rows : rows.filter((c) => (c.pausedAt !== null) === (tab === 'paused'));
  // Collections are few, so Find reads the rows already loaded.
  const needle = find.toLowerCase();
  const found = needle ? inTab.filter((c) => [c.name ?? '', c.address].some((t) => t.toLowerCase().includes(needle))) : inTab;
  const shown = sorted(found, sort, dir);
  const names = new Map(rows.map((c) => [c.id, c.name ?? short(c.address)]));
  const now = Date.now();
  const silent = workerSilent(passes, now);
  // The reader's zone, for when a failed analysis is tried again. UTC until it is known.
  const zone = parseZone((await cookies()).get(ZONE_COOKIE)?.value)?.zone ?? 'UTC';
  return (
    <>
      <Head title="Collections" sub="Each NFT collection being watched, and how much of its trading looks like wash trading.">
        <Refresh />
      </Head>

      <HowWeLook open={rows.length === 0} />

      {/* Said once, for the Watch panel and every row's controls alike: each control only carries it as its title. Pulled close to the panel's button, under the panel's own top margin. */}
      {writable ? null : <p className="mt-6 -mb-4 text-xs text-muted-foreground">{LOCAL_ONLY}</p>}

      <WatchPanel startOpen={rows.length === 0}>
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="text-muted-foreground group-open:rotate-45 transition-transform">+</span> Watch a collection
        </summary>
        <div className="mt-2 space-y-5 rounded-lg border bg-card p-4">
          <Suggested writable={writable} watched={rows.map((c) => `${c.chainId}/${c.address}`)} stored={stored} />
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Or any collection, by its contract address.</p>
            <AddCollection writable={writable} stored={stored} />
          </div>
        </div>
      </WatchPanel>

      {silent ? <div className="mt-4"><Silent silent={silent} /></div> : null}

      {rows.length > 0 ? <CollectionTabs counts={counts} current={tab} find={view.find} sort={view.sort} dir={view.dir} /> : null}

      {rows.length > 0 && inTab.length > 0 ? <FindAndSort view={view} sort={sort} dir={dir} find={find} matched={found.length} of={inTab.length} /> : null}

      {rows.length === 0 ? (
        <div className="mt-4"><Empty>No collection is watched yet. Add one above, or <code className="font-mono text-xs">POST /api/collections</code>. The worker reads every transfer since it was deployed, then checks who funded the wallets that traded it.</Empty></div>
      ) : inTab.length === 0 ? (
        <div className="mt-4"><Empty>{tab === 'paused' ? 'Nothing is paused. Press Pause on a collection to stop the worker reading new blocks while keeping its data.' : 'Every collection is paused. Open the Paused tab and press Resume to have the worker read a collection again.'}</Empty></div>
      ) : shown.length === 0 ? (
        <div className="mt-4"><Empty>No collection in this tab matches “{find}”. Clear the search to see them all.</Empty></div>
      ) : (
        <div className="mt-4 rounded-lg border bg-card">
          <div className={`hidden gap-6 border-b px-4 py-2 text-xs text-muted-foreground md:grid ${COLS}`}>
            <SortLink to="name" view={view} sort={sort} dir={dir}>Collection</SortLink>
            <SortLink to="washed" view={view} sort={sort} dir={dir}>Sales that look washed</SortLink>
            <SortLink to="volume" view={view} sort={sort} dir={dir}>Volume that looks washed</SortLink>
            <SortLink to="analysed" view={view} sort={sort} dir={dir}>How complete</SortLink>
          </div>
          <ul className="divide-y">{shown.map((c) => <CollectionRow key={c.id} c={c} why={waiting(c, analyze, names, rpcChains, now, zone, silent !== null)} rpcChains={rpcChains} funding={funding} silent={silent !== null} writable={writable} now={now} />)}</ul>
        </div>
      )}
    </>
  );
}
