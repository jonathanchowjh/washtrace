import type { ReactNode } from 'react';
import { EDGE_TYPES, type EdgeKind, type EdgeRule, type LensRule } from '@washtrace/detect/lens-rule';
import { ethToWei, weiToEth } from '@/lib/trades-url';
import { cn } from '@/lib/utils';

const CONTROL = 'rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-60';

/**
 * A lens's rule as a table: one row per edge type, then the rest of the rule.
 * Without `onChange` it is read-only (a built-in's rule, shown under its tab)
 * and every control is disabled. With it, the editor gets a fresh copy of the
 * rule on each change, so the rule it holds is never mutated; a typed value
 * is taken when the field loses focus, so half a number is never refused.
 *
 * It holds no state and no 'use client': a handler is attached only when
 * editing, which only the client-side editor does.
 */
export function RuleTable({ rule, onChange }: { rule: LensRule; onChange?: (rule: LensRule) => void }) {
  const locked = onChange === undefined;
  /** A handler that edits a copy of the rule; none when read-only, as a server render cannot carry one. */
  const edit = <E,>(apply: (draft: LensRule, e: E) => void) => locked ? undefined : (e: E) => {
    const draft = structuredClone(rule);
    apply(draft, e);
    onChange(draft);
  };
  const edge = (kind: EdgeKind, apply: (row: EdgeRule, e: string) => void) => edit<string>((d, v) => apply(d.edges[kind], v));
  const fromSelect = (h: ((v: string) => void) | undefined) => h && ((e: { target: { value: string } }) => h(e.target.value));

  return (
    <div className="space-y-6 text-sm">
      <section aria-labelledby="rule-edges" className="overflow-x-auto">
        <h3 id="rule-edges" className="mb-1 font-medium">1 · Edges that may close the loop</h3>
        <table className="w-full min-w-[34rem] text-left">
          <caption className="mb-1 text-left text-xs text-muted-foreground">Which transfers can carry a sale back to its seller, in which direction, and how much of each</caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">Use</th>
              <th scope="col" className="py-1 pr-3 font-medium">Edge type</th>
              <th scope="col" className="py-1 pr-3 font-medium">Direction in the loop</th>
              <th scope="col" className="py-1 pr-3 font-medium">At most in a loop</th>
              <th scope="col" className="py-1 pr-3 font-medium">Smallest that counts</th>
              <th scope="col" className="py-1 font-medium">Repeats between the same 2 wallets</th>
            </tr>
          </thead>
          <tbody>
            {EDGE_TYPES.map(({ kind, label, money, unavailable }) => {
              const e = rule.edges[kind];
              const dead = unavailable !== null;
              return (
                <tr key={kind} className={cn('border-t align-top', dead && 'text-muted-foreground')}>
                  <td className="py-1.5 pr-3">
                    <input type="checkbox" aria-label={`Follow ${label}`} checked={e.use} disabled={locked || dead}
                      onChange={edit<unknown>((d) => { d.edges[kind].use = !d.edges[kind].use; })} />
                  </td>
                  <td className="py-1.5 pr-3">
                    {label}
                    {dead ? <span className="block text-xs">{unavailable}</span> : null}
                  </td>
                  <td className="py-1.5 pr-3">
                    <select aria-label={`${label}: direction`} className={CONTROL} value={e.direction} disabled={locked || dead}
                      onChange={fromSelect(edge(kind, (row, v) => { row.direction = v as EdgeRule['direction']; }))}>
                      <option value="along">follows arrows</option>
                      <option value="either">either way</option>
                    </select>
                  </td>
                  <td className="py-1.5 pr-3">
                    <Count label={`${label}: most edges of this type in one loop`} value={e.max} none="no limit" disabled={locked || dead}
                      onCommit={edge(kind, (row, v) => { row.max = v === '' ? null : Number(v); })} />
                  </td>
                  <td className="py-1.5 pr-3">
                    {kind === 'other-tokens' ? (
                      // Tokens differ in value and washtrace has no prices, so a raw-unit floor means one thing at 6 decimals and another at 18 (T9): checkRule refuses one.
                      <span className="text-muted-foreground">Any amount: tokens differ in value</span>
                    ) : money ? (
                      <Field label={`${label}: smallest payment counted, in ETH`} text={e.minWei === null ? '' : weiToEth(e.minWei)} none="any" disabled={locked || dead}
                        onCommit={edge(kind, (row, v) => { const wei = v === '' ? null : ethToWei(v); if (v === '' || wei !== null) row.minWei = wei; })} />
                    ) :<span aria-hidden>&mdash;</span>}
                  </td>
                  <td className="py-1.5">
                    <select aria-label={`${label}: repeats`} className={CONTROL} value={e.repeats} disabled={locked || dead}
                      onChange={fromSelect(edge(kind, (row, v) => { row.repeats = v as EdgeRule['repeats']; }))}>
                      <option value="each">count each</option>
                      <option value="once">count once</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="rule-whole">
      <h3 id="rule-whole" className="mb-2 font-medium">2 · The loop as a whole</h3>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,18rem)_1fr]">
        <Row term="Hops back to the seller">
          <Count label="Fewest wallets between the seller and the buyer" value={rule.hops.min} none="0" disabled={locked}
            onCommit={edit<string>((d, v) => { d.hops.min = Number(v || 0); })} />
          {' to '}
          <Count label="Most wallets between the seller and the buyer" value={rule.hops.max} none="any" disabled={locked}
            onCommit={edit<string>((d, v) => { d.hops.max = v === '' ? null : Number(v); })} />
        </Row>
        <Row term="Loop closes at">
          <select aria-label="Where a loop closes" className={CONTROL} value={rule.closes} disabled={locked}
            onChange={fromSelect(edit<string>((d, v) => { d.closes = v as LensRule['closes']; }))}>
            <option value="seller">the seller</option>
            <option value="seller-or-funder">the seller, or a wallet that funded the seller</option>
          </select>
          {rule.window?.side === 'after' && rule.closes === 'seller-or-funder'
            ? <p className="mt-1 text-xs text-muted-foreground">With the window on the after side, no wallet counts as a funder (a funder pays before the trade), so closing at a funder acts as closing at the seller.</p>
            : null}
        </Row>
        <Row term="Every edge happens within">
          <Count label="Days from the trade within which an edge counts" value={rule.window?.days ?? null} none="any time" disabled={locked}
            onCommit={edit<string>((d, v) => { d.window = v === '' ? null : { days: Number(v), side: d.window?.side ?? 'either' }; })} />
          {' days, on '}
          <select aria-label="Which side of the trade the window covers" className={CONTROL} value={rule.window?.side ?? 'either'} disabled={locked || rule.window === null}
            onChange={fromSelect(edit<string>((d, v) => { if (d.window) d.window.side = v as 'after' | 'before' | 'either'; }))}>
            <option value="either">either side</option>
            <option value="after">the after side</option>
            <option value="before">the before side</option>
          </select>
        </Row>
        <Row term="Order in time">
          <select aria-label="Whether the edges must follow each other in time" className={CONTROL} value={rule.order} disabled={locked}
            onChange={fromSelect(edit<string>((d, v) => { d.order = v as LensRule['order']; }))}>
            <option value="any">any order</option>
            <option value="loop">each no earlier than the one before</option>
          </select>
        </Row>
        <Row term="At least N loops among the wallets involved">
          <Count label="Fewest loops among the wallets involved for a trade to be flagged" value={rule.minCycles} none="1" disabled={locked}
            onCommit={edit<string>((d, v) => { d.minCycles = Number(v || 1); })} />
        </Row>
        <Row term="Which trades it judges">
          <select aria-label="What a share of the lens counts" className={CONTROL} value={rule.judges} disabled={locked}
            onChange={fromSelect(edit<string>((d, v) => { d.judges = v as LensRule['judges']; }))}>
            <option value="sales">sales</option>
            <option value="owners">every change of owner</option>
          </select>
        </Row>
        <Row term="Never a middle wallet">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={rule.never.marketplaces} disabled={locked}
              onChange={edit<unknown>((d) => { d.never.marketplaces = !d.never.marketplaces; })} />
            marketplace contracts
          </label>
          <label className="mt-1 flex flex-wrap items-center gap-2">
            Wallets linked to more than
            <Count label="Wallets linked to more than this many of this collection's wallets are never passed through" value={rule.never.over} none="no limit" disabled={locked}
              onCommit={edit<string>((d, v) => { d.never.over = v === '' ? null : Number(v); })} />
            of this collection&rsquo;s wallets (exchanges, routers)
          </label>
          <label className="mt-1 block">
            <span className="text-xs text-muted-foreground">These addresses, one per line</span>
            <textarea aria-label="Addresses a loop never passes through" rows={2} className={cn(CONTROL, 'mt-0.5 block w-full font-mono text-xs')}
              key={rule.never.addresses.join(',')} defaultValue={rule.never.addresses.join('\n')} disabled={locked}
              onBlur={edit<{ target: { value: string } }>((d, e) => { d.never.addresses = e.target.value.split(/[\s,]+/).filter(Boolean); })} />
          </label>
        </Row>
      </dl>
      </section>
    </div>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** A typed text value, taken when the field loses focus; a value `onCommit` does not change is put back as it was. */
function Field({ label, text, none, disabled, onCommit }: {
  label: string; text: string; none: string; disabled: boolean; onCommit: ((v: string) => void) | undefined;
}) {
  return (
    <input type="text" inputMode="decimal" aria-label={label} placeholder={none} className={cn(CONTROL, 'w-24')}
      key={text} defaultValue={text} disabled={disabled}
      onBlur={onCommit && ((e) => { const v = e.target.value.trim(); if (v === '' || /^\d*\.?\d*$/.test(v)) onCommit(v); else e.target.value = text; })} />
  );
}

/** A whole number, or empty for `none`. */
function Count({ label, value, none, disabled, onCommit }: {
  label: string; value: number | null; none: string; disabled: boolean; onCommit: ((v: string) => void) | undefined;
}) {
  const text = value === null ? '' : String(value);
  return (
    <input type="text" inputMode="numeric" aria-label={label} placeholder={none} className={cn(CONTROL, 'w-20')}
      key={text} defaultValue={text} disabled={disabled}
      onBlur={onCommit && ((e) => { const v = e.target.value.trim(); if (v === '' || /^\d+$/.test(v)) onCommit(v); else e.target.value = text; })} />
  );
}
