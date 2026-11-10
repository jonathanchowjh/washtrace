'use client';

import { useEffect, useState } from 'react';
import type { LensRule } from '@washtrace/detect/lens-rule';
import { floorPct, num, pctTenth } from '@/lib/format';
import { send } from './lens-actions';

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

  useEffect(() => {
    if (id === null) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const res = await fetch(`/api/lenses/previews/${id}`).catch(() => null);
      const body = res?.ok ? (await res.json() as Said) : null;
      if (!live) return;
      if (body === null) { setError(res?.status === 404 ? 'This preview is gone. Run it again.' : 'The service did not answer.'); setId(null); return; }
      setSaid(body);
      if (body.status === 'queued' || body.status === 'running') timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [id]);

  async function start() {
    setError(null);
    setSaid(null);
    const r = await send<{ id: number }>('/api/lenses/previews', 'POST', { chainId, address, rule });
    if (r.error !== null) setError(r.error);
    else setId(r.body.id);
  }

  const going = said?.status === 'queued' || said?.status === 'running' || (id !== null && said === null);
  const r = said?.status === 'done' ? said.result : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={start} disabled={!writable || going} className="btn-secondary text-xs">{going ? 'Previewing…' : 'Preview'}</button>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {said?.status === 'queued' ? 'Waiting for the worker' : null}
        {said?.status === 'running' ? (said.progress ? `Previewing… ${floorPct(said.progress, 1)}` : 'Loading the collection…') : null}
        {r ? `Caught ${pctTenth(r.caught, r.judged ?? r.sampled)} of ${num(r.judged ?? r.sampled)} sales judged` : null}
      </span>
      {error ?? (said?.status === 'failed' ? said.error : null) ? <span role="alert" className="text-xs text-fault">{error ?? said?.error}</span> : null}
    </span>
  );
}
