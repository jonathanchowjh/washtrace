'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LOCAL_ONLY } from '@/lib/auth';

const BUTTON = 'rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Sends a lens write to its route, as JSON: the body it answered, parsed (or
 * {} when there is none), when it took; else the error the route gave, or
 * what went wrong when it gave none. The editor saves through it too. `T` is
 * the body the caller's route answers, taken on its word, so what the caller
 * reads of it is type-checked; left out, the body is unknown.
 */
export async function send<T = unknown>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: object): Promise<{ error: null; body: T } | { error: string }> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).catch(() => null);
  const said = res ? await res.json().catch(() => ({})) : {};
  if (res?.ok) return { error: null, body: said };
  return { error: said.error ?? (res ? `The service answered ${res.status}.` : 'The service did not answer.') };
}

/**
 * Deletes one of your lenses, its runs and its flags on every collection. It
 * asks first, in place, by the lens's name: there is no undo.
 */
export function DeleteLens({ id, name, writable }: { id: number; name: string; writable: boolean }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    const { error: failed } = await send(`/api/lenses/${id}`, 'DELETE');
    setBusy(false);
    if (failed !== null) { setError(failed); return; }
    router.refresh();
  }

  if (!asking) {
    return <button type="button" className={BUTTON} disabled={!writable} title={writable ? undefined : LOCAL_ONLY} onClick={() => setAsking(true)}>Delete</button>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      <span>Delete {name} and its results? This cannot be undone.</span>
      <button type="button" className={BUTTON} disabled={busy} onClick={remove}>Delete</button>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => { setAsking(false); setError(null); }}>Keep it</button>
      {error ? <span role="alert" className="text-sm text-fault">{error}</span> : null}
    </span>
  );
}

/**
 * Queues one of your lenses to run on this collection. Offered for a lens
 * with no run here, or one whose run failed (after three failures in a row it
 * waits to be asked). A queued or running run is on its way already, and the
 * store leaves a running one as it is (Ruling T); a finished one runs again on
 * its own after an edit or a newer analysis.
 */
export function RunHere({ id, chainId, address, writable }: { id: number; chainId: number; address: string; writable: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function queue() {
    setBusy(true);
    const { error: failed } = await send(`/api/lenses/${id}/runs`, 'POST', { chainId, address });
    setBusy(false);
    if (failed !== null) { setError(failed); return; }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={BUTTON} disabled={!writable || busy} title={writable ? undefined : LOCAL_ONLY} onClick={queue}>Run here</button>
      {error ? <span role="alert" className="text-sm text-fault">{error}</span> : null}
    </span>
  );
}
