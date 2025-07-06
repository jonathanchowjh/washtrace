'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Warn } from '@/components/head';
import { CHAINS } from '@/lib/chains';

const FIELD = 'rounded-[5px] border bg-card px-2 py-1 text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none';
const BUTTON = 'rounded-[5px] border px-2.5 py-1 font-medium text-foreground hover:bg-muted disabled:opacity-50';

type Said = { ok: boolean; text: string };

/**
 * Collections from the term paper's Table 3, each with a known answer to
 * check this reading against: the paper's SCC A wash trade share (dataset 2)
 * and Footprint Analytics'. Bored Apes is the control, where both found
 * little. CryptoPunks is left out: it predates ERC-721 and emits no
 * Transfer the worker reads.
 */
export const SUGGESTED = [
  { name: 'Dreadfulz', chainId: 1, address: '0x81ae0be3a8044772d04f32398bac1e1b4b215aa8', paper: 78.97, footprint: 98.45 },
  { name: 'Terraforms', chainId: 1, address: '0x4e1f41613c9084fdb9e34e11fae9412427480e56', paper: 45.89, footprint: 99.76 },
  { name: 'dotdotdot', chainId: 1, address: '0xce25e60a89f200b1fa40f6c313047ffe386992c3', paper: 35.26, footprint: 99.12 },
  { name: 'Meebits', chainId: 1, address: '0x7bd29408f11d2bfc23c34f18275bbf23bb716bc7', paper: 34.51, footprint: 96.02 },
  { name: 'Bored Ape Yacht Club', chainId: 1, address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', paper: 9.78, footprint: 1.46, control: true },
] as const;

/** POST /api/collections, the same call an integrator makes, and what to say about its answer. */
async function watch(collection: { chainId: number; address: string; name?: string; fromBlock?: number }): Promise<Said> {
  const res = await fetch('/api/collections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(collection),
  }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok) return { ok: false, text: body.error ?? 'The service did not answer.' };
  return { ok: true, text: body.warning ?? (body.created ? 'Watching. The worker reads it on its next pass.' : 'Already watched.') };
}

/**
 * The panel holding both ways to watch: open to start with when nothing is
 * watched, then the reader's to open and close. Its own state, because the
 * refresh after a first watch changes what the server would choose and must
 * not shut the panel on the answer.
 */
export function WatchPanel({ startOpen, children }: { startOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  return <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group mt-6">{children}</details>;
}

/** One press watches a suggestion. `watched` holds `chainId/address` of every watched collection; those link to their page instead. */
export function Suggested({ watched }: { watched: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said | null>(null);

  async function add(s: (typeof SUGGESTED)[number]) {
    setBusy(s.address);
    setSaid(null);
    const answer = await watch({ chainId: s.chainId, address: s.address, name: s.name });
    setBusy(null);
    setSaid({ ...answer, text: `${s.name}: ${answer.text}` });
    // The refresh brings the new `watched`, which turns its button into a link to the collection.
    if (answer.ok) router.refresh();
  }

  return (
    <div className="text-[13px]">
      <p className="text-xs text-muted-foreground">Suggested: collections from the term paper, each with a known answer to compare this reading against.</p>
      <ul className="mt-2 divide-y rounded-md border">
        {SUGGESTED.map((s) => {
          const key = `${s.chainId}/${s.address}`;
          return (
            <li key={key} className="flex items-center gap-4 px-3 py-2">
              <div className="min-w-0 flex-1 md:flex md:items-baseline md:gap-4">
                <p className="font-medium text-foreground md:w-44 md:shrink-0">{s.name}</p>
                <p className="text-xs text-muted-foreground">
                  {'control' in s ? 'Control: ' : ''}paper found {Math.round(s.paper)}% washed · Footprint {Math.round(s.footprint)}%
                </p>
              </div>
              {watched.includes(key)
                ? <Link href={`/c/${key}`} className="text-xs font-medium text-foreground hover:underline">Watching →</Link>
                : <button type="button" disabled={busy !== null} onClick={() => add(s)} className={BUTTON}>{busy === s.address ? 'Adding…' : 'Watch'}</button>}
            </li>
          );
        })}
      </ul>
      {said ? <p role="status" className={said.ok ? 'mt-1 text-xs text-ok' : 'mt-1 text-xs text-fault'}>{said.ok ? null : <Warn className="mr-1 size-3.5 align-text-bottom" />}{said.text}</p> : null}
    </div>
  );
}

/** Watch any collection by its contract address. */
export function AddCollection() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  async function submit(form: FormData) {
    setBusy(true);
    setSaid(null);
    const from = String(form.get('fromBlock') ?? '').trim();
    const answer = await watch({
      chainId: Number(form.get('chainId')),
      address: String(form.get('address') ?? '').trim(),
      name: String(form.get('name') ?? '').trim() || undefined,
      fromBlock: from === '' ? undefined : Number(from),
    });
    setBusy(false);
    setSaid(answer);
    if (answer.ok) router.refresh();
  }

  return (
    <form action={submit} className="flex flex-wrap items-end gap-2 text-[13px]">
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">Chain
        <select name="chainId" defaultValue="1" className={FIELD}>
          {Object.entries(CHAINS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label className="flex max-w-full flex-col gap-0.5 text-xs text-muted-foreground">Contract
        <input name="address" required pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" className={`${FIELD} w-[23rem] max-w-full font-mono text-xs`} />
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">Name
        <input name="name" placeholder="optional" className={`${FIELD} w-36`} />
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">From block
        <input name="fromBlock" inputMode="numeric" pattern="\d*" placeholder="deployment" className={`${FIELD} w-28 font-mono text-xs`} />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>{busy ? 'Adding…' : 'Watch'}</button>
      {said ? <p role="status" className={said.ok ? 'basis-full text-xs text-ok' : 'basis-full text-xs text-fault'}>{said.ok ? null : <Warn className="mr-1 size-3.5 align-text-bottom" />}{said.text}</p> : null}
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
      <button type="button" onClick={stop} className={`${BUTTON} border-fault text-fault`}>Stop watching</button>
      <button type="button" onClick={() => setArmed(false)} className={BUTTON}>Keep</button>
      {error ? <span className="text-fault"><Warn className="mr-1 size-3.5 align-text-bottom" />{error}</span> : null}
    </span>
  );
}
