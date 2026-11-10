'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LOCAL_ONLY } from '@/lib/auth';
import { send } from './lens-actions';
import { KindIcon } from './kit';

/** One watched collection in a lens's Runs on list: where its run stands, its share, what data it still needs, and its tab. */
export type RunRow = {
  chainId: number; address: string; name: string;
  /** Its tab, where its figures and its editor (with Preview) are. */
  tab: string; edit: string;
  /** How its run stands, in runStateWords' short words; null for a current run. */
  state: string | null;
  share: string | null;
  /** What it still needs read here before its share is all it can be; null for nothing. */
  needs: string | null;
  /** Queued or running now, so asking again does nothing. */
  busy: boolean;
};

/**
 * Which collections a lens runs on, as a checklist: tick the ones to run it
 * on and Run on N queues each. A preview is never started here: one runs at a
 * time on the worker, so each collection's opens on its own tab, by hand.
 */
export function RunsOn({ lensId, rows, writable }: { lensId: number; rows: readonly RunRow[]; writable: boolean }) {
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = (r: RunRow) => `${r.chainId}:${r.address}`;
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  async function run() {
    setBusy(true);
    setError(null);
    for (const r of rows.filter((x) => picked.has(key(x)))) {
      const { error: failed } = await send(`/api/lenses/${lensId}/runs`, 'POST', { chainId: r.chainId, address: r.address });
      if (failed !== null) { setError(`${r.name}: ${failed}`); break; }
    }
    setBusy(false);
    setPicked(new Set());
    router.refresh();
  }

  return (
    <div className="rounded-lg border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="w-8 px-3 py-2"><span className="sr-only">Run on it</span></th>
            <th className="px-3 py-2 font-medium">Runs on</th>
            <th className="px-3 py-2 font-medium">Where its run stands</th>
            <th className="px-3 py-2 font-medium">Data it still needs here</th>
            <th className="px-3 py-2"><span className="sr-only">Edit or preview</span></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={key(r)}>
              <td className="px-3 py-2">
                <input type="checkbox" aria-label={`Run on ${r.name}`} checked={picked.has(key(r))} disabled={!writable || r.busy} onChange={() => toggle(key(r))} />
              </td>
              <td className="px-3 py-2"><Link href={r.tab} className="inline-flex items-center gap-1.5 font-medium hover:underline"><KindIcon kind="collection" />{r.name}</Link></td>
              <td className="px-3 py-2 text-muted-foreground">
                {r.share === null ? null : <Link href={r.tab} className="mr-2 font-medium text-foreground tabular-nums hover:underline">{r.share}</Link>}
                {r.state ?? (r.share === null ? null : 'current')}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.needs ?? '—'}</td>
              <td className="px-3 py-2 text-right text-xs"><Link href={r.edit} className="text-muted-foreground hover:text-foreground hover:underline">Edit or preview here ›</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-3 border-t px-3 py-2 text-xs">
        <button type="button" className="btn-secondary" disabled={!writable || busy || picked.size === 0} onClick={run}>
          {busy ? 'Queuing…' : `Run on ${picked.size === 1 ? '1 collection' : `${picked.size} collections`}`}
        </button>
        {writable ? <span className="text-muted-foreground">Each run is queued; the worker runs them one at a time.</span> : <span className="text-muted-foreground">{LOCAL_ONLY}</span>}
        {error === null ? null : <span role="alert" className="text-fault">{error}</span>}
      </div>
    </div>
  );
}
