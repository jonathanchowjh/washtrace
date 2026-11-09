/**
 * The lens-state decision, shared by server pages and client components (so it
 * imports no store, no `pg`): why a share of yours is only "at least" (floorCauses, atLeastOf),
 * where a run stands in words (runStateWords), and whether its figures are
 * behind (behindOf, staleSinceLastWrite, behindLine). Formatting stays in format.ts.
 */

import type { AnalysisRow, Lens, LensRun, Method } from '@washtrace/detect';
import { WALKED, type LensRule } from '@washtrace/detect/lens-rule';
import type { TokensReason } from '@washtrace/detect/lens-reads';
import { NOT_RUN_WORDS, floorPct, plural } from './format';

/**
 * The Other tokens half of a share's floor: tokensReason of lens-reads for this
 * rule (null when it uses none, or reads enough), and whether the count it
 * came from took payees in (`tokens.payees`), which changes the words of
 * 'unreached'.
 */
export type TokensFloor = { reason: TokensReason | null; payees: boolean };

/** The words of a floor cause for other tokens; the Other tokens row says the same things in its own columns. */
function tokensCause(reason: TokensReason, payees: boolean): string {
  if (reason === 'off') return 'other tokens are not read for this collection';
  if (reason !== 'unreached') return 'other tokens are not all read yet for this collection';
  const through = payees ? 'ETH, WETH or one token payment' : 'ETH or WETH';
  // The same words whichever floor the rule gets: with payees in it may still be one middle, so not always a longer loop; and not "tokens alone", as it may mix ETH and tokens.
  return `other tokens are read only for wallets reached by ${through}, so a loop through tokens can be missed`;
}

/**
 * Why a share of yours is only a floor, one phrase per cause: it
 * follows money and the money data is not final (wallets still unchecked, or
 * no funding source), some of its searches stopped at the cap, or some trades
 * had no block time for its window or order to judge them by. Two more apply
 * to a money lens: its money is not read as far as it needs (`moneyShort`,
 * named only when the money cause above is not), and a money edge followed
 * either way is a floor always, since money is walked only as it was sent.
 * A lens that
 * follows only NFTs is not held back by money. Empty when the share is exact.
 * `counts` puts how many after a search or trade cause, for the lens panel,
 * which has room for them; every "at least" says why in these words.
 * `moneyShort`: moneyShort() of lens-reads for this rule, the collection's MoneyRead and whether its run is behind.
 */
export function floorCauses(rule: LensRule, t: { truncated: number; untimed: number }, notFinal: readonly Method[], funded: boolean, moneyShort: boolean, tokens: TokensFloor, counts = false): string[] {
  // The money walk's rows only: other tokens have a read of their own, which `tokens` says.
  const money = WALKED.some((k) => rule.edges[k].use);
  const n = (k: number, word: string, many?: string) => (counts ? ` (${plural(k, word, many)})` : '');
  // Money is followed along the way it was sent, whatever direction a money edge says (depthNeeded), so a loop against it can be missed.
  const blind = money && rule.hops.max !== null && WALKED.some((k) => rule.edges[k].use && rule.edges[k].direction === 'either');
  const checking = money && !funded ? 'no funding source is set, so money is not fully read' : money && notFinal.length > 0 ? 'money is not fully read yet' : null;
  return [
    t.truncated > 0 ? `some of its searches stopped at the cap before finding a loop${n(t.truncated, 'search', 'searches')}` : null,
    t.untimed > 0 ? `some trades have no block time to judge them by${n(t.untimed, 'trade')}` : null,
    checking,
    // The traders' own check still running is `checking` above; this is money further out than the collection is read.
    checking === null && money && moneyShort ? 'money is not read as far as this lens needs' : null,
    blind ? 'money is followed only the way it was sent, so a loop against it can be missed' : null,
    // A rule that uses no other tokens has reason null (tokensReason), so it never gets this cause.
    tokens.reason === null ? null : tokensCause(tokens.reason, tokens.payees),
  ].filter((x) => x !== null);
}

/** Whether a share of yours is a floor (floorCauses names why). Lives here, not in lens-tabs or the server code, so a client component can import it without pulling `pg` into the browser bundle. */
export function atLeastOf(rule: LensRule, t: { truncated: number; untimed: number }, notFinal: readonly Method[], funded: boolean, moneyShort: boolean, tokens: TokensFloor): boolean {
  return floorCauses(rule, t, notFinal, funded, moneyShort, tokens).length > 0;
}

/** How a lens of yours can be behind: its figures are from before its latest edit, or from before the latest analysis. */
export type Behind = 'edit' | 'analysis';

/**
 * Why the figures a lens of yours shows are not from its rule now on the
 * latest analysis, or null when they are (or it has none to show). It holds
 * in any status: a queued, running or failed run keeps the figures of the
 * last one that saved, and `lensVersion` and `analysisId` are that run's.
 * An edit is said first: then the flags are another rule's.
 */
export function behindOf(run: LensRun | null, lens: Pick<Lens, 'version'>, latest: Pick<AnalysisRow, 'id'> | null): Behind | null {
  if (run === null || run.totals === null) return null;
  if (run.lensVersion < lens.version) return 'edit';
  return run.analysisId !== (latest?.id ?? null) ? 'analysis' : null;
}

/**
 * Whether a lens of yours's figures are from before the collection's latest
 * write. Unlike behindOf it ignores edits to the lens and adds
 * `stale`: written to since its latest analysis (which a
 * reach wallet's check makes it), or from a run on an analysis older than
 * `latest`. Then it has not read what Fetch them fetched since, so its share
 * of a lens reaching past the global limit is a floor (moneyReason's
 * 'behind'). False with no figures to show.
 */
export function staleSinceLastWrite(run: LensRun | null, latest: Pick<AnalysisRow, 'id'> | null, stale: boolean): boolean {
  return run !== null && run.totals !== null && (stale || run.analysisId !== (latest?.id ?? null));
}

/** The line above Trades and the flagged lists: each lens in view that is behind, by name, and what that means for what is shown. Null when none is. */
export function behindLine(lenses: readonly { name: string; behind: Behind }[]): string | null {
  if (lenses.length === 0) return null;
  return lenses.map(({ name, behind }) => behind === 'edit'
    ? `${name} shows ${FIGURES_FROM.edit}, so its flags are the old rule's until the new run saves.`
    : `${name} shows ${FIGURES_FROM.analysis}, so trades after it are not judged by it yet.`).join(' ');
}

/** Where the figures a lens of yours shows come from when they are not its current rule's on the latest analysis (behindOf), as the rest of a sentence. */
export const FIGURES_FROM = {
  edit: 'figures from before its latest edit',
  analysis: 'figures from the run before the latest analysis',
} as const;

/**
 * Where a lens of yours's run stands, in two forms of one state: `full`, the
 * rest of a sentence that starts with its lens name (Compare, the chart, the
 * trade page and the panels all say it so), and `short`, a label for its tab,
 * with the run's progress. Null for a finished run that is current. A failed
 * first run never reads as one that never ran. `behind` (from behindOf) says
 * where the figures shown are from when they are not the current rule's on
 * the latest analysis: 'edit', from before its latest edit, or 'analysis',
 * from the run before the latest analysis (FIGURES_FROM). Either is said
 * before a queued or running run, and with it; a failure is said first, and
 * names where its figures are from. In a tab, an edit and a newer run both
 * fit; after an analysis the newer run is the label.
 */
export function runStateWords(run: LensRun | null, behind: 'edit' | 'analysis' | null = null): { short: string; full: string } | null {
  if (run === null) return NOT_RUN_WORDS;
  const pct = run.progress === null ? null : floorPct(run.progress, 1);
  if (run.totals === null) {
    return run.status === 'failed' ? { short: 'last run failed', full: 'has no figures: its last run failed.' }
      : { short: `first run ${pct ?? run.status}`, full: 'has no figures yet: its first run has not finished.' };
  }
  const from = behind === null ? 'figures from an earlier run' : FIGURES_FROM[behind];
  if (run.status === 'failed') return { short: 'last run failed', full: `has ${from}: its last run failed.` };
  const newer = run.status === 'queued' ? 'queued' : run.status === 'running' ? 'in progress' : null;
  const now = pct ?? run.status;
  if (behind === null) return newer === null ? null : { short: `newer run ${now}`, full: `has a newer run ${newer}.` };
  if (newer === null) return { short: behind === 'edit' ? 'before edit' : 'before analysis', full: `shows ${from}.` };
  // Both fit a tab after an edit; after an analysis the newer run is the news, as the label is short.
  return { short: behind === 'edit' ? `before edit · ${now}` : `newer run ${now}`, full: `shows ${from}, and a newer run is ${newer}.` };
}

/**
 * A lens of yours whose run is from before its latest edit (behindOf 'edit'),
 * on a trade that run did not catch: it leads with the edit phrase every page
 * says (FIGURES_FROM). The run's rule is not kept, so whether it judged the
 * trade at all is not known, and nothing is said of "its rule".
 */
export const OWN_BEFORE_EDIT = `Shows ${FIGURES_FROM.edit}: the run they came from did not catch this transfer, and the new rule’s run has not saved yet.`;
