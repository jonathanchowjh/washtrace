import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { messageOf, type CollectionRow } from '@washtrace/detect';
import { Head, Problem } from '@/components/head';
import { Refresh } from '@/components/refresh';
import { AddCollection } from '@/components/watch';
import { chainName } from '@/lib/chains';
import { ConfigError } from '@/lib/config';
import { METHOD_NAMES, clock, pct, plural, short } from '@/lib/format';
import { store } from '@/lib/store';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Collections' };

/**
 * Every watched collection on one row: how far the worker has read it, how
 * much of its money it has read, and the wash trade share each method finds.
 * The paper's Table 3, one row per collection, kept current.
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
      <Head title="Collections" sub="Wash trade share: the transfers each method flags, over every change of owner it read.">
        <Refresh />
      </Head>
      <div className="my-4 rounded-md border bg-card p-3"><AddCollection /></div>
      {rows.length === 0 ? (
        <div className="max-w-xl space-y-2 rounded-md border bg-card p-5">
          <p className="font-medium text-foreground">No collection is watched yet.</p>
          <p>Add one above, or <code className="font-mono text-xs">POST /api/collections</code>. The worker finds its deployment block, reads every transfer since, then reads who funded the wallets that traded it.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full min-w-[60rem] text-left">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 font-medium">Collection</th>
                <th className="px-3 py-2 font-medium">Read through</th>
                <th className="px-3 py-2 font-medium">Funding read</th>
                {(['A', 'AU', 'AC'] as const).map((m) => <th key={m} className="px-3 py-2 text-right font-medium">{METHOD_NAMES[m]}</th>)}
                <th className="px-3 py-2 text-right font-medium">Missing data</th>
                <th className="px-3 py-2 font-medium">Analyzed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => <Row key={c.id} c={c} />)}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Row({ c }: { c: CollectionRow }) {
  const behind = c.headBlock !== null && c.cursorBlock !== null ? c.headBlock - c.cursorBlock : null;
  const span = c.headBlock !== null && c.startBlock !== null ? c.headBlock - c.startBlock : null;
  const a = c.latest;
  return (
    <tr className="border-b last:border-b-0 align-top">
      <td className="px-3 py-2.5">
        <Link href={`/c/${c.chainId}/${c.address}`} className="font-medium text-foreground hover:underline">{c.name ?? short(c.address)}</Link>
        <p className="font-mono text-xs text-muted-foreground">{chainName(c.chainId)} · {short(c.address)} · {plural(c.transfers, 'transfer')}</p>
        {c.error ? <p className="mt-1 max-w-sm text-xs text-cycle">{c.error}</p> : null}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs tabular-nums">
        {c.cursorBlock === null || c.startBlock === null ? <span className="text-muted-foreground">finding deployment…</span> : (
          <>
            {c.cursorBlock.toLocaleString()}
            <p className={cn('text-muted-foreground', behind !== null && behind > 1_000 && 'text-money')}>
              {behind === null ? '' : behind <= 0 ? 'at finalized head' : `${plural(behind, 'block')} behind${span ? ` · ${pct(c.cursorBlock - c.startBlock, span)}` : ''}`}
            </p>
          </>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs tabular-nums">
        {a === null ? '—' : <>{pct(a.fundedWallets, a.wallets)}<p className="text-muted-foreground">{a.fundedWallets.toLocaleString()} of {a.wallets.toLocaleString()} wallets</p></>}
      </td>
      {(['A', 'AU', 'AC'] as const).map((m) => {
        const t = a?.totals[m];
        return (
          <td key={m} className="px-3 py-2.5 text-right font-mono tabular-nums">
            {!t ? '—' : !t.available ? <span className="text-muted-foreground">not run</span> : (
              <span className={cn(t.flagged > 0 && (m === 'A' ? 'text-cycle' : 'text-money'))}>{pct(t.flagged, t.transfers)}</span>
            )}
          </td>
        );
      })}
      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{a === null ? '—' : `${(a.missingData * 100).toFixed(1)}%`}</td>
      <td className="px-3 py-2.5 text-xs whitespace-nowrap">
        {a === null ? <span className="text-muted-foreground">not yet</span> : clock(a.ranAt)}
        {c.stale && a !== null ? <p className="text-muted-foreground">new data waiting</p> : null}
      </td>
    </tr>
  );
}
