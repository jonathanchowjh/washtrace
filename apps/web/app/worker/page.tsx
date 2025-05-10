import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { messageOf } from '@washtrace/detect';
import { Answer, Head, Problem, Section } from '@/components/head';
import { Refresh } from '@/components/refresh';
import { chainName } from '@/lib/chains';
import { LENSES, plural, short } from '@/lib/format';
import type { JobState } from '@/lib/status';
import { workerView } from '@/lib/views';
import { cn } from '@/lib/utils';
import { Time } from '@/components/time';

export const metadata: Metadata = { title: 'Worker' };

/** The three jobs in the order data flows through them, each with what it feeds. */
const STEPS = {
  ingest: { title: 'Read transfers', does: 'Reads every finalized ERC-721 transfer of each collection, and the receipts that make some of them sales.', feeds: 'every lens' },
  fund: { title: 'Check wallets for money', does: 'Asks Etherscan who paid whom, for each wallet that traded, busiest first.', feeds: `${LENSES.AU.name} and ${LENSES.AC.name}` },
  analyze: { title: 'Run the lenses', does: 'Reruns all three lenses over each collection that has new data.', feeds: 'every number in the console' },
} as const;

const STATE: Record<JobState, { label: string; className: string }> = {
  ok: { label: 'OK', className: 'bg-ok/12 text-ok' },
  running: { label: 'Running', className: 'bg-focus/12 text-focus' },
  failed: { label: 'Failed', className: 'bg-cycle/12 text-cycle' },
  stalled: { label: 'Stalled', className: 'bg-cycle/12 text-cycle' },
  never: { label: 'Never run', className: 'bg-muted text-muted-foreground' },
};

/** The polling half, as the pipeline it is: what each step did last, what it feeds, and what needs a person. */
export default async function WorkerPage() {
  await connection();
  let v: Awaited<ReturnType<typeof workerView>>;
  try {
    v = await workerView();
  } catch (err) {
    return <><Head title="Worker" /><Problem title="The store did not answer">{messageOf(err)}</Problem></>;
  }
  return (
    <>
      <Head title="Worker" sub="The service that reads the chain and fills the store. It runs as its own process; this page reads what it recorded.">
        <Refresh everyMs={5_000} />
      </Head>

      <Answer tone={v.problems.length === 0 ? 'clean' : 'cycle'} title={v.problems.length === 0 ? 'Nothing needs attention' : `${plural(v.problems.length, 'thing')} need${v.problems.length === 1 ? 's' : ''} attention`}>
        {v.problems.length === 0 ? 'Every job ran on time and every collection is keeping up.' : (
          <ul className="list-disc space-y-0.5 pl-4">{v.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        )}
      </Answer>

      <Section title="What it does" lead="Three jobs, in the order data flows through them. Each feeds the next, and the last feeds the console.">
        <ol className="grid gap-3 lg:grid-cols-3">
          {v.jobs.map((j, i) => {
            const step = STEPS[j.job];
            const state = STATE[j.state];
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
                  <dt className="text-muted-foreground">Last run</dt><dd>{j.startedAt === null ? 'never' : <Time ms={j.startedAt} />}{j.tookMs !== null && j.state !== 'running' ? `, took ${(j.tookMs / 1000).toFixed(1)}s` : ''}</dd>
                  <dt className="text-muted-foreground">Said</dt><dd className={cn(j.state === 'failed' && 'text-cycle')}>{j.state === 'running' ? '…' : j.detail ?? '—'}</dd>
                  <dt className="text-muted-foreground">Feeds</dt><dd>{step.feeds}</dd>
                </dl>
                {j.job === 'fund' && v.backlog.length > 0 ? (
                  <div className="border-t pt-2 text-xs">
                    {v.backlog.map((b) => {
                      const all = b.done + b.pending + b.failed;
                      return (
                        <div key={b.chainId}>
                          <p className="flex justify-between"><span>{chainName(b.chainId)}</span><span className="tabular-nums">{b.done.toLocaleString()} of {all.toLocaleString()} checked</span></p>
                          <span aria-hidden className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted"><i className="block h-full rounded-full bg-money" style={{ width: `${all === 0 ? 0 : (b.done / all) * 100}%` }} /></span>
                          <p className="mt-0.5 text-muted-foreground">{b.pending.toLocaleString()} waiting · {b.failed} failed · {b.truncated} too large to page · {b.followed.toLocaleString()} followed from traders</p>
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

      <Section title="What it reads from" lead="Without a source, the steps that need it do not run, and the lenses they feed say so rather than showing 0%.">
        <ul className="divide-y rounded-lg border bg-card text-sm">
          <li className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
            <span><span className="font-medium text-foreground">Chain RPC</span> <span className="text-muted-foreground">→ step 1</span></span>
            {v.rpcChains.length === 0 ? <span className="text-cycle">None. Set WASHTRACE_RPC_1 to an Ethereum JSON-RPC URL.</span> : <span>{v.rpcChains.map(chainName).join(', ')}</span>}
          </li>
          <li className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
            <span><span className="font-medium text-foreground">Funding</span> <span className="text-muted-foreground">→ step 2</span></span>
            {v.funding === null
              ? <span className="text-money">None, so {LENSES.AU.name} and {LENSES.AC.name} do not run. Set WASHTRACE_ETHERSCAN_KEY.</span>
              : <span>Etherscan API V2, {v.funding.perSecond} calls a second, following money {plural(v.followHops, 'hop')} out of traders</span>}
          </li>
        </ul>
      </Section>

      <Section title="How far along is each collection?">
        <ul className="divide-y rounded-lg border bg-card">
          {v.collections.map((c) => (
            <li key={`${c.chainId}/${c.address}`} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
              <Link className="font-medium text-foreground hover:underline" href={`/c/${c.chainId}/${c.address}`}>{c.name ?? short(c.address)}</Link>
              <span className="text-xs text-muted-foreground">
                {c.cursorBlock === null || c.headBlock === null ? 'starting' : c.headBlock - c.cursorBlock <= 0 ? 'at the finalized head' : `${plural(c.headBlock - c.cursorBlock, 'block')} behind`}
                {' · '}{c.analyzedAt === null ? 'not analyzed' : <>analyzed <Time ms={c.analyzedAt} /> ({c.analysisMs} ms)</>}{c.stale ? ' · new data waiting' : ''}
              </span>
              {c.error ? <p className="basis-full text-xs text-cycle">{c.error}</p> : null}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
