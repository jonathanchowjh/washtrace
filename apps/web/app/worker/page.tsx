import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { messageOf } from '@washtrace/detect';
import { Answer, Bar, Head, Pill, Problem, STORE_DOWN, Section, Warn, type PillTone } from '@/components/ui';
import { Refresh } from '@/components/refresh';
import { chainName } from '@/lib/chains';
import { ETHERSCAN_CTA, ETHERSCAN_HREF, LENSES, eta, interval, num, plural, stageName, took, withoutKey } from '@/lib/format';
import { FIELDS } from '@/lib/settings';
import { JOB_STEP, type JobState, type Notice } from '@/lib/status';
import { workerView } from '@/lib/views';
import { readerZone } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Time } from '@/components/zone';
import { PipelineErrors, PipelineTable } from '@/components/pipeline';

export const metadata: Metadata = { title: 'Worker' };

/** What the worker uses for a number it has no value for, or one it ignores (env.ts, mirrored in FIELDS). */
const DEFAULT = {
  rps: Number(FIELDS.find((f) => f.key === 'etherscan.rps')!.fallback),
  hops: Number(FIELDS.find((f) => f.key === 'follow.hops')!.fallback),
};

/** The four jobs in the order data flows through them, each with what it feeds. */
const STEPS = {
  ingest: { title: JOB_STEP.ingest, does: 'Reads every finalized ERC-721 transfer of each collection, and the receipts that make some of them sales.', feeds: 'every lens' },
  fund: { title: JOB_STEP.fund, does: 'Asks Etherscan who paid whom, for each wallet that traded, busiest first.', feeds: `${LENSES.AU.name} and ${LENSES.AC.name}` },
  analyze: { title: JOB_STEP.analyze, does: 'Reruns the three built-in lenses over each collection that has new data.', feeds: 'every number in the console' },
  lens: { title: JOB_STEP.lens, does: 'Runs each lens of yours over the collections it was asked on, after their latest analysis.', feeds: 'the lists and tabs of your lenses' },
} as const;

const STATE: Record<JobState, { label: string; tone: PillTone }> = {
  ok: { label: 'OK', tone: 'done' },
  running: { label: 'Running', tone: 'working' },
  failed: { label: 'Failed', tone: 'fault' },
  stalled: { label: 'Stalled', tone: 'fault' },
  never: { label: 'Never run', tone: 'idle' },
};

/** The polling half, as the pipeline it is: what each step did last, what it feeds, and what needs a person. */
export default async function WorkerPage() {
  await connection();
  let v: Awaited<ReturnType<typeof workerView>>;
  try {
    // The reader's zone, for the dates in the notices.
    v = await workerView(await readerZone());
  } catch (err) {
    return <><Head title="Worker" /><Problem title={STORE_DOWN}>{messageOf(err)}</Problem></>;
  }
  // A pass that started and has not finished is running; its `doing` says what, and for which collection.
  const now = v.passes.filter((p) => (p.finishedAt === null || p.finishedAt < p.startedAt) && p.doing);
  return (
    <>
      <Head title="Worker" sub="The service that reads the chain and fills the store. It runs as its own process; this page reads what it recorded.">
        <Refresh everyMs={5_000} />
      </Head>

      <Status notices={v.notices} now={now.length === 0 ? 'Idle between passes. The next one starts on its own.' : now.map((p) => p.doing).join(' · ')} />

      <Section title="What it does" lead="Four jobs, each run over every collection on its own timer, in the order data flows through them. The first three feed the console; the last runs your own lenses on what the third analyzed. They are not the reading stages below, which say how far one collection has got.">
        {/* Each card spans four rows of the list's grid, so its title, what it does, its figures and the backlog line up across cards. */}
        {/* The jobs are not numbered: the reading stages below are, 1 to 6, and a job's number read as a stage's. The arrows give their order. */}
        <ol aria-label="Jobs" className="grid gap-3 lg:grid-cols-4">
          {v.jobs.map((j, i) => {
            const step = STEPS[j.job];
            const state = STATE[j.state];
            // In flight, running or stuck: what the row holds besides its start is the last pass's, not this one's.
            const inFlight = j.startedAt !== null && (j.finishedAt === null || j.finishedAt < j.startedAt);
            return (
              <li key={j.job} className="relative flex flex-col gap-2 rounded-lg border bg-card p-4 lg:row-span-4 lg:grid lg:grid-rows-subgrid">
                {i > 0 ? <span aria-hidden className="absolute top-1/2 -left-3 hidden -translate-y-1/2 text-muted-foreground lg:block">→</span> : null}
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-foreground">{step.title}</p>
                  <Pill tone={state.tone}>{state.label}</Pill>
                </div>
                <p className="text-sm text-muted-foreground">{step.does}</p>
                <dl className="mt-auto grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-0.5 text-xs lg:mt-0">
                  <dt className="text-muted-foreground">Every</dt><dd>{interval(v.every[j.job])}</dd>
                  <dt className="text-muted-foreground">Last run</dt><dd>{j.startedAt === null ? 'never' : <Time ms={j.startedAt} />}{j.tookMs !== null && !inFlight ? `, took ${took(j.tookMs)}` : ''}</dd>
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
                          <p className="flex justify-between"><span>{chainName(b.chainId)}</span><span className="tabular-nums">{num(b.done)} of {num(all)} wallets on this chain checked</span></p>
                          <Bar share={all === 0 ? 0 : b.done / all} className="mt-1" />
                          <p className="mt-0.5 text-muted-foreground">{b.etaMs === null ? '' : `${eta(b.etaMs)} · `}{num(b.pending)} waiting · {b.failed} failed · {b.stranded > 0 ? `${num(b.stranded)} held back while their collections are paused or removed, or further out than the follow limit · ` : ''}{b.truncated} too large to page · {num(b.followed)} followed from traders{b.stale > 0 ? ` · ${num(b.stale)} to read again` : ''}</p>
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
            <span><span className="font-medium text-foreground">Chain RPC</span> <span className="text-muted-foreground">→ {stageName(4)}</span></span>
            {v.rpcChains.length === 0
              ? <Link href="/settings#rpc.1" className="text-money underline">No RPC. Add an RPC URL in Settings →</Link>
              // Settings lists every chain's RPC with where it comes from, but saves only Ethereum's: another chain's is set in .env.
              : <span>{v.rpcChains.map(chainName).join(', ')} · <Link href="/settings#rpc" className="text-muted-foreground underline">{v.rpcChains.every((id) => id === 1) ? 'change in Settings' : 'where each comes from, in Settings'}</Link></span>}
          </li>
          <li className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
            <span><span className="font-medium text-foreground">Funding</span> <span className="text-muted-foreground">→ {stageName(5)}</span></span>
            {v.funding === null
              ? <span className="text-money">Needs a key: {withoutKey(v.trailFunded)}. <Link href={ETHERSCAN_HREF} className="underline">{ETHERSCAN_CTA}</Link></span>
              : <span>Etherscan API V2, <Link href="/settings#etherscan.rps" className="underline decoration-muted-foreground">{v.funding.perSecond ?? DEFAULT.rps} calls a second</Link>, following money <Link href="/settings#follow.hops" className="underline decoration-muted-foreground">{plural(v.followHops ?? DEFAULT.hops, 'wallet')} out</Link> from traders · <Link href="/settings#etherscan.key" className="text-muted-foreground underline">change in Settings</Link></span>}
          </li>
        </ul>
      </Section>

      <Section title="How far along is each collection?" lead="Each collection's reading in six stages, and how far each has got: the jobs above do the work, a stage says where one collection stands. Open one for what each stage means and what feeds what.">
        <PipelineTable rows={v.collections} />
        <PipelineErrors rows={v.collections.map((c) => ({ ...c, paused: c.turn === 'paused', rpc: v.rpcChains.includes(c.chainId) }))} />
      </Section>
    </>
  );
}

/**
 * The page's answer: nothing has failed, or how many things need a person,
 * each with what to do; then what is under way or limited, and what the
 * worker is doing now. "Nothing has failed." is the normal state even while
 * hours of work remain, so the notices under it matter too.
 */
function Status({ notices, now }: { notices: Notice[]; now: string }) {
  const needs = notices.filter((n): n is Extract<Notice, { severity: 'needs-you' }> => n.severity === 'needs-you');
  const rest = notices.filter((n): n is Exclude<Notice, { severity: 'needs-you' }> => n.severity !== 'needs-you');
  return (
    <Answer tone="clean" title={needs.length === 0 ? 'Nothing has failed.' : `${plural(needs.length, 'thing')} ${needs.length === 1 ? 'needs' : 'need'} you`}>
      <div className="space-y-2">
        {needs.map((n, i) => (
          <div key={i} role="alert" className="flex gap-3 rounded-lg border border-fault/40 bg-card p-3">
            <Warn className="mt-0.5 size-5 text-fault" />
            <div>
              <p className="font-semibold text-foreground">{n.text}</p>
              <p className="mt-0.5"><b className="text-fault">Do this:</b> {n.href ? <Link className="underline" href={n.href}>{n.doThis}</Link> : n.doThis}</p>
            </div>
          </div>
        ))}
        {rest.length > 0 ? (
          <ul className="space-y-1">
            {rest.map((n, i) => (
              <li key={i} className={cn('flex items-start gap-2', n.severity === 'info' && 'text-muted-foreground')}>
                {n.severity === 'working'
                  ? <span aria-hidden className="mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-focus" />
                  : <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground" />}
                <span>{n.text}{n.action ? <> <Link className="underline" href={n.action.href}>{n.action.label}</Link></> : null}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted-foreground"><b className="font-medium text-foreground">Now</b> {now}</p>
      </div>
    </Answer>
  );
}
