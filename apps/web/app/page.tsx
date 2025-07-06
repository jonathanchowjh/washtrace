import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { messageOf, type CollectionRow } from '@washtrace/detect';
import { ReadingPill } from '@/components/coverage';
import { Empty, Head, Problem, Warn } from '@/components/head';
import { HowWeLook, RangeBar } from '@/components/methods';
import { Refresh } from '@/components/refresh';
import { AddCollection, Suggested, WatchPanel } from '@/components/watch';
import { chainName } from '@/lib/chains';
import { ConfigError } from '@/lib/config';
import { LENSES, eth, ethRange, plural, short } from '@/lib/format';
import { coverage, range, rangeText, type Range } from '@/lib/metrics';
import { store } from '@/lib/store';
import { Time } from '@/components/time';

export const metadata: Metadata = { title: 'Collections' };

const COLS = 'md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(11.5rem,0.7fr)]';

/**
 * Every watched collection with its answer: how much of its trading looks
 * like wash trading, from the strictest lens to the widest, and how far the
 * reading under that answer has got. The paper's Table 3, kept current.
 */
export default async function Collections() {
  await connection();
  let rows: CollectionRow[];
  try {
    rows = await store().collections();
  } catch (err) {
    return (
      <>
        <Head title="Collections" />
        <Problem title={err instanceof ConfigError ? 'washtrace is not configured' : 'The store did not answer'}>{messageOf(err)}</Problem>
      </>
    );
  }
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

      {rows.length === 0 ? (
        <div className="mt-4"><Empty>No collection is watched yet. Add one above, or <code className="font-mono text-xs">POST /api/collections</code>. The worker reads every transfer since it was deployed, then checks who funded the wallets that traded it.</Empty></div>
      ) : (
        <div className="mt-4 rounded-lg border bg-card">
          <div className={`hidden gap-6 border-b px-4 py-2 text-xs text-muted-foreground md:grid ${COLS}`}>
            <span>Collection</span>
            <span>Sales that look washed</span>
            <span>Volume that looks washed</span>
            <span>How complete</span>
          </div>
          <ul className="divide-y">{rows.map((c) => <Row key={c.id} c={c} />)}</ul>
        </div>
      )}
    </>
  );
}

function Share({ r, label, detail }: { r: Range | null; label: string; detail: string }) {
  if (r === null) return <div className="text-sm text-muted-foreground">{detail}</div>;
  return (
    <div className="min-w-0">
      <p className="flex items-baseline gap-1.5">
        <span className="text-xl font-semibold text-foreground tabular-nums">{rangeText(r)}</span>
        <span className="text-xs text-muted-foreground md:hidden">{label}</span>
      </p>
      <RangeBar range={r} className="mt-1.5 max-w-56" />
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function Row({ c }: { c: CollectionRow }) {
  const a = c.latest;
  const cov = coverage(c);
  const sales = a && range(a.totals, 'sales');
  const volume = a && range(a.totals, 'volume');
  const href = `/c/${c.chainId}/${c.address}`;
  return (
    <li className={`relative grid gap-x-6 gap-y-3 px-4 py-4 hover:bg-muted/40 ${COLS}`}>
      <div className="min-w-0">
        {/* The whole row opens the collection; the name is the link a screen reader announces. */}
        <Link href={href} className="font-semibold text-foreground after:absolute after:inset-0 hover:underline">{c.name ?? short(c.address)}</Link>
        <p className="text-xs text-muted-foreground">{chainName(c.chainId)} · <span className="font-mono">{short(c.address)}</span></p>
        <p className="mt-1 text-xs text-muted-foreground">{a ? `${plural(a.totals.A.sales, 'sale')} among ${plural(c.transfers, 'transfer')}` : plural(c.transfers, 'transfer')}</p>
        {c.error ? <p className="mt-1 flex max-w-sm items-start gap-1 text-xs text-fault"><Warn className="size-3.5" />{c.error}</p> : null}
      </div>
      {a === null ? (
        <p className="text-sm text-muted-foreground md:col-span-2">Not analyzed yet. It runs once the first transfers are read.</p>
      ) : (
        <>
          <Share
            r={sales} label="of sales"
            detail={sales ? `${LENSES[sales.low].name} → ${LENSES[sales.high].name}` : 'No sale read yet'}
          />
          <Share
            r={volume} label="of volume"
            detail={volume ? `${ethRange(a.totals[volume.low].flaggedVolumeWei, a.totals[volume.high].flaggedVolumeWei)} of ${eth(a.totals.A.volumeWei)}` : 'No priced sale read yet'}
          />
        </>
      )}
      <div className="flex flex-col items-start gap-1">
        <ReadingPill cov={cov} />
        <p className="text-xs text-muted-foreground">{a === null ? '' : <>analyzed <Time ms={a.ranAt} /></>}</p>
        {cov.reading === 'checking' ? <p className="text-xs text-muted-foreground">money lenses can still rise</p> : null}
      </div>
    </li>
  );
}
