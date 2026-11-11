'use client';

import type { LensRule } from '@washtrace/detect/lens-rule';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LOCAL_ONLY } from '@/lib/auth';
import { floorPct, num, pctTenth } from '@/lib/format';
import { poll, send } from '@/lib/send';
import { KindIcon } from './kit';

const POLL_MS = 1000;

type Said = { status: 'queued' | 'running' | 'done' | 'failed'; progress: number | null; error: string | null; result: { caught: number; sampled: number; judged?: number } | null };

/**
 * Preview, on one row of the Lab's Runs on: a lens's rule on a sample of that
 * collection's sales, started only by its button, since previews run one at a
 * time on the worker. The line is the share alone; the collection's Methods
 * page words how sure it is from what is read there.
 */
export function RowPreview({ chainId, address, rule, writable }: { chainId: number; address: string; rule: LensRule; writable: boolean }) {
  const [id, setId] = useState<number | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last poll failed with no word that the preview is gone: polling goes on, as the Methods page's preview's does.
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (id === null) return;
    return poll<Said>(`/api/lenses/previews/${id}`, {
      every: POLL_MS,
      done: (body) => body.status !== 'queued' && body.status !== 'running',
      onRow: (body) => { setLost(false); setSaid(body); },
      onLost: () => setLost(true),
      onGone: (body) => { setLost(false); setError(body?.error ?? 'This preview is gone. Run it again.'); setId(null); },
    });
  }, [id]);

  async function start() {
    setError(null);
    setSaid(null);
    const r = await send<{ id: number }>('/api/lenses/previews', 'POST', { chainId, address, rule });
    if (r.error !== null) setError(r.error);
    else setId(r.body.id);
  }

  // Still polling counts as going, so a lost poll does not invite a second preview.
  const going = lost || said?.status === 'queued' || said?.status === 'running' || (id !== null && said === null);
  const r = said?.status === 'done' ? said.result : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={start} disabled={!writable || going} className="btn-secondary text-xs">{going ? 'Previewing…' : 'Preview'}</button>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {said?.status === 'queued' ? 'Waiting for the worker' : null}
        {said?.status === 'running' ? (said.progress ? `Previewing… ${floorPct(said.progress, 1)}` : 'Loading the collection…') : null}
        {r ? `Caught ${pctTenth(r.caught, r.judged ?? r.sampled)} of ${num(r.judged ?? r.sampled)} sales judged` : null}
        {lost ? ' Lost touch with the service; trying again every second.' : null}
      </span>
      {error ?? (said?.status === 'failed' ? said.error : null) ? <span role="alert" className="text-xs text-fault">{error ?? said?.error}</span> : null}
    </span>
  );
}

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
 * on and Run on N queues each. A preview starts only from its row's button:
 * one runs at a time on the worker, so none is started for the reader.
 */
export function RunsOn({ lensId, rule, rows, writable }: { lensId: number; rule: LensRule; rows: readonly RunRow[]; writable: boolean }) {
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = (r: RunRow) => `${r.chainId}:${r.address}`;
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  async function run() {
    setBusy(true);
    setError(null);
    const queue = rows.filter((x) => picked.has(key(x)));
    // Those after a failure were never sent: they stay ticked, so Run on N again sends just them.
    let left: string[] = [];
    for (const [n, r] of queue.entries()) {
      const { error: failed } = await send(`/api/lenses/${lensId}/runs`, 'POST', { chainId: r.chainId, address: r.address });
      if (failed !== null) { setError(`${r.name}: ${failed} Those still ticked are not queued.`); left = queue.slice(n).map(key); break; }
    }
    setBusy(false);
    setPicked(new Set(left));
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
            <th className="px-3 py-2"><span className="sr-only">Preview or edit</span></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={key(r)}>
              <td className="px-3 py-2">
                <input type="checkbox" aria-label={`Run on ${r.name}`} checked={picked.has(key(r))} disabled={!writable || r.busy} onChange={() => toggle(key(r))} />
              </td>
              <td className="px-3 py-2"><Link href={r.tab} prefetch={false} className="inline-flex items-center gap-1.5 font-medium hover:underline"><KindIcon kind="collection" />{r.name}</Link></td>
              <td className="px-3 py-2 text-muted-foreground">
                {r.share === null ? null : <Link href={r.tab} prefetch={false} className="mr-2 font-medium text-foreground tabular-nums hover:underline">{r.share}</Link>}
                {r.state ?? (r.share === null ? null : 'current')}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.needs ?? '—'}</td>
              <td className="px-3 py-2 text-right text-xs">
                <span className="inline-flex flex-wrap items-center justify-end gap-3">
                  <RowPreview chainId={r.chainId} address={r.address} rule={rule} writable={writable} />
                  <Link href={r.edit} prefetch={false} className="text-muted-foreground hover:text-foreground hover:underline">Edit here ›</Link>
                </span>
              </td>
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
