import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { messageOf } from '@washtrace/detect';
import { Head, Notices, Problem, Section } from '@/components/head';
import { Refresh } from '@/components/refresh';
import { chainName } from '@/lib/chains';
import { LENSES, eta, plural, withoutKey } from '@/lib/format';
import { FIELDS } from '@/lib/settings';
import type { JobState } from '@/lib/status';
import { workerView } from '@/lib/views';
import { cn } from '@/lib/utils';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';
import { Time } from '@/components/time';
import { PipelineErrors, PipelineTable } from '@/components/coverage';

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
                  <dt className="text-muted-foreground">Said</dt><dd className={cn(!inFlight && j.outcome === 'failed' && 'text-fault')}>{inFlight ? '…' : j.detail ?? '—'}</dd>
                  <dt className="text-muted-foreground">Feeds</dt><dd>{step.feeds}</dd>
                </dl>
                {j.job === 'fund' && v.backlog.length > 0 ? (
                  <div className="border-t pt-2 text-xs">
                    {v.backlog.map((b) => {
                      // Every wallet on the chain, followed hops and held-back ones too: left out, the bar would read done while they wait for a resume.
                      const all = b.done + b.pending + b.failed + b.stranded;
                      return (
                        <div key={b.chainId}>
                          <p className="flex justify-between"><span>{chainName(b.chainId)}</span><span className="tabular-nums">{b.done.toLocaleString()} of {all.toLocaleString()} wallets on this chain checked</span></p>
                          <span aria-hidden className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted"><i className="block h-full rounded-full bg-muted-foreground" style={{ width: `${all === 0 ? 0 : (b.done / all) * 100}%` }} /></span>
                          <p className="mt-0.5 text-muted-foreground">{b.etaMs === null ? '' : `${eta(b.etaMs)} · `}{b.pending.toLocaleString()} waiting · {b.failed} failed · {b.stranded > 0 ? `${b.stranded.toLocaleString()} held back while their collections are paused or removed, or further out than the hops followed · ` : ''}{b.truncated} too large to page · {b.followed.toLocaleString()} followed from traders</p>
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

      <Section id="sources" title="What it reads from" lead="Without a source, the stages that need it do not run, and the lenses they feed say so rather than showing 0%. Each one is set in Settings.">
        <ul className="divide-y rounded-lg border bg-card text-sm">
          <li className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
            <span><span className="font-medium text-foreground">Chain RPC</span> <span className="text-muted-foreground">→ stage 4</span></span>
            {v.rpcChains.length === 0
              ? <Link href="/settings#rpc.1" className="text-money underline">Needs a key. Add an RPC URL in Settings →</Link>
              : <span>{v.rpcChains.map(chainName).join(', ')} · <Link href="/settings#rpc.1" className="text-muted-foreground underline">change in Settings</Link></span>}
          </li>
          <li className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
            <span><span className="font-medium text-foreground">Funding</span> <span className="text-muted-foreground">→ stage 5</span></span>
            {v.funding === null
              ? <span className="text-money">Needs a key: {withoutKey(v.trailFunded)}. <Link href="/settings#etherscan.key" className="underline">Add an Etherscan key in Settings →</Link></span>
              : <span>Etherscan API V2, <Link href="/settings#etherscan.rps" className="underline decoration-muted-foreground">{v.funding.perSecond ?? DEFAULT.rps} calls a second</Link>, following money <Link href="/settings#follow.hops" className="underline decoration-muted-foreground">{plural(v.followHops ?? DEFAULT.hops, 'hop')}</Link> out of traders · <Link href="/settings#etherscan.key" className="text-muted-foreground underline">change in Settings</Link></span>}
          </li>
        </ul>
      </Section>

      <Section title="How far along is each collection?" lead="One row per collection, one column per stage of its reading. Open a row for what each stage means and what feeds what.">
        <PipelineTable rows={v.collections} />
        <PipelineErrors rows={v.collections.map((c) => ({ ...c, paused: c.turn === 'paused', rpc: v.rpcChains.includes(c.chainId) }))} />
      </Section>
    </>
  );
}
