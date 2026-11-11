'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Section, Warn } from '@/components/ui';
import { LOCAL_ONLY } from '@/lib/auth';
import { send } from '@/lib/send';
import { LENSES, STAGES, num, stageName, withoutKey } from '@/lib/format';
import { FIELDS, OPEN, variableOf, type FieldView } from '@/lib/settings';
import { FOLLOW_FANOUT } from '@washtrace/detect/lens-rule';

// Disabled reads as disabled by its dashed edge and grey fill, not by fading: a locked value must still be legible.
const INPUT = 'field font-mono text-xs disabled:cursor-not-allowed disabled:border-dashed disabled:bg-muted disabled:text-body';
const BTN = 'btn text-xs disabled:border-dashed disabled:bg-muted! disabled:text-body disabled:opacity-100!';
/** A text value, which needs the room; a number fits in a short box. */
const WIDE = 'w-full sm:w-80';

/** The settings that are on or off, drawn as a switch that saves on or off as it is flipped. */
const SWITCHES = new Set(['tokens.payees']);

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
  'follow.hops': `How many wallets out from the traders the worker follows money, for ${LENSES.AU.name}. More finds longer loops, and takes more calls. Lowering it stops reading wallets past the new limit, except on collections where a lens asked for more; a lens that needs them reads "at least".`,
  'follow.reread': "Read a trader's money and other tokens again when it trades, at most once every this many days. 0 is off. Each re-read is about 4 Etherscan calls, and the token read about 1 more. Turning it off stops new re-reads; any already due are read once.",
  // What it buys, what it costs, and what it never reads, with the fan-out the worker follows by.
  'stored.repo': 'The Hugging Face dataset (owner/name) the worker downloads stored data from. Change it only for a dataset of your own, laid out as the default one is.',
  'tokens.payees': `On, reading other tokens also reads the tokens of wallets your traders paid in the listed tokens, so a one-wallet token loop can be seen; up to ${FOLLOW_FANOUT} more reads per trader. `
    + `Not read: the payees of a trader that paid over ${FOLLOW_FANOUT} others or whose list was too long to read, and any marketplace, custodian, wrapped token or other contract washtrace knows, or the zero address.`,
};

/** A field's hint: its line in HINTS, or for another chain's RPC, which only .env sets, what it reads. */
function hintOf(field: FieldView): string | undefined {
  if (HINTS[field.key] !== undefined || !field.key.startsWith('rpc.')) return HINTS[field.key];
  return `Where the worker reads the blocks and transfers of collections on ${field.label.replace(/ RPC URL$/, '')}. Shown as the worker reported it.`;
}

/**
 * What not setting a source means; a number not set falls back to its
 * default instead. `trailFunded`: a collection's loaded money trail feeds the
 * money lenses, so no key does not stop them.
 */
function unset(key: string, trailFunded: boolean): string | undefined {
  if (key === 'rpc.1') return 'so the worker reads nothing from Ethereum.';
  if (key === 'etherscan.key') return trailFunded ? `so ${stageName(5)} needs a key: ${withoutKey(true)}.` : `so ${stageName(5)} needs a key, and ${withoutKey(false)}.`;
  return undefined;
}

/** The fields in groups, by the worker stage they feed; `id` is the group's anchor (/settings#rpc). */
const GROUPS = [
  {
    id: 'rpc',
    title: 'Where it reads the chain',
    lead: () => `${STAGES[3].title}, ${stageName(4)} for every collection, needs an RPC for each chain it reads. Without one, nothing newer is read. Ethereum's is set here; any other chain's in .env (WASHTRACE_RPC_ and the chain's id), and each one the worker reads is listed.`,
    keys: (k: string) => k.startsWith('rpc.'),
  },
  {
    id: 'money',
    title: 'Where it checks who paid whom',
    lead: (trailFunded: boolean) => `${STAGES[4].title}, ${stageName(5)} for every collection, needs an Etherscan key. It feeds ${MONEY}; without a key ${trailFunded ? 'they run only on stored money trails' : 'they do not run'}.`,
    keys: (k: string) => !k.startsWith('rpc.') && k !== 'stored.repo',
  },
  {
    id: 'stored',
    title: 'Where it downloads stored data',
    lead: () => `${STAGES[0].title}, ${stageName(1)} for every collection, fetches its transfers and money trail from a Hugging Face dataset, so its chain is read only from where they stop. A collection the dataset does not hold is read from the chain alone.`,
    keys: (k: string) => k === 'stored.repo',
  },
];

type Said = { ok: boolean; text: string };

/** POST /api/settings: save a value, or clear it with null. The error the API gave, or null. */
async function save(key: string, value: string | null): Promise<string | null> {
  return (await send('/api/settings', 'POST', { key, value })).error;
}

/**
 * Every setting the console offers, grouped by the worker stage it feeds.
 * Read-only says so once at the top, and every control is off; `open` (saving
 * needs no login) says so in the same place, so nobody is surprised.
 */
export function Settings({ fields, writable, open = false, trailFunded = false }: { fields: FieldView[]; writable: boolean; open?: boolean; trailFunded?: boolean }) {
  return (
    <div>
      {writable ? null : <p role="note" className="rounded-lg border bg-card px-4 py-3 text-sm text-body">{LOCAL_ONLY}</p>}
      {open ? <p role="note" className="rounded-lg border bg-card px-4 py-3 text-sm text-body">{OPEN}</p> : null}
      {GROUPS.map((g) => {
        const shown = fields.filter((f) => g.keys(f.key));
        return shown.length === 0 ? null : (
          <Section key={g.id} id={g.id} title={g.title} lead={g.lead(trailFunded)}>
            <div className="divide-y rounded-lg border bg-card">
              {shown.map((f) => <SettingField key={f.key} field={f} writable={writable} trailFunded={trailFunded} />)}
            </div>
          </Section>
        );
      })}
    </div>
  );
}

/** Where a value came from: .env, saved here (over .env when .env also sets it), or nothing. */
function sourceLine(f: FieldView, trailFunded: boolean): string {
  const fallback = FIELDS.find((x) => x.key === f.key)?.fallback;
  // The Etherscan URL while the key is .env's: only .env can set it, so say what .env does.
  if (f.pinned !== null) return f.source === 'env' ? `${f.pinned} From .env (${variableOf(f.key)}).` : `${f.pinned} Not set in .env (${variableOf(f.key)}), so the worker uses ${fallback ?? 'its default'}.`;
  if (f.source === 'console') return f.env !== null ? `Saved here, over .env (${variableOf(f.key)}).` : 'Saved here.';
  if (f.source === 'env') return `From .env (${variableOf(f.key)}).`;
  return `None: not saved here or in .env, ${unset(f.key, trailFunded) ?? (fallback ? `so the worker uses ${fallback}.` : 'so the worker uses its default.')}`;
}

/**
 * One setting: what it is for, its value (a secret only masked, with Replace
 * and Clear, or Reset to .env when .env also sets it), where the value came from, and a Test for a source. The
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
  // A switch shows its flip at once, before the refresh brings the saved value; a refused save puts it back.
  const [flipped, setFlipped] = useState<boolean | null>(null);
  // Every chain's RPC has a Test, a read-only one that only .env sets too: the worker tests the URL it reads.
  const check = field.key === 'etherscan.key' ? { kind: 'etherscan' as const }
    : field.key.startsWith('rpc.') ? { kind: 'rpc' as const, chainId: Number(field.key.slice(4)) } : null;
  const test = useTest(check);
  const fallback = FIELDS.find((x) => x.key === field.key)?.fallback;
  const id = `setting-${field.key}`;
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  /** .env also sets this field, so clearing what is saved here is a Reset to that value. */
  const reset = field.env !== null;
  const lockedWhy = writable ? (field.pinned ?? '') : LOCAL_ONLY;
  /** A button's accessible name: what it does, then which field. */
  const named = (verb: string, after = '') => `${verb} ${field.label}${after}`;

  /** Saves, or clears with null; whether it was saved. */
  async function put(value: string | null): Promise<boolean> {
    setBusy(true);
    setSaid(null);
    const failed = await save(field.key, value);
    setBusy(false);
    if (failed) { setSaid({ ok: false, text: failed }); return false; }
    setEditing(false);
    setArmed(false);
    setDraft('');
    if (value === null) setFlipped(null);
    const gone = reset ? "Back to the .env value from the worker's next pass." : field.secret ? 'The worker stops using it on its next pass.' : 'The worker goes back to its default on its next pass.';
    setSaid({ ok: true, text: value === null ? (reset ? gone : `Cleared. ${gone}`) : 'Saved. The worker uses it from its next pass, within a minute.' });
    // The refresh brings the new source line and, for a secret, its new last 4.
    router.refresh();
    return true;
  }

  // Only a value being typed has an input; otherwise the label is plain text naming the group.
  const hasInput = !field.secret || editing;
  // The worker reads only 'on' as on.
  const on = flipped ?? (field.shown ?? fallback) === 'on';

  const clearButton = field.source === 'console'
    ? <button type="button" disabled={field.locked} onClick={() => { setArmed(true); setSaid(null); }} aria-label={reset ? named('Reset', ' to its .env value…') : named('Clear', '…')} className={BTN}
      title={field.locked ? lockedWhy : reset ? 'Drop what is saved here so the worker uses .env again. Asks first.' : 'Remove it from the console. Asks first.'}>{reset ? 'Reset to .env…' : 'Clear…'}</button>
    : null;

  let value;
  if (armed) {
    value = (
      <span className="contents text-xs">
        <span className="basis-full text-xs">{reset
          ? `Reset the ${field.label} to its .env value? What is saved here is dropped, and the worker uses .env.`
          : `Clear the ${field.label}? ${unset(field.key, trailFunded) ? `Once cleared, ${unset(field.key, trailFunded)!.replace(/^so /, '')}` : 'The worker stops using it.'}`}</span>
        <button type="button" disabled={busy} onClick={() => put(null)} aria-label={reset ? named('Reset', ' to its .env value') : named('Clear')} className={`${BTN} border-foreground`}>{reset ? 'Reset' : 'Clear'}</button>
        <button type="button" onClick={() => { setArmed(false); setSaid(null); }} aria-label={named('Keep')} className={BTN}>Keep</button>
      </span>
    );
  } else if (SWITCHES.has(field.key)) {
    value = (
      <span className="contents">
        <input id={id} type="checkbox" role="switch" checked={on} disabled={field.locked || busy} aria-describedby={hintId} title={field.locked ? lockedWhy : undefined}
          onChange={async (e) => {
            const next = e.currentTarget.checked;
            setFlipped(next);
            if (!(await put(next ? 'on' : 'off'))) setFlipped(null);
          }}
          className="relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full border bg-muted transition-colors before:absolute before:top-1/2 before:left-0.5 before:size-3.5 before:-translate-y-1/2 before:rounded-full before:bg-card before:shadow-sm before:transition-transform checked:border-foreground checked:bg-foreground checked:before:translate-x-4 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:border-dashed" />
        <span aria-hidden className="text-xs font-medium text-foreground">{busy ? 'Saving…' : on ? 'On' : 'Off'}</span>
        {clearButton}
      </span>
    );
  } else if (!field.secret) {
    value = (
      <form className="contents" onSubmit={(e) => {
        e.preventDefault();
        const v = String(new FormData(e.currentTarget).get('value') ?? '').trim();
        void put(v === '' ? null : v);
      }}>
        <input id={id} name="value" key={field.shown ?? ''} defaultValue={field.shown ?? ''} placeholder={fallback} disabled={field.locked || busy}
          aria-describedby={hintId} title={field.locked ? lockedWhy : undefined} className={`${INPUT} ${field.key.endsWith('.url') || field.key === 'stored.repo' ? WIDE : 'w-24'} max-w-full`} />
        <button type="submit" disabled={field.locked || busy} aria-label={named('Save')} title={field.locked ? lockedWhy : `Save it; left empty, the worker goes back to ${reset ? 'the .env value' : 'its default'}`} className={BTN}>{busy ? 'Saving…' : 'Save'}</button>
        {clearButton}
      </form>
    );
  } else if (editing) {
    // Never prefilled: the browser never holds a saved secret, only one being typed.
    value = (
      <form className="contents" onSubmit={(e) => { e.preventDefault(); void put(draft.trim()); }}>
        <input id={id} name="value" autoFocus autoComplete="off" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} aria-describedby={hintId}
          placeholder={check?.kind === 'rpc' ? 'https://…' : 'As etherscan.io/myapikey shows it'} className={`${INPUT} ${WIDE} max-w-full`} />
        <button type="submit" disabled={busy || draft.trim() === ''} aria-label={named('Save')} className={BTN}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={() => { setEditing(false); setDraft(''); setSaid(null); }} aria-label={named('Cancel')} className={BTN}>Cancel</button>
      </form>
    );
  } else {
    value = (
      <span className="contents">
        {field.shown ? <span className="basis-full font-mono text-xs text-foreground [overflow-wrap:anywhere] sm:basis-auto">{field.shown}</span> : null}
        <button type="button" disabled={field.locked} onClick={() => { setEditing(true); setSaid(null); }} aria-label={named(field.set ? 'Replace' : 'Set')} className={BTN}
          title={field.locked ? lockedWhy : field.set ? 'Type a new value in place of this one' : 'Type a value for the worker to use'}>{field.set ? 'Replace' : 'Set'}</button>
        {clearButton}
      </span>
    );
  }

  const testWhy = !writable ? LOCAL_ONLY : !field.set ? 'Nothing to test: set it first.' : null;
  return (
    <div id={field.key} role="group" aria-labelledby={labelId} aria-describedby={hintId} className="scroll-mt-6 space-y-1.5 px-4 py-3 target:bg-muted/50">
      <div>
        {hasInput
          ? <label id={labelId} htmlFor={id} className="font-medium text-foreground">{field.label}</label>
          : <p id={labelId} className="font-medium text-foreground">{field.label}</p>}
        <p id={hintId} data-hint className="max-w-3xl text-xs text-muted-foreground">{hintOf(field)}</p>
      </div>
      {/* One row on a wide screen. On a phone a value or a field being typed takes its own line, and every button, Test too, shares the next. */}
      <div className="flex flex-wrap items-center gap-2">
        {value}
        {check
          ? <button type="button" data-test disabled={testWhy !== null || test.running} onClick={test.run} aria-label={named('Test')} className={BTN}
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
      <p>Finalized block {num(finalized)} · Archive reads <Mark ok={archive} /> · 50,000-block log reads <Mark ok={logs} /></p>
      {notes.length > 0 ? <p className="mt-0.5 text-muted-foreground">{notes.join(' ')}</p> : null}
    </div>
  );
}
