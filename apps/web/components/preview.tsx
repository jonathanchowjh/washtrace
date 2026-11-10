'use client';

import { useEffect, useState } from 'react';
import type { Method, Preview as PreviewRow } from '@washtrace/detect';
import { checkRule, type LensRule } from '@washtrace/detect/lens-rule';
import { LOCAL_ONLY } from '@/lib/auth';
import { floorPct, num, pctTenth } from '@/lib/format';
import type { MoneyReason } from '@washtrace/detect/lens-reads';
import { shareCauses, shareQualifier, type TokensFloor } from '@/lib/lens-state';
import { send } from '@/lib/send';

const POLL_MS = 1000;

/** The finished preview's one line: the lens's share of the sample, Round trips' of the same sales, and where most were caught. */
function resultLine(p: PreviewRow, roundTripsName: string, notFinal: readonly Method[], funded: boolean, funding: boolean, money: MoneyReason | null, tokens: TokensFloor): string {
  const r = p.result!;
  // Not r.atLeast: that covers cut searches and untimed trades only, and a money lens is weaker too while its funding is not final.
  // Untimed trades are out of the judged base already, so they are not a cause of a floor here.
  const qualifier = shareQualifier(shareCauses(p.rule, { truncated: r.truncated, untimed: 0 }, notFinal, funded, funding, money, tokens));
  // A sampled sale the token graph folds away or the rule skips is never judged, so the share is of those judged; a row from before `judged` was kept counts them all.
  const judged = r.judged ?? r.sampled;
  const all = judged === r.sampled;
  // "at least" leads the figure; "so far" closes the phrase that says what the figure is of.
  const caught = `Caught ${qualifier === 'at least' ? 'at least ' : ''}${pctTenth(r.caught, judged)} of`;
  const soFar = qualifier === 'so far' ? ' so far' : '';
  const parts = [all ? `${caught} ${r.sampled === r.ofSales ? 'all ' : ''}${num(r.sampled)} sales sampled${soFar}` : `${caught} ${num(judged)} sales judged from ${num(r.sampled)} sampled${soFar}`];
  // Round trips has no window, so it judges every sampled sale with a hop, and only such a sale can be flagged by it. A row from before `hops` was kept falls back to `judged`, which may not be Round trips' base.
  const hops = r.hops ?? judged;
  if (r.roundTrips) parts.push(`${roundTripsName} caught ${pctTenth(r.roundTrips.caught, hops)} of ${hops === judged ? 'the same sales' : `the ${num(hops)} sales it judged`}`);
  if (r.topMarket) parts.push(`Most caught on ${r.topMarket.name} (${num(r.topMarket.caught)})`);
  return parts.join(' · ');
}

/**
 * The editor's Preview: tries the rule as it stands, unsaved, on a sample of
 * this collection's sales, so a lens can be judged before it is saved. The
 * worker does the work (a queued row), so this asks for it and polls the row
 * every second while it is queued or running; a failed poll (including a 200
 * whose body is no preview row) is asked again, and only a 404 (the row is gone) ends it. `notFinal`, `funded`, `funding` and `money` are the
 * collection page's, so the share carries the same word a saved
 * lens's does. A result stays after the rule changes, marked as from before.
 */
export function Preview({ chainId, address, rule, roundTripsName, notFinal, funded, funding, money, tokens, writable = true }: {
  chainId: number; address: string; rule: LensRule; roundTripsName: string;
  /** This console may write: a preview queues a row, so it is refused as a save is. */
  writable?: boolean;
  /** The built-ins whose money is not final yet, as the collection page has them. */
  notFinal: readonly Method[];
  /** moneyReason of this rule against what is read of the collection's money. */
  money: MoneyReason | null;
  /** tokensReason of this rule against what is read of the collection's other tokens (a preview is never behind a run). */
  tokens: TokensFloor;
  /** The collection has funding for the money lenses to run on. */
  funded: boolean;
  /** An Etherscan key is set: what checks the wallets still unchecked. */
  funding: boolean;
}) {
  const [id, setId] = useState<number | null>(null);
  const [row, setRow] = useState<PreviewRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The rule as it was sent, so a later edit can tell the result is from before it.
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The last poll failed with no word that the preview is gone: polling goes on.
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (id === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const res = await fetch(`/api/lenses/previews/${id}`).catch(() => null);
      // A body that is no JSON, such as a proxy's error page, is a failed poll like no answer at all.
      const said = res ? await res.json().catch(() => null) : null;
      if (stopped) return;
      if (res?.status === 404) {
        // Swept, or its collection removed: there is no row any more, so nothing to wait for.
        setRow(null);
        setLost(false);
        setError(said?.error ?? 'This preview is gone. Run it again.');
        return;
      }
      if (!res?.ok || typeof said?.status !== 'string') {
        // A restart, a 500 or a blip: the worker's preview does not depend on this page, so keep what was last read and ask again.
        setLost(true);
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      setLost(false);
      setRow(said);
      if (said.status === 'queued' || said.status === 'running') timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id]);

  async function start() {
    const checked = checkRule(rule);
    if ('error' in checked) { setError(checked.error); return; }
    setError(null);
    setRow(null);
    setLost(false);
    setId(null);
    setBusy(true);
    const said = await send<{ id: number }>('/api/lenses/previews', 'POST', { chainId, address, rule: checked.rule });
    setBusy(false);
    if (said.error !== null) { setError(said.error); return; }
    setSent(JSON.stringify(rule));
    setId(said.body.id);
  }

  // Still polling counts as running, so a lost poll does not invite a second preview's full load.
  const running = busy || lost || row?.status === 'queued' || row?.status === 'running';
  const stale = row?.status === 'done' && sent !== JSON.stringify(rule);
  return (
    <section aria-labelledby="rule-preview" className="space-y-2">
      <h3 id="rule-preview" className="font-medium">3 · Try it before you save</h3>
      <p className="text-sm text-muted-foreground">
        Judges this rule, as it stands, on a random sample of this collection&apos;s sales and says how many it catches. Nothing is saved.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!writable || running} title={writable ? "Judge this rule on a sample of this collection's sales, without saving it" : LOCAL_ONLY} onClick={start}>Preview</button>
        <span aria-live="polite" className="text-sm">
          {row?.status === 'queued' ? 'Waiting for the worker (an analysis or lens run may be going)' : null}
          {row?.status === 'running' ? (row.progress && Math.floor(row.progress * 100) > 0 ? `Previewing… ${floorPct(row.progress, 1)}` : 'Loading the collection…') : null}
          {row?.status === 'done' && row.result ? resultLine(row, roundTripsName, notFinal, funded, funding, money, tokens) : null}
        </span>
      </div>
      {lost ? <p className="text-xs text-muted-foreground">Lost touch with the service; trying again every second.</p> : null}
      {stale ? <p className="text-xs text-muted-foreground">Previewed before your last change</p> : null}
      {row?.status === 'failed' ? <p role="alert" className="text-sm text-fault">{row.error}</p> : null}
      {error ? <p role="alert" className="text-sm text-fault">{error}</p> : null}
    </section>
  );
}
