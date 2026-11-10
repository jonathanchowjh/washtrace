'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SpotResult, Witness } from '@washtrace/detect';
import { LOCAL_ONLY } from '@/lib/auth';
import { SPOT_AT_LEAST, SPOT_CHECKING, SPOT_NOT_FINAL, SPOT_ONLY, SPOT_STORED, andList, short, tokenLabel } from '@/lib/format';
import { send } from '@/lib/send';

const POLL_MS = 1000;
const BUILT_IN: Record<string, string> = { A: 'Round trips', AU: 'Money loops back', AC: 'Linked wallets' };

type Flag = SpotResult['transfers'][number]['flags'][string];

/** The wallets a flag names, for links: a pair and its middle, a component's wallets, or a lens's loop. */
function walletsOf(f: Flag): string[] {
  if ('kind' in f) {
    const w = f as Witness;
    return w.kind === 'pair' ? [...w.pair, ...(w.middle === null ? [] : [w.middle])] : w.wallets;
  }
  return f.wallets;
}

/** One line of why a lens flagged a transfer, in a spot check's own words: it has no collection page to point at. */
function whyOf(f: Flag): string {
  if (!('kind' in f)) return `a loop through ${f.wallets.length} wallets`;
  const w = f as Witness;
  if (w.kind === 'pair') return w.middle === null ? 'the seller and the buyer paid each other' : 'the seller and the buyer are joined by money through one wallet';
  return `the token went round ${w.cycles} times among ${w.wallets.length} wallets`;
}

/**
 * Check a transaction washtrace has not read, or not judged, without
 * watching its collection: POST /api/spots, then poll the check every second
 * while it is queued or running. A stored answer comes back at once. A
 * failed poll is asked again; only a 404 (the check is gone) or a failed
 * check ends it, and a failed one can be tried again.
 */
export function SpotCheck({ chainId, tx, lenses, writable }: {
  chainId: number; tx: string;
  /** Your lenses, each with why a spot check cannot run it (null: it can). */
  lenses: { key: string; name: string; refusal: string | null }[];
  /** This console may write: a check queues a row, so it is refused as a save is. */
  writable: boolean;
}) {
  const [lens, setLens] = useState('');
  const [id, setId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<SpotResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (id === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const res = await fetch(`/api/spots/${id}`).catch(() => null);
      const said = res ? await res.json().catch(() => null) : null;
      if (stopped) return;
      if (res?.status === 404) { setLost(false); setStatus(null); setError(said?.error ?? 'This check is gone. Ask again.'); return; }
      if (!res?.ok || typeof said?.status !== 'string') { setLost(true); timer = setTimeout(poll, POLL_MS); return; }
      setLost(false);
      setStatus(said.status);
      if (said.status === 'done') setResult(said.result);
      else if (said.status === 'failed') setError(said.error ?? 'The check failed.');
      else timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id]);

  async function start() {
    setError(null); setResult(null); setStatus(null); setLost(false); setId(null); setBusy(true);
    const said = await send<{ id?: number; status: string; result?: SpotResult }>('/api/spots', 'POST', { chainId, tx, ...(lens === '' ? {} : { lens }) });
    setBusy(false);
    if (said.error !== null) { setError(said.error); return; }
    if (said.body.status === 'done' && said.body.result) { setStatus('done'); setResult(said.body.result); return; }
    setStatus(said.body.status);
    setId(said.body.id ?? null);
  }

  const nameOf = (key: string) => BUILT_IN[key] ?? lenses.find((l) => l.key === key)?.name ?? key;
  const running = busy || lost || status === 'queued' || status === 'running';
  const flagged = result?.transfers.filter((t) => Object.keys(t.flags).some((k) => result.methods.includes(k))) ?? [];
  const failed = status === 'failed' || (error !== null && id !== null);
  return (
    // A card set off from the answer above it: a form of its own, not more of the verdict.
    <section aria-labelledby="spot-check" className="mt-6 space-y-3 rounded-lg border bg-card p-4 sm:p-5">
      <h2 id="spot-check" className="text-base font-semibold">Check this transaction</h2>
      <p className="text-sm text-muted-foreground">
        Reads only this transaction: its tokens&apos; histories and the money of its sellers and buyers. Nothing is watched.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm" htmlFor="spot-lens">Judge with</label>
        <select id="spot-lens" className="field text-sm" value={lens}
          onChange={(e) => { setLens(e.target.value); setResult(null); setError(null); setStatus(null); }} disabled={running}>
          <option value="">Built-in methods</option>
          {lenses.map((l) => (
            <option key={l.key} value={l.key} disabled={l.refusal !== null} title={l.refusal ?? undefined}>
              {l.refusal === null ? l.name : `${l.name} (${l.refusal})`}
            </option>
          ))}
        </select>
        <button type="button" className="btn text-sm"
          disabled={!writable || running} title={writable ? undefined : LOCAL_ONLY} onClick={start}>Check this transaction</button>
        {running && !lost ? <span aria-live="polite" className="text-sm">{SPOT_CHECKING}</span> : null}
      </div>
      {lost ? <p className="text-xs text-muted-foreground">Lost touch with the service; trying again every second.</p> : null}
      {error !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-fault">{error}</p>
          {failed ? <button type="button" className="btn text-xs" disabled={!writable} onClick={start}>Try again</button> : null}
        </div>
      ) : null}
      {result !== null ? (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">
            {result.washTrade === true ? `Flagged as a wash trade by ${andList(result.methods.map(nameOf))}.`
              : result.washTrade === false ? 'Not flagged: every lens asked ran on every trade, and none flagged it.'
              : result.atLeast ? SPOT_AT_LEAST
              : `Not judged: ${andList(result.notRun.filter((k) => k !== 'AU').map(nameOf))} could not run.`}
          </p>
          {result.washTrade !== null && result.atLeast ? <p>{SPOT_AT_LEAST}</p> : null}
          {flagged.length > 0 ? (
            <ul className="space-y-1">
              {flagged.map((t) => (
                <li key={`${t.collection}:${t.logIndex}`}>
                  <span className="font-mono">#{tokenLabel(t.tokenId)}</span>:{' '}
                  {Object.entries(t.flags).filter(([k]) => result.methods.includes(k)).map(([k, f]) => (
                    <span key={k}>
                      {nameOf(k)}: {whyOf(f)} (
                      {walletsOf(f).map((a, i) => (
                        <span key={a}>{i > 0 ? ', ' : ''}<Link className="font-mono underline" href={`/w/${chainId}/${a}`} prefetch={false}>{short(a)}</Link></span>
                      ))}
                      ){' '}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
          {result.notRun.length > 0 ? <p className="text-muted-foreground">Not run here: {andList(result.notRun.map(nameOf))}.</p> : null}
          {!result.finalized ? <p className="text-muted-foreground">{SPOT_NOT_FINAL}</p> : null}
          <p className="text-muted-foreground">{result.source === 'spot' ? SPOT_ONLY : SPOT_STORED}</p>
        </div>
      ) : null}
    </section>
  );
}
