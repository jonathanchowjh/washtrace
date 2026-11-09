'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { checkRule, depthNeeded, nameError, type LensRule } from '@washtrace/detect/lens-rule';
import { estimateTo, moneyReason, tokensReason } from '@washtrace/detect/lens-reads';
import { LOCAL_ONLY } from '@/lib/auth';
import type { Method } from '@washtrace/detect';
import { LENSES } from '@/lib/format';
import { DataNeeds } from './data-needs';
import { send } from './lens-actions';
import { Preview } from './preview';
import { RuleTable } from './rule-table';

const BUTTON = 'rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The form that makes or changes a lens of yours, shown in the place of the
 * selected tab's panel. `rule` is only where it starts: the form edits its own
 * copy, so the built-ins' copies and the default rule it may be handed are
 * never changed. The rule is checked here before it is sent, and the server
 * checks it again. `selected` is the tab Cancel goes back to; `lensId` is set
 * when an existing lens is being edited.
 */
export function LensEditor({ base, chainId, address, selected, title, name: startName, rule: startRule, differs, lensId, writable, notFinal, funded, needs }: {
  base: string; chainId: number; address: string; selected: string;
  /** What the readiness strip compares the rule with: what is read of this collection, and the numbers it is priced by. */
  needs: Omit<Parameters<typeof DataNeeds>[0], 'rule' | 'estimate' | 'writable' | 'chainId' | 'address'>;
  /** Which built-ins' money is not final, and whether the next analysis has funding: Preview reads "at least" by them, as the page does. */
  notFinal: readonly Method[]; funded: boolean;
  /** What is being made, in words: "New lens", "Copy of Round trips", or the name of the lens being edited. */
  title: string;
  name: string; rule: LensRule;
  /** How far a copy of a built-in is from it, or null. */
  differs: string | null;
  lensId?: number; writable: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(startName);
  const [rule, setRule] = useState(() => structuredClone(startRule));
  // The latest rule, readable in the same tick a blur sets it: a field commits on blur, state would still be the old one.
  const latest = useRef(rule);
  const change = (next: LensRule) => { latest.current = next; setRule(next); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal takes the focus, so a screen reader says it and Tab goes on from it rather than from the top of the page.
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error !== null) alert.current?.focus(); }, [error]);

  /** Enter submits while a field still has focus; blurring it first makes it commit what is typed. */
  function submit() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    void save(latest.current);
  }

  async function save(rule: LensRule) {
    const trimmed = name.trim();
    const refused = nameError(trimmed);
    if (refused !== null) return setError(refused);
    const checked = checkRule(rule);
    if ('error' in checked) return setError(checked.error);
    setError(null);
    setBusy(true);
    const said = await send<{ lens: { key: string } }>(
      lensId === undefined ? '/api/lenses' : `/api/lenses/${lensId}`, lensId === undefined ? 'POST' : 'PATCH',
      // The collection goes with an edit too, so its run is queued here, as the button says.
      { name: trimmed, rule: checked.rule, chainId, address },
    );
    setBusy(false);
    if (said.error !== null) return setError(said.error);
    router.push(`${base}?method=${said.body.lens.key}#evidence`);
    router.refresh();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-5" aria-label={`${title}, editing`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium">{title}</h3>
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">yours · editing</span>
      </div>
      {differs ? <p className="text-sm text-muted-foreground">{differs}</p> : null}
      <label className="block text-sm">
        <span className="font-medium">Name</span>
        <span className="ml-2 text-xs text-muted-foreground">what the tab, the filters and the lists call this lens</span>
        <input type="text" className="field mt-1 block w-full max-w-md disabled:opacity-60" value={name} disabled={!writable}
          onChange={(e) => setName(e.target.value)} />
      </label>

      <p className="text-sm text-muted-foreground">
        Every loop starts with the trade: the NFT goes from seller → buyer. A lens says which edges may carry the way back to the seller, in which direction, and how much of each.
      </p>

      <RuleTable rule={rule} onChange={writable ? change : undefined} />

      {/* The estimate is cut to the unsaved rule here, so it follows each edit to the hops. */}
      <DataNeeds rule={rule} estimate={estimateTo(needs.money.estimate, depthNeeded(rule))} writable={writable} chainId={chainId} address={address} {...needs} />

      {/* A preview reads the money as it is now, so no run of it is behind what was fetched: no 'behind'. */}
      <Preview chainId={chainId} address={address} rule={rule} roundTripsName={LENSES.A.name} notFinal={notFinal} funded={funded} funding={needs.funding} money={moneyReason(rule, needs.money, needs.followHops, false)}
        tokens={{ reason: tokensReason(rule, needs.tokens.started, needs.tokens.counts, needs.tokens.counts?.read ?? null), payees: needs.tokens.counts?.payees ?? needs.tokens.payees }} writable={writable} />

      {writable ? null : <p className="text-xs text-muted-foreground">{LOCAL_ONLY}</p>}
      {error ? <p ref={alert} role="alert" tabIndex={-1} className="text-sm text-fault">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} disabled={busy} title="Leave without saving" onClick={() => router.push(`${base}?method=${selected}`)}>Cancel</button>
        <button type="submit" className={BUTTON} disabled={!writable || busy}
          title={writable ? 'Save this lens, then queue its run on this collection' : LOCAL_ONLY}>Save and run</button>
      </div>
    </form>
  );
}
