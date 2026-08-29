'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Warn } from '@/components/head';
import { CHAINS } from '@/lib/chains';
import { storedLine, type StoredSize } from '@/lib/format';

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

type Row = { name: string; chainId: number; address: string } & Partial<{ paper: number; footprint: number; control: boolean }>;

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

/** A collection's key in the lists: chain and lowercase address, as the store keeps them. */
const keyOf = (chainId: number, address: string) => `${chainId}/${address.toLowerCase()}`;

/**
 * One press watches a suggestion. `watched` holds `chainId/address` of every
 * watched collection; those link to their page instead. The list is the
 * paper's collections, then every other collection with stored data on the
 * Hub (`stored`, the manifest's sizes; null while none is cached). A row says
 * how big its stored data is, because watching downloads it.
 */
export function Suggested({ watched, stored }: { watched: string[]; stored: StoredSize[] | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said | null>(null);

  const suggested: readonly Row[] = SUGGESTED;
  const paper = new Set(suggested.map((s) => keyOf(s.chainId, s.address)));
  const rows: Row[] = [...suggested, ...(stored ?? []).filter((e) => !paper.has(keyOf(e.chainId, e.address)))];
  const extra = rows.length > suggested.length;
  const sizeOf = (r: Row) => stored?.find((e) => keyOf(e.chainId, e.address) === keyOf(r.chainId, r.address));

  async function add(s: Row) {
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
      <p className="text-xs text-muted-foreground">
        Suggested: collections from the term paper, each with a known answer to compare this reading against
        {stored !== null && extra ? ', and other collections whose stored data is on Hugging Face' : ''}.
      </p>
      <ul className="mt-2 divide-y rounded-md border">
        {rows.map((s) => {
          const key = `${s.chainId}/${s.address}`;
          const size = sizeOf(s);
          return (
            <li key={key} className="flex items-center gap-4 px-3 py-2">
              <div className="min-w-0 flex-1 md:flex md:items-baseline md:gap-4">
                <p className="font-medium text-foreground md:w-44 md:shrink-0">{s.name}</p>
                <div className="text-xs text-muted-foreground">
                  <p>{s.paper !== undefined && s.footprint !== undefined ? `${s.control ? 'Control: ' : ''}paper found ${Math.round(s.paper)}% washed · Footprint ${Math.round(s.footprint)}%` : 'Its stored data is on Hugging Face.'}</p>
                  {/* No line when the manifest has no entry for it: nothing is downloaded for it. */}
                  {stored === null ? <p>stored data: not known yet</p> : size ? <p>{storedLine(size)}</p> : null}
                </div>
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
export function AddCollection({ stored }: { stored: StoredSize[] | null }) {
  const router = useRouter();
  // What is typed, for the size of its stored data; the form itself is still read from its fields on submit.
  const [chain, setChain] = useState('1');
  const [typed, setTyped] = useState('');
  const size = stored?.find((e) => keyOf(e.chainId, e.address) === keyOf(Number(chain), typed.trim()));
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
        <select name="chainId" defaultValue="1" onChange={(e) => setChain(e.target.value)} className={FIELD}>
          {Object.entries(CHAINS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label className="flex max-w-full flex-col gap-0.5 text-xs text-muted-foreground">Contract
        <input name="address" required onChange={(e) => setTyped(e.target.value)} pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" className={`${FIELD} w-[23rem] max-w-full font-mono text-xs`} />
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">Name
        <input name="name" placeholder="optional" className={`${FIELD} w-36`} />
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">From block
        <input name="fromBlock" inputMode="numeric" pattern="\d*" placeholder="deployment" className={`${FIELD} w-28 font-mono text-xs`} />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>{busy ? 'Adding…' : 'Watch'}</button>
 {/* Watching it downloads this, so it is said before the press. */}
      {size ? <p className="basis-full text-xs text-muted-foreground">{storedLine(size)}</p> : null}
      {said ? <p role="status" className={said.ok ? 'basis-full text-xs text-ok' : 'basis-full text-xs text-fault'}>{said.ok ? null : <Warn className="mr-1 size-3.5 align-text-bottom" />}{said.text}</p> : null}
    </form>
  );
}

/** POST a JSON body to a collection's route. `{}` still counts: the routes refuse anything that is not JSON. */
async function send(method: string, path: string, body: unknown = {}): Promise<string | null> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (res?.ok) return null;
  const said = res ? await res.json().catch(() => ({})) : {};
  return said.error ?? 'The service did not answer.';
}

/**
 * What can be done with one watched collection. In sync: pause it (the worker
 * stops reading new blocks, its data stays) or move it up the worker's queue.
 * Paused: resume it, or delete its data, which asks inline first and is only
 * offered here because the API refuses to delete a collection still in sync.
 * `compact` is for a list row: no Prioritize, which lives on the collection's page.
 */
export function CollectionControls({ chainId, address, paused, priority, compact = false }: { chainId: number; address: string; paused: boolean; priority: boolean; compact?: boolean }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/collections/${chainId}/${address}`;

  async function run(method: string, to: string, body?: unknown, after?: () => void) {
    setBusy(true);
    setError(null);
    const failed = await send(method, to, body);
    setBusy(false);
    if (failed) { setError(failed); return; }
    if (after) after(); else router.refresh();
  }

  const fail = error ? <span role="alert" className="text-fault"><Warn className="mr-1 size-3.5 align-text-bottom" />{error}</span> : null;

  if (!paused) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" disabled={busy} onClick={() => run('POST', `${path}/pause`)} className={BUTTON}
          title="Stop reading new blocks for this collection; keeps its data">Pause</button>
        {compact ? null : <button type="button" disabled={busy} onClick={() => run('POST', `${path}/config`, { priority: !priority })} className={BUTTON}
          title={priority ? 'Go back to checking wallets in turn with the other collections' : "Check this collection's wallets for money before the others'"}>{priority ? 'Stop prioritizing' : 'Prioritize'}</button>}
        {fail}
      </span>
    );
  }
  if (!armed) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" disabled={busy} onClick={() => run('POST', `${path}/resume`)} className={BUTTON}
          title="Start reading new blocks for this collection again, from where it stopped">Resume</button>
        <button type="button" onClick={() => setArmed(true)} className={`${BUTTON} border-foreground`}
          title="Remove this collection's transfers and analyses from the store. Asks first.">Delete data…</button>
        {fail}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span>Delete its transfers and analyses? Wallet funding is kept. Watching it again starts over (or restores stored data).</span>
      <button type="button" disabled={busy} onClick={() => run('DELETE', path, {}, compact ? undefined : () => { router.push('/'); router.refresh(); })} className={`${BUTTON} border-foreground`}>Delete</button>
      <button type="button" onClick={() => { setArmed(false); setError(null); }} className={BUTTON}>Keep</button>
      {fail}
    </span>
  );
}
