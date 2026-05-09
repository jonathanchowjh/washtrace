import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { messageOf } from '@washtrace/detect';
import { Head, Notices, Problem, Section, Warn } from '@/components/head';
import { Refresh } from '@/components/refresh';
import { chainName } from '@/lib/chains';
import { LENSES, eta, plural, short, withoutKey } from '@/lib/format';
import { FIELDS } from '@/lib/settings';
import type { JobState } from '@/lib/status';
import { workerView } from '@/lib/views';
import { cn } from '@/lib/utils';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';
import { Time } from '@/components/time';

export const metadata: Metadata = { title: 'Worker' };

/** What the worker uses for a number it has no value for, or one it ignores (env.ts, mirrored in FIELDS). */
const DEFAULT = {
  rps: Number(FIELDS.find((f) => f.key === 'etherscan.rps')!.fallback),
  hops: Number(FIELDS.find((f) => f.key === 'follow.hops')!.fallback),
};

/** The three jobs in the order data flows through them, each with what it feeds. */
const STEPS = {
  ingest: { title: 'Read transfers', does: 'Reads every finalized ERC-721 transfer of each collection, and the receipts that make some of them sales.', feeds: 'every lens' },
  fund: { title: 'Check wallets for money', does: 'Asks Etherscan who paid whom, for each wallet that traded, busiest first.', feeds: `${LENSES.AU.name} and ${LENSES.AC.name}` },
  analyze: { title: 'Run the lenses', does: 'Reruns all three lenses over each collection that has new data.', feeds: 'every number in the console' },
} as const;

const STATE: Record<JobState, { label: string; className: string }> = {
  ok: { label: 'OK', className: 'bg-ok/12 text-ok' },
  running: { label: 'Running', className: 'bg-focus/12 text-focus' },
  failed: { label: 'Failed', className: 'bg-fault/12 text-fault' },
  stalled: { label: 'Stalled', className: 'bg-fault/12 text-fault' },
  never: { label: 'Never run', className: 'bg-muted text-muted-foreground' },
};

/** The polling half, as the pipeline it is: what each step did last, what it feeds, and what needs a person. */
export default async function WorkerPage() {
  await connection();
  let v: Awaited<ReturnType<typeof workerView>>;
  try {
    // The reader's zone, for the dates in the notices.
    v = await workerView(parseZone((await cookies()).get(ZONE_COOKIE)?.value)?.zone);
  } catch (err) {
    return <><Head title="Worker" /><Problem title="The store did not answer">{messageOf(err)}</Problem></>;
  }
  // A pass that started and has not finished is running; its `doing` says what, and for which collection.
  const now = v.passes.filter((p) => (p.finishedAt === null || p.finishedAt < p.startedAt) && p.doing);
  return (
    <>
      <Head title="Worker" sub="The service that reads the chain and fills the store. It runs as its own process; this page reads what it recorded.">
        <Refresh everyMs={5_000} />
      </Head>

      <Notices notices={v.notices} />
      <p className="mt-3 text-sm text-muted-foreground">
        <b className="font-medium text-foreground">Now</b>{' '}
        {now.length === 0 ? 'Idle between passes. The next one starts on its own.' : now.map((p) => p.doing).join(' · ')}
      </p>

      <Section title="What it does" lead="Three jobs, in the order data flows through them. Each feeds the next, and the last feeds the console.">
        <ol className="grid gap-3 lg:grid-cols-3">
          {v.jobs.map((j, i) => {
            const step = STEPS[j.job];
            const state = STATE[j.state];
            // In flight, running or stuck: what the row holds besides its start is the last pass's, not this one's.
            const inFlight = j.startedAt !== null && (j.finishedAt === null || j.finishedAt < j.startedAt);
            return (
              <li key={j.job} className="relative flex flex-col gap-2 rounded-lg border bg-card p-4">
                {i > 0 ? <span aria-hidden className="absolute top-1/2 -left-3 hidden -translate-y-1/2 text-muted-foreground lg:block">→</span> : null}
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-foreground"><span className="mr-1.5 text-muted-foreground tabular-nums">{i + 1}</span>{step.title}</p>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', state.className)}>{state.label}</span>
                </div>
                <p className="text-sm text-muted-foreground">{step.does}</p>
                <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-muted-foreground">Every</dt><dd>{v.every[j.job] / 1000}s</dd>
                  <dt className="text-muted-foreground">Last run</dt><dd>{j.startedAt === null ? 'never' : <Time ms={j.startedAt} />}{j.tookMs !== null && !inFlight ? `, took ${(j.tookMs / 1000).toFixed(1)}s` : ''}</dd>
                  <dt className="text-muted-foreground">Said</dt><dd className={cn(j.state === 'failed' && 'text-fault')}>{inFlight ? '…' : j.detail ?? '—'}</dd>
                  <dt className="text-muted-foreground">Feeds</dt><dd>{step.feeds}</dd>
                </dl>
                {j.job === 'fund' && v.backlog.length > 0 ? (
                  <div className="border-t pt-2 text-xs">
                    {v.backlog.map((b) => {
                      const all = b.done + b.pending + b.failed;
                      return (
                        <div key={b.chainId}>
                          <p className="flex justify-between"><span>{chainName(b.chainId)}</span><span className="tabular-nums">{b.done.toLocaleString()} of {all.toLocaleString()} checked</span></p>
                          <span aria-hidden className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted"><i className="block h-full rounded-full bg-muted-foreground" style={{ width: `${all === 0 ? 0 : (b.done / all) * 100}%` }} /></span>
                          <p className="mt-0.5 text-muted-foreground">{b.etaMs === null ? '' : `${eta(b.etaMs)} · `}{b.pending.toLocaleString()} waiting · {b.failed} failed · {b.truncated} too large to page · {b.followed.toLocaleString()} followed from traders</p>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Section>

      <Section id="sources" title="What it reads from" lead="Without a source, the steps that need it do not run, and the lenses they feed say so rather than showing 0%. Each one is set in Settings.">
        <ul className="divide-y rounded-lg border bg-card text-sm">
          <li className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
            <span><span className="font-medium text-foreground">Chain RPC</span> <span className="text-muted-foreground">→ step 1</span></span>
            {v.rpcChains.length === 0
              ? <Link href="/settings#rpc.1" className="flex items-start gap-1 text-fault underline"><Warn className="mt-0.5 size-3.5" />None. Set an Ethereum RPC URL in Settings.</Link>
              : <span>{v.rpcChains.map(chainName).join(', ')} · <Link href="/settings#rpc.1" className="text-muted-foreground underline">change in Settings</Link></span>}
          </li>
          <li className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
            <span><span className="font-medium text-foreground">Funding</span> <span className="text-muted-foreground">→ step 2</span></span>
            {v.funding === null
              ? <span className="text-muted-foreground">{v.trailFunded ? `None: ${withoutKey(true)}.` : `None, so ${withoutKey(false)}.`} <Link href="/settings#etherscan.key" className="underline">Add an Etherscan key in Settings</Link>.</span>
              : <span>Etherscan API V2, <Link href="/settings#etherscan.rps" className="underline decoration-muted-foreground">{v.funding.perSecond ?? DEFAULT.rps} calls a second</Link>, following money <Link href="/settings#follow.hops" className="underline decoration-muted-foreground">{plural(v.followHops ?? DEFAULT.hops, 'hop')}</Link> out of traders · <Link href="/settings#etherscan.key" className="text-muted-foreground underline">change in Settings</Link></span>}
          </li>
        </ul>
      </Section>

      <Section title="How far along is each collection?">
        <ul className="divide-y rounded-lg border bg-card">
          {v.collections.map((c) => (
            <li key={`${c.chainId}/${c.address}`} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
              <Link className="font-medium text-foreground hover:underline" href={`/c/${c.chainId}/${c.address}`}>{c.name ?? short(c.address)}</Link>
              <span className="text-xs text-muted-foreground">
                {c.turn === 'paused' ? 'paused' : c.turn === 'restoring' ? 'loading stored data' : c.turn === 'stored-only' ? 'no RPC for its chain, stored data loaded' : c.headBlock === null && c.cursorBlock !== null && c.startBlock !== null && c.cursorBlock >= c.startBlock ? `read to block ${c.cursorBlock.toLocaleString('en-US')}, head not known` : c.cursorBlock === null || c.headBlock === null ? 'starting' : c.headBlock - c.cursorBlock <= 0 ? 'at the finalized head' : `${plural(c.headBlock - c.cursorBlock, 'block')} behind`}
                {c.turn === 'paused' || c.turn === 'restoring' || c.turn === 'stored-only' ? null : <>{' · '}{c.turn === 'backfilling' ? `backfilling${c.backfillEtaMs === null ? '' : `, ${eta(c.backfillEtaMs)}`}` : 'keeping up'}</>}
                {' · '}{c.analyzedAt === null ? 'not analyzed' : <>analyzed <Time ms={c.analyzedAt} /> ({c.analysisMs} ms)</>}{c.stale && c.turn !== 'paused' ? ' · new data waiting' : ''}
              </span>
              {/* A "No RPC" left from before stored data loaded is no fault, paused or not; the notice above says how to read on. */}
              {/* Nor an error on a paused collection: the worker leaves it alone, so it is from before the pause. */}
              {c.error && !c.storedOnly ? c.turn === 'paused'
                ? <p className="basis-full text-xs text-muted-foreground">Paused · last error before the pause: {c.error}</p>
                : <p className="flex basis-full items-start gap-1 text-xs text-fault"><Warn className="size-3.5" />{c.error}</p> : null}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
