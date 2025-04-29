'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CHAINS } from '@/lib/chains';

const FIELD = 'rounded-[5px] border bg-card px-2 py-1 text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none';
const BUTTON = 'rounded-[5px] border px-2.5 py-1 font-medium text-foreground hover:bg-muted disabled:opacity-50';

/** Watch a collection: POST /api/collections, the same call an integrator makes. */
export function AddCollection() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(form: FormData) {
    setBusy(true);
    setSaid(null);
    const from = String(form.get('fromBlock') ?? '').trim();
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chainId: Number(form.get('chainId')),
        address: String(form.get('address') ?? '').trim(),
        name: String(form.get('name') ?? '').trim() || undefined,
        fromBlock: from === '' ? undefined : Number(from),
      }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    setBusy(false);
    if (!res || !res.ok) { setSaid({ ok: false, text: body.error ?? 'The service did not answer.' }); return; }
    setSaid({ ok: true, text: body.warning ?? (body.created ? 'Watching. The worker reads it on its next pass.' : 'Already watched.') });
    router.refresh();
  }

  return (
    <form action={submit} className="flex flex-wrap items-end gap-2 text-[13px]">
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">Chain
        <select name="chainId" defaultValue="1" className={FIELD}>
          {Object.entries(CHAINS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">Contract
        <input name="address" required pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" className={`${FIELD} w-[23rem] max-w-full font-mono text-xs`} />
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">Name
        <input name="name" placeholder="optional" className={`${FIELD} w-36`} />
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">From block
        <input name="fromBlock" inputMode="numeric" pattern="\d*" placeholder="deployment" className={`${FIELD} w-28 font-mono text-xs`} />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>{busy ? 'Adding…' : 'Watch'}</button>
      {said ? <p role="status" className={said.ok ? 'basis-full text-xs text-ok' : 'basis-full text-xs text-cycle'}>{said.text}</p> : null}
    </form>
  );
}

/** Stop watching, with the confirmation inline: one press arms it, a second within the row does it. */
export function StopWatching({ chainId, address }: { chainId: number; address: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function stop() {
    const res = await fetch(`/api/collections/${chainId}/${address}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    if (!res?.ok) { setError('Could not stop watching.'); return; }
    router.push('/');
    router.refresh();
  }
  if (!armed) return <button type="button" onClick={() => setArmed(true)} className={BUTTON}>Stop watching</button>;
  return (
    <span className="flex items-center gap-2 text-xs">
      <span>Drops its transfers and analyses.</span>
      <button type="button" onClick={stop} className={`${BUTTON} border-cycle text-cycle`}>Stop watching</button>
      <button type="button" onClick={() => setArmed(false)} className={BUTTON}>Keep</button>
      {error ? <span className="text-cycle">{error}</span> : null}
    </span>
  );
}
