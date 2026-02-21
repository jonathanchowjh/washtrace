'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Section, Warn } from '@/components/head';
import { LENSES, withoutKey } from '@/lib/format';
import { FIELDS, READ_ONLY, variableOf, type FieldView } from '@/lib/settings';

const INPUT = 'rounded-[5px] border bg-card px-2 py-1 font-mono text-xs text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:opacity-60';
const BUTTON = 'rounded-[5px] border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent';

/** How often a Test is polled, and how long before the page stops waiting. The worker answers in about a second. */
const POLL_MS = 500;
const TEST_MS = 20_000;

const MONEY = `${LENSES.AU.name} and ${LENSES.AC.name}`;

/** What the worker uses each field for, one line each, so no field is a bare name. */
const HINTS: Record<string, string> = {
  'rpc.1': "Where the worker reads Ethereum's blocks and transfers. Every lens starts from what it reads here.",
  'etherscan.key': `Lets the worker see who paid whom, for the money lenses: ${MONEY}.`,
  'etherscan.rps': 'How many Etherscan calls the worker makes a second. Higher checks wallets sooner; above your plan\'s limit, Etherscan refuses calls.',
  'etherscan.url': 'Where the worker sends its Etherscan calls. Change it only for a proxy or an Etherscan-compatible API.',
  'follow.hops': `How many wallets out from the traders the worker follows money, for ${LENSES.AU.name}. More finds longer loops, and takes more calls.`,
};

/**
 * What not setting a source means; a number not set falls back to its
 * default instead. `trailFunded`: a collection's loaded money trail feeds the
 * money lenses, so no key no longer means they are off.
 */
function unset(key: string, trailFunded: boolean): string | undefined {
  if (key === 'rpc.1') return 'so the worker reads nothing from Ethereum.';
  if (key === 'etherscan.key') return trailFunded ? `so funding is off: ${withoutKey(true)}.` : `so funding is off, and ${withoutKey(false)}.`;
  return undefined;
}

/** The fields in groups, by the worker step they feed. */
const GROUPS = [
  {
    title: 'Where it reads the chain',
    lead: () => 'Read transfers, step 1 on the Worker page, needs an RPC for each chain it reads. Without one, nothing is read.',
    keys: (k: string) => k.startsWith('rpc.'),
  },
  {
    title: 'Where it checks who paid whom',
    lead: (trailFunded: boolean) => `Check wallets for money, step 2 on the Worker page, needs an Etherscan key. It feeds ${MONEY}; without a key ${trailFunded ? 'they run only on stored money trails' : 'those lenses are off'}.`,
    keys: (k: string) => !k.startsWith('rpc.'),
  },
];

type Said = { ok: boolean; text: string };

/** POST /api/settings: save a value, or clear it with null. The error the API gave, or null. */
async function save(key: string, value: string | null): Promise<string | null> {
  const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }) }).catch(() => null);
  if (res?.ok) return null;
  const said = res ? await res.json().catch(() => ({})) : {};
  return said.error ?? 'The service did not answer.';
}

/**
 * Every setting the console offers, grouped by the worker step it feeds.
 * Read-only says so once at the top, and every control is off.
 */
export function Settings({ fields, writable, trailFunded = false }: { fields: FieldView[]; writable: boolean; trailFunded?: boolean }) {
  return (
    <div className="max-w-3xl">
      {writable ? null : <p role="note" className="rounded-lg border bg-card px-4 py-3 text-sm text-body">{READ_ONLY}</p>}
      {GROUPS.map((g) => (
        <Section key={g.title} title={g.title} lead={g.lead(trailFunded)}>
          <div className="divide-y rounded-lg border bg-card">
            {fields.filter((f) => g.keys(f.key)).map((f) => <SettingField key={f.key} field={f} writable={writable} trailFunded={trailFunded} />)}
          </div>
        </Section>
      ))}
    </div>
  );
}

/** Where a value came from, and what that means for changing it here. */
function sourceLine(f: FieldView, trailFunded: boolean): string {
  if (f.source === 'env') return `Set by the environment (${variableOf(f.key)}), so it can't be changed here.`;
  if (f.source === 'console') return 'Set here.';
  const fallback = FIELDS.find((x) => x.key === f.key)?.fallback;
  return `Not set, ${unset(f.key, trailFunded) ?? (fallback ? `so the worker uses ${fallback}.` : 'so the worker uses its default.')}`;
}

/**
 * One setting: what it is for, its value (a secret only masked, with Replace
 * and Clear), where the value came from, and a Test for a source. The
 * container's id is the key, so /settings#rpc.1 lands on it. It is a group
 * named by its label and described by its hint, and every button's name
 * carries the field, so a screen reader never hears a bare "Replace". What a
 * save or a Test says lands in one live region that is always there, so it is
 * announced.
 */
function SettingField({ field, writable, trailFunded }: { field: FieldView; writable: boolean; trailFunded: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [draft, setDraft] = useState('');
  const check = field.key === 'etherscan.key' ? { kind: 'etherscan' as const } : field.key.startsWith('rpc.') ? { kind: 'rpc' as const, chainId: Number(field.key.slice(4)) } : null;
  const test = useTest(check);
  const fallback = FIELDS.find((x) => x.key === field.key)?.fallback;
  const id = `setting-${field.key}`;
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const lockedWhy = writable ? "Set by the environment, so it can't be changed here." : READ_ONLY;
  /** A button's accessible name: what it does, then which field. */
  const named = (verb: string, after = '') => `${verb} ${field.label}${after}`;

  async function put(value: string | null) {
    setBusy(true);
    setSaid(null);
    const failed = await save(field.key, value);
    setBusy(false);
    if (failed) { setSaid({ ok: false, text: failed }); return; }
    setEditing(false);
    setArmed(false);
    setDraft('');
    const gone = field.secret ? 'The worker stops using it on its next pass.' : 'The worker goes back to its default on its next pass.';
    setSaid({ ok: true, text: value === null ? `Cleared. ${gone}` : 'Saved. The worker uses it from its next pass, within a minute.' });
    // The refresh brings the new source line and, for a secret, its new last 4.
    router.refresh();
  }

  // Only a value being typed has an input; otherwise the label is plain text naming the group.
  const hasInput = !field.secret || editing;

  let value;
  if (!field.secret) {
    value = (
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
        e.preventDefault();
        const v = String(new FormData(e.currentTarget).get('value') ?? '').trim();
        void put(v === '' ? null : v);
      }}>
        <input id={id} name="value" key={field.shown ?? ''} defaultValue={field.shown ?? ''} placeholder={fallback} disabled={field.locked || busy}
          aria-describedby={hintId} title={field.locked ? lockedWhy : undefined} className={`${INPUT} ${field.key.endsWith('.url') ? 'w-80' : 'w-24'} max-w-full`} />
        <button type="submit" disabled={field.locked || busy} aria-label={named('Save')} title={field.locked ? lockedWhy : 'Save it; left empty, the worker goes back to its default'} className={BUTTON}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    );
  } else if (editing) {
    // Never prefilled: the browser never holds a saved secret, only one being typed.
    value = (
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void put(draft.trim()); }}>
        <input id={id} name="value" autoFocus autoComplete="off" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} aria-describedby={hintId}
          placeholder={check?.kind === 'rpc' ? 'https://…' : 'As etherscan.io/myapikey shows it'} className={`${INPUT} w-80 max-w-full`} />
        <button type="submit" disabled={busy || draft.trim() === ''} aria-label={named('Save')} className={BUTTON}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={() => { setEditing(false); setDraft(''); setSaid(null); }} aria-label={named('Cancel')} className={BUTTON}>Cancel</button>
      </form>
    );
  } else if (armed) {
    value = (
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <span>Clear the {field.label}? {unset(field.key, trailFunded) ? `Once cleared, ${unset(field.key, trailFunded)!.replace(/^so /, '')}` : 'The worker stops using it.'}</span>
        <button type="button" disabled={busy} onClick={() => put(null)} aria-label={named('Clear')} className={`${BUTTON} border-foreground`}>Clear</button>
        <button type="button" onClick={() => { setArmed(false); setSaid(null); }} aria-label={named('Keep')} className={BUTTON}>Keep</button>
      </span>
    );
  } else {
    value = (
      <span className="flex flex-wrap items-center gap-2">
        {field.shown ? <span className="font-mono text-xs text-foreground">{field.shown}</span> : null}
        <button type="button" disabled={field.locked} onClick={() => { setEditing(true); setSaid(null); }} aria-label={named(field.set ? 'Replace' : 'Set')} className={BUTTON}
          title={field.locked ? lockedWhy : field.set ? 'Type a new value in place of this one' : 'Type a value for the worker to use'}>{field.set ? 'Replace' : 'Set'}</button>
        {field.set && field.source === 'console'
          ? <button type="button" disabled={field.locked} onClick={() => { setArmed(true); setSaid(null); }} aria-label={named('Clear', '…')} className={BUTTON}
            title={field.locked ? lockedWhy : 'Remove it from the console. Asks first.'}>Clear…</button>
          : null}
      </span>
    );
  }

  const testWhy = !writable ? READ_ONLY : !field.set ? 'Nothing to test: set it first.' : null;
  return (
    <div id={field.key} role="group" aria-labelledby={labelId} aria-describedby={hintId} className="scroll-mt-6 space-y-1.5 px-4 py-3 target:bg-muted/50">
      <div>
        {hasInput
          ? <label id={labelId} htmlFor={id} className="font-medium text-foreground">{field.label}</label>
          : <p id={labelId} className="font-medium text-foreground">{field.label}</p>}
        <p id={hintId} data-hint className="text-xs text-muted-foreground">{HINTS[field.key]}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {value}
        {check
          ? <button type="button" data-test disabled={testWhy !== null || test.running} onClick={test.run} aria-label={named('Test')} className={BUTTON}
            title={testWhy ?? (check.kind === 'rpc'
              ? 'Ask the worker to read the finalized block, an old balance and 50,000 blocks of logs through this RPC'
              : 'Ask the worker to make one cheap Etherscan call with this key')}>{test.running ? 'Testing…' : 'Test'}</button>
          : null}
      </div>
      <div role="status" className="space-y-0.5 text-xs">
        {test.outcome ? <TestOutcome outcome={test.outcome} /> : null}
        {said
          ? <p className={said.ok ? 'text-ok' : 'flex items-start gap-1 text-fault'}>{said.ok ? null : <Warn className="mt-px size-3.5" />}{said.text}</p>
          : null}
      </div>
      <p className="text-xs text-muted-foreground">{sourceLine(field, trailFunded)}</p>
      {field.invalid
        ? <p className="flex items-start gap-1 text-xs text-fault"><Warn className="mt-px size-3.5" />Ignored: {field.invalid.replace(/\.$/, '')}. The worker uses {fallback ?? 'its default'}.</p>
        : null}
    </div>
  );
}

type Outcome =
  | { rpc: { finalized: number; archive: boolean; logs: boolean } }
  | { etherscan: true }
  | { error: string }
  | { timeout: true };

/** The ✓ or ✗ for one part of an RPC check. */
function Mark({ ok }: { ok: boolean }) {
  return ok ? <span className="text-ok">✓</span> : <span className="text-fault">✗</span>;
}

/**
 * Test: asks the worker to check a source (the API never calls a chain), then
 * polls for its answer every 500 ms. One 20 s deadline covers it all, so a
 * request that never answers ends too; it aborts whatever is still in flight.
 * Leaving the page aborts it the same way. `request` null: nothing to test.
 */
function useTest(request: { kind: 'rpc'; chainId: number } | { kind: 'etherscan' } | null) {
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => {
    abort.current?.abort();
    clearTimeout(timer.current);
    clearTimeout(deadline.current);
  }, []);

  /** A finished check's detail as an outcome: the worker's sanitised error, or what it found. */
  function answered(detail: Record<string, unknown>): Outcome {
    if (typeof detail.error === 'string') return { error: detail.error };
    if (request?.kind === 'etherscan') return { etherscan: true };
    return { rpc: { finalized: Number(detail.finalized), archive: detail.archive === true, logs: detail.logs === true } };
  }

  async function run() {
    if (request === null) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    let id: number | null = null;
    const finish = (o: Outcome) => {
      if (ctrl.signal.aborted) return;
      ctrl.abort();
      clearTimeout(timer.current);
      clearTimeout(deadline.current);
      setOutcome(o);
      setRunning(false);
    };
    setRunning(true);
    setOutcome(null);
    // Without an id the API never answered; with one, the worker never did.
    deadline.current = setTimeout(() => finish(id === null ? { error: 'The service did not answer in 20 s.' } : { timeout: true }), TEST_MS);
    const res = await fetch('/api/settings/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: ctrl.signal }).catch(() => null);
    const asked = res ? await res.json().catch(() => ({})) : {};
    if (ctrl.signal.aborted) return;
    if (!res?.ok) { finish({ error: asked.error ?? 'The service did not answer.' }); return; }
    id = asked.id;
    const poll = () => {
      timer.current = setTimeout(async () => {
        const r = await fetch(`/api/settings/check/${id}`, { signal: ctrl.signal }).catch(() => null);
        const body = r ? await r.json().catch(() => null) : null;
        if (ctrl.signal.aborted) return;
        // A refusal (403, 404) will not change by asking again; a dropped request might.
        if (r && !r.ok) { finish({ error: body?.error ?? `The service answered ${r.status}.` }); return; }
        if (body?.finished) { finish(answered(body.detail ?? {})); return; }
        poll();
      }, POLL_MS);
    };
    poll();
  }

  return { running, outcome, run };
}

/** What a Test found, in the field's live region. */
function TestOutcome({ outcome }: { outcome: Outcome }) {
  if ('timeout' in outcome) {
    return (
      <p className="flex items-start gap-1 text-fault">
        <Warn className="mt-px size-3.5" />
        <span>No answer in 20 s. The worker runs tests: is it running? See <Link href="/worker" className="underline">Worker</Link>.</span>
      </p>
    );
  }
  if ('error' in outcome) {
    return <p className="flex items-start gap-1 text-fault"><Warn className="mt-px size-3.5" />{outcome.error}</p>;
  }
  if ('etherscan' in outcome) {
    return <p className="text-foreground">Etherscan answered <Mark ok /></p>;
  }
  const { finalized, archive, logs } = outcome.rpc;
  const notes = [
    archive ? null : 'No archive reads, so the worker can\'t find a collection\'s first block.',
    logs ? null : 'Log ranges too small, so reading is slower.',
  ].filter((n) => n !== null);
  return (
    <div className="text-foreground">
      <p>Finalized block {finalized.toLocaleString('en')} · Archive reads <Mark ok={archive} /> · 50,000-block log reads <Mark ok={logs} /></p>
      {notes.length > 0 ? <p className="mt-0.5 text-muted-foreground">{notes.join(' ')}</p> : null}
    </div>
  );
}
