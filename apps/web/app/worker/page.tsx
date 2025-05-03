import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { messageOf } from '@washtrace/detect';
import { Head, Problem, Section } from '@/components/head';
import { Refresh } from '@/components/refresh';
import { chainName } from '@/lib/chains';
import { clock, plural, short } from '@/lib/format';
import { workerView } from '@/lib/views';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Worker' };

const JOBS = {
  ingest: 'Reads finalized ERC-721 transfers per collection, and the receipts that make them sales.',
  fund: 'Reads who paid whom for each wallet that traded, busiest first, from Etherscan.',
  analyze: 'Reruns SCC A, AU and AC over every collection written to since its last analysis.',
} as const;

/** The polling half: what each job did last, what is configured, and how far behind each collection is. */
export default async function WorkerPage() {
  await connection();
  let v: Awaited<ReturnType<typeof workerView>>;
  try {
    v = await workerView();
  } catch (err) {
    return <><Head title="Worker" /><Problem title="The store did not answer">{messageOf(err)}</Problem></>;
  }
  const pass = new Map(v.passes.map((p) => [p.job, p]));
  return (
    <>
      <Head title="Worker" sub="The worker service's passes, as it recorded them in the store. It runs as its own process; this page only reads.">
        <Refresh everyMs={5_000} />
      </Head>

      <Section title="Sources">
        <ul className="space-y-1">
          <li>RPC: {v.rpcChains.length === 0 ? <span className="text-cycle">none. Set WASHTRACE_RPC_1 to an Ethereum JSON-RPC URL.</span> : v.rpcChains.map(chainName).join(', ')}</li>
          <li>Funding: {v.funding === null ? <span className="text-money">none, so SCC AU and AC do not run. Set WASHTRACE_ETHERSCAN_KEY.</span> : `Etherscan API V2, ${v.funding.perSecond} calls a second, following money ${v.followHops} ${v.followHops === 1 ? 'hop' : 'hops'} out of traders`}</li>
        </ul>
      </Section>

      <Section title="Jobs">
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full min-w-[44rem] text-left">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 font-medium">Every</th>
                <th className="px-3 py-2 font-medium">Last started</th>
                <th className="px-3 py-2 text-right font-medium">Took</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(JOBS) as (keyof typeof JOBS)[]).map((job) => {
                const p = pass.get(job);
                const running = p && (p.finishedAt === null || p.finishedAt < p.startedAt);
                return (
                  <tr key={job} className="border-b last:border-b-0 align-top">
                    <td className="px-3 py-2"><span className="font-mono font-semibold text-foreground">{job}</span><p className="text-xs text-muted-foreground">{JOBS[job]}</p></td>
                    <td className="px-3 py-2 font-mono text-xs">{v.every[job] / 1000}s</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{p ? clock(p.startedAt) : 'never'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{running ? 'running' : p?.tookMs != null ? `${(p.tookMs / 1000).toFixed(1)}s` : '—'}</td>
                    <td className={cn('px-3 py-2 text-xs', p?.outcome === 'failed' && 'text-cycle')}>{running ? '…' : p?.detail ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Funding queue" aside="wallets per chain">
        {v.backlog.length === 0 ? <p className="text-muted-foreground">No wallets queued yet.</p> : (
          <ul className="space-y-1 font-mono text-xs">
            {v.backlog.map((b) => (
              <li key={b.chainId}>{chainName(b.chainId)}: {b.done.toLocaleString()} read · {b.pending.toLocaleString()} waiting · {b.failed} failed · {plural(b.truncated, 'truncated wallet')} · {b.followed.toLocaleString()} followed from traders</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Collections">
        <ul className="divide-y rounded-md border bg-card">
          {v.collections.map((c) => (
            <li key={`${c.chainId}/${c.address}`} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
              <Link className="hover:underline" href={`/c/${c.chainId}/${c.address}`}>{c.name ?? short(c.address)}</Link>
              <span className="font-mono text-xs text-muted-foreground">
                {c.cursorBlock === null || c.headBlock === null ? 'starting' : c.headBlock - c.cursorBlock <= 0 ? 'at finalized head' : `${plural(c.headBlock - c.cursorBlock, 'block')} behind`}
                {' · '}{c.analyzedAt === null ? 'not analyzed' : `analyzed ${clock(c.analyzedAt)} (${c.analysisMs} ms)`}{c.stale ? ' · stale' : ''}
              </span>
              {c.error ? <p className="basis-full text-xs text-cycle">{c.error}</p> : null}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
