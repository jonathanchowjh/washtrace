import type { Metadata } from 'next';
import { connection } from 'next/server';
import { messageOf, type CollectionRow as Collection, type PassRow } from '@washtrace/detect';
import { Empty, Head, Problem } from '@/components/head';
import { HowWeLook } from '@/components/methods';
import { CollectionRow, COLS } from '@/components/collection-row';
import { Refresh } from '@/components/refresh';
import { CollectionTabs, type Tab } from '@/components/tabs';
import { AddCollection, Suggested, WatchPanel } from '@/components/watch';
import { ConfigError } from '@/lib/config';
import { short } from '@/lib/format';
import { tabCounts, waiting } from '@/lib/metrics';
import { configFromSources } from '@/lib/settings';
import { store } from '@/lib/store';

export const metadata: Metadata = { title: 'Collections' };


/**
 * Every watched collection with its answer: how much of its trading looks
 * like wash trading, from the strictest lens to the widest, and how far the
 * reading under that answer has got. The paper's Table 3, kept current.
 */
export default async function Collections({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await connection();
  const asked = (await searchParams).tab;
  const tab: Tab = asked === 'paused' || asked === 'all' ? asked : 'sync';
  let rows: Collection[];
  let analyze: PassRow | undefined;
  let rpcChains: ReadonlySet<number>;
  let funding: boolean;
  try {
    const s = store();
    const [all, passes, sources, settings] = await Promise.all([s.collections(), s.passes(), s.sources(), s.settings()]);
    rows = all;
    analyze = passes.find((p) => p.job === 'analyze');
    // The chains the worker reports it can read, and a console RPC saved since: a collection on none shows its stored data only.
    const config = configFromSources(sources, settings);
    rpcChains = new Set(config.chains);
    // Whether a key is set, as the status report reads it: without one no wallet is being checked.
    funding = config.funding;
  } catch (err) {
    return (
      <>
        <Head title="Collections" />
        <Problem title={err instanceof ConfigError ? 'washtrace is not configured' : 'The store did not answer'}>{messageOf(err)}</Problem>
      </>
    );
  }
  const counts = tabCounts(rows, rpcChains);
  const shown = tab === 'all' ? rows : rows.filter((c) => (c.pausedAt !== null) === (tab === 'paused'));
  const names = new Map(rows.map((c) => [c.id, c.name ?? short(c.address)]));
  const now = Date.now();
  return (
    <>
      <Head title="Collections" sub="Each NFT collection being watched, and how much of its trading looks like wash trading.">
        <Refresh />
      </Head>

      <HowWeLook open={rows.length === 0} />

      <WatchPanel startOpen={rows.length === 0}>
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="text-muted-foreground group-open:rotate-45 transition-transform">+</span> Watch a collection
        </summary>
        <div className="mt-2 space-y-5 rounded-lg border bg-card p-4">
          <Suggested watched={rows.map((c) => `${c.chainId}/${c.address}`)} />
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Or any collection, by its contract address.</p>
            <AddCollection />
          </div>
        </div>
      </WatchPanel>

      {rows.length > 0 ? <CollectionTabs counts={counts} current={tab} /> : null}

      {rows.length === 0 ? (
        <div className="mt-4"><Empty>No collection is watched yet. Add one above, or <code className="font-mono text-xs">POST /api/collections</code>. The worker reads every transfer since it was deployed, then checks who funded the wallets that traded it.</Empty></div>
      ) : shown.length === 0 ? (
        <div className="mt-4"><Empty>{tab === 'paused' ? 'Nothing is paused. Press Pause on a collection to stop the worker reading new blocks while keeping its data.' : 'Every collection is paused. Open the Paused tab and press Resume to have the worker read a collection again.'}</Empty></div>
      ) : (
        <div className="mt-4 rounded-lg border bg-card">
          <div className={`hidden gap-6 border-b px-4 py-2 text-xs text-muted-foreground md:grid ${COLS}`}>
            <span>Collection</span>
            <span>Sales that look washed</span>
            <span>Volume that looks washed</span>
            <span>How complete</span>
          </div>
          <ul className="divide-y">{shown.map((c) => <CollectionRow key={c.id} c={c} why={waiting(c, analyze, names, now)} rpcChains={rpcChains} funding={funding} now={now} />)}</ul>
        </div>
      )}
    </>
  );
}
