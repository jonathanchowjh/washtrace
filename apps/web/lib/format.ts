/**
 * Display strings, and the lens vocabulary that is this file's main shared
 * data (LENSES: each lens's name, hue and one-line meaning, which the Trades
 * URL, the API and the pages all take as the source of truth for lens
 * identity). It also holds the stored-data size model (StoredSize,
 * storedSizes, storedLine). Amounts stay wei strings until they are drawn;
 * nothing here is summed or compared.
 */

import type { Manifest, Method } from '@washtrace/detect';
import { formatBytes } from '@washtrace/detect/bytes';
import type { LensRule } from '@washtrace/detect/lens-rule';

/** A count with thousands separators, in the one locale the whole console pins (server and browser agree). */
export function num(n: number | bigint): string {
  return n.toLocaleString('en-US');
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Wei to a readable native amount, to four significant places past the point. */
export function eth(wei: string | null, unit = 'ETH'): string {
  if (wei === null) return '—';
  const n = BigInt(wei);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return `${num(whole)}${frac ? `.${frac}` : ''} ${unit}`;
}

/** ETH as a decimal to wei, exactly, by splitting the string; null for anything else (no sign, no exponent, at most 18 decimals). */
export function ethToWei(s: string): string | null {
  const m = /^(\d*)(?:\.(\d{0,18}))?$/.exec(s.trim());
  if (!m || (m[1] === '' && !m[2])) return null;
  return BigInt((m[1] || '0') + (m[2] ?? '').padEnd(18, '0')).toString();
}

export function weiToEth(wei: string): string {
  const s = wei.padStart(19, '0');
  const frac = s.slice(-18).replace(/0+$/, '');
  return `${s.slice(0, -18)}${frac ? `.${frac}` : ''}`;
}

/** A share as a percentage: never "0%" for a share above zero, which would read as clean. */
export function pct(part: number, whole: number): string {
  if (whole === 0) return '—';
  const p = (part / whole) * 100;
  if (p === 0) return '0%';
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

/** A share floored to a whole percent, so 99.96% reads 99% and never 100% while a check is still running (pct would round it up). A download's share is `floorPct(share, 1)`: 41.6% reads 41%, never a step ahead of the bytes. */
export const floorPct = (part: number, whole: number) => `${whole === 0 ? 0 : Math.floor((part / whole) * 100)}%`;

/** A share to a tenth, for a lens's tab and its stat line, where two lenses a point apart must not read alike: `pct`, but with its decimal kept at 10% and above. */
export function pctTenth(part: number, whole: number): string {
  const p = whole === 0 ? 0 : (part / whole) * 100;
  return p >= 10 ? `${p.toFixed(1)}%` : pct(part, whole);
}

/** "1 wallet", "2 wallets": `many` for a word whose plural is not an added s ("searches"). */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${num(n)} ${n === 1 ? word : many}`;
}

/** A guess at a duration, never shown to the minute: "about 40 min". A bound reads "at least" plus `floorTime` instead. */
export function about(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `about ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `about ${h} h` : `about ${plural(Math.round(h / 24), 'day')}`;
}

/** How long a wait will take: "about 40 min left". */
export const eta = (ms: number): string => `${about(ms)} left`;

/**
 * A duration for "at least T": rounded down at the unit it shows,
 * never up, as eta rounds, so the floor it states is never more than the
 * time. Seconds under a minute, minutes under an hour, hours under a day.
 */
export function floorTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return plural(Math.floor(s / 86_400), 'day');
}

/**
 * A duration in the unit that reads best: milliseconds under 10 s, whole seconds
 * until the rounded figure reaches two minutes, then minutes to a tenth. The unit
 * switches on the rounded seconds, so 119.9 s reads "2.0 min" and never "120 s".
 */
export function took(ms: number): string {
  if (ms < 10_000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * How often something repeats: seconds (to a tenth) under two minutes, then
 * minutes. Not took(), which reads a 5 s poll as "5000 ms": took() measures a
 * run, where milliseconds matter, and an interval is set in seconds.
 */
export function interval(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return s < 120 ? `${num(s)} s` : `${num(Math.round(s / 6) / 10)} min`;
}

/** What a trade or transaction no analysis has covered yet is called, wherever it is said. */
export const NOT_JUDGED_YET = 'Not judged yet';

/**
 * A lens that has not run on a collection: `short` is the word in a tab, a
 * CSV cell or a Group by cell, built-in or yours alike; `full` the rest of a
 * sentence that starts with the name of a lens of yours with no run, or of a
 * built-in before any analysis. Always true of one of yours: its runs go only
 * when it or the collection does. A built-in that missed the latest analysis
 * is said in NOT_RUN_LATEST.
 */
export const NOT_RUN_WORDS = { short: 'not run', full: 'has not run on this collection, so it flags nothing yet.' };
export const NOT_RUN = NOT_RUN_WORDS.short;

/**
 * A built-in the latest analysis did not run, as the rest of a sentence that
 * starts with its name. Its figures are per analysis, and it may
 * have run in an earlier one, before a funding source was removed, so it is
 * never said to have not run on the collection.
 */
export const NOT_RUN_LATEST = 'did not run in the latest analysis, so it flags nothing.';

/** The sentence for a lens of yours that has not run on a collection, on its panel, Trades and the flagged lists alike. */
export const notRunHere = (name: string): string => `${name} ${NOT_RUN_WORDS.full}`;

/** A token id shortened to fit a row or heading; the full id is always one click away. */
export function tokenLabel(id: string, max = 20): string {
  return id.length > max ? `${id.slice(0, max - 2)}…` : id;
}

/** The six reading stages, in order: `label` heads the pipeline table's column, `title` is what the stage does. */
export const STAGES = [
  { label: 'Download', title: 'Download stored data' },
  { label: 'Load', title: 'Load it into the database' },
  { label: 'Analyze stored', title: 'Analyze the stored data' },
  { label: 'Chain', title: 'Read new transfers from the chain' },
  { label: 'Money', title: 'Check wallets for money' },
  { label: 'Re-analyze', title: 'Re-analyze with everything' },
] as const;

/** "reading stage 4 (Chain)": a pipeline stage by number and name, so it is not mistaken for one of the worker's four jobs. */
export function stageName(n: 1 | 2 | 3 | 4 | 5 | 6): string {
  return `reading stage ${n} (${STAGES[n - 1]!.label})`;
}

/** Where a missing Etherscan key is added, and the words every link there carries. */
export const ETHERSCAN_HREF = '/settings#etherscan.key';
export const ETHERSCAN_CTA = 'Add an Etherscan key in Settings →';

export type TimeStyle = 'datetime' | 'date' | 'time' | 'month';

const STYLES: Record<TimeStyle, Intl.DateTimeFormatOptions> = {
  datetime: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit' },
  month: { year: 'numeric', month: 'short' },
};

/**
 * A clock time in a zone, never "ago": a reading compared across tabs must
 * say when, not how long before some other moment. The zone is the reader's,
 * detected or chosen; called without one it is whatever zone runs it, which
 * on the server is the container's, so the console calls it in the browser.
 * `locale` is the reader's when left out, which on the server is whatever
 * the container has (often none); text built there pins one instead.
 */
export function localTime(ms: number, style: TimeStyle = 'datetime', zone?: string, locale?: string): string {
  const key = `${style}|${zone ?? ''}|${locale ?? ''}`;
  let f = formatters.get(key);
  // One formatter per style and zone: a chart asks for hundreds of labels on every hover.
  if (!f) {
    f = new Intl.DateTimeFormat(locale, zone ? { ...STYLES[style], timeZone: zone } : STYLES[style]);
    formatters.set(key, f);
  }
  return f.format(ms);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The three methods as lenses, in the order they are shown. The paper's names (SCC A, AU,
 * AC) stay in the API and README; a reader sees only these.
 * `tone` is the lens's standing as a hue: the token's own cycle, a link
 * through money, or apart (never counted, so grey everywhere).
 */
export const LENSES = {
  A: { name: 'Round trips', tone: 'cycle', says: 'The token keeps coming back to wallets that already held it.' },
  AU: { name: 'Money loops back', tone: 'apart', says: 'The token goes one way, and the payment finds its way back to the seller through other wallets.' },
  AC: { name: 'Linked wallets', tone: 'money', says: 'A round trip, or a buyer and seller joined by money: one paid the other, or both share a funder.' },
} as const;

/**
 * Why a built-in did not catch a trade it judged, in one line of its own
 * terms: each is what its search in methods.ts leaves true of every trade
 * it passes.
 * - Round trips flags a trade inside a loop of the token's own transfers
 *   with `minCycles` cycles. A trade on no loop never sees the token back at
 *   the seller after it (the exit sale after a pattern is one); on a loop
 *   with fewer, the seller gets it back fewer times than that.
 * - Money loops back follows money the buyer sent up to `reachDepth` wallets,
 *   never from or on through a hub: a contract, a wallet linked to more than
 *   `hubDegree`, or one whose history was cut short (`truncated`).
 * - Linked wallets asks for a payment either way, or a middle joined by money
 *   to both that is no such hub.
 * The rules can differ per collection, so no number is said.
 */
export const NOT_CAUGHT: Record<Method, string> = {
  A: 'The token never comes back to the seller after this trade, or not as often as a pattern needs.',
  AU: 'No money it reads from the buyer finds its way back to the seller within the longest path it follows. It follows none from or through an exchange, a router, a contract or a wallet whose history was too long to read.',
  AC: 'The buyer and seller paid each other nothing it reads, and share no money partner but an exchange, a router, a contract or a wallet whose history was too long to read.',
};

/**
 * A mint no lens caught, in place of its lens cards. A first mint is no hop
 * of the token's graph, but a re-mint after a burn is one (custody through
 * the zero address, graph.ts) and is judged, so the line says only that none
 * caught it, which holds either way.
 */
export const MINT_LINE = 'A mint: no lens caught it.';
/** A burn, in place of its lens cards: it parks the token and is never a hop, so no lens, built-in or yours, judges it. */
export const BURN_LINE = 'A burn, not a trade: no lens judges it.';

/**
 * Moves into and out of custody (CUSTODIANS, such as Blur Blend's loans), in
 * place of their lens cards. graph.ts folds A → escrow → B into one step
 * A → B and A → escrow → A into none, for the built-ins and your lenses
 * alike: a move in is never a step, and a move out is one only when it goes
 * to a wallet other than the one that put the token in.
 */
export const INTO_CUSTODY_LINE = 'Into custody, not a trade: no lens judges it, since the escrow holds the token without owning it.';
export const OUT_OF_CUSTODY_LINE = {
  back: 'Out of custody, back to the wallet that put it in: not a trade, so no lens judges it.',
  unread: 'Out of custody, with no move of it into custody read before: there is no seller, so no lens judges it.',
} as const;

/** A lens of yours whose rule judges sales only (lens.ts `judges`), on a transfer with no marketplace: it never looked at it. */
export function salesOnlyLine(name: string): string {
  return `Not judged: ${name} judges sales only, and this transfer is not a sale.`;
}

/** A lens of yours whose window or loop order is measured from the trade's time, on a transfer the RPC gave no time (lens.ts): skipped, and counted untimed. */
export function untimedLine(name: string, rule: Pick<LensRule, 'window' | 'order'>): string {
  const what = [rule.window !== null ? 'window' : null, rule.order === 'loop' ? 'loop order' : null].filter((x) => x !== null).join(' and ');
  return `Not judged: this transfer has no block time, and ${name} measures its ${what} from it.`;
}

/** A lens of yours that judged a trade and found no loop. */
export const OWN_NOT_CAUGHT = 'No way back to the seller under its rule.';

/** Said after a miss when some money search stopped at its cap: a lens of yours's run, or Money loops back's analysis. */
export const CAPPED = ' Some searches here stopped at the cap, so this is not proof it is clean.';

/** A trade past the block a lens of yours's run read through: not judged by it, never clean. */
export const OWN_BEHIND = 'Not judged yet: this trade is past the block its run read.';

/** A trade past the block the latest analysis read through, or on a collection with no analysis yet: the built-ins have not judged it. */
export const BUILT_IN_BEHIND = 'Not judged yet: no analysis has read as far as this trade.';

/** Your saved lenses by key, as a page shows them: the name a reader sees, the hue `own`, and the rule in words. */
export type Lenses = Record<string, { name: string; tone: 'cycle' | 'money' | 'apart' | 'own'; says: string }>;

/** A lens's name, hue and meaning: a built-in's, else one of yours; null for a key that names neither (a deleted lens). */
export function lensInfo(key: string, own: Lenses): { name: string; tone: 'cycle' | 'money' | 'apart' | 'own'; says: string } | null {
  if (Object.hasOwn(LENSES, key)) return LENSES[key as keyof typeof LENSES];
  return Object.hasOwn(own, key) ? own[key]! : null;
}

/** "a, b and c". */
export function andList(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Round trips, Money loops back and Linked wallets". */
export function lensList(methods: readonly (keyof typeof LENSES)[]): string {
  return andList(methods.map((m) => LENSES[m].name));
}

/**
 * The sentence for built-ins that have not run, one or several, in the words
 * every page says it in: NOT_RUN_LATEST once the collection has an analysis
 * (`analysed`), and before any, that they have not run at all, as a lens of
 * yours with no run says.
 */
export function notRunAll(methods: readonly (keyof typeof LENSES)[], analysed = true): string {
  if (methods.length === 1) return analysed ? `${LENSES[methods[0]!].name} ${NOT_RUN_LATEST}` : notRunHere(LENSES[methods[0]!].name);
  return `${lensList(methods)} ${analysed ? 'did not run in the latest analysis, so they flag nothing.' : 'have not run on this collection, so they flag nothing yet.'}`;
}

/**
 * notRunAll for a transaction across several collections: the
 * built-ins and the collections (`where`, by name) whose latest analysis did
 * not run them. One may have run and flagged in another, so it flags nothing
 * only there.
 */
export function notRunIn(methods: readonly (keyof typeof LENSES)[], where: readonly string[]): string {
  return `${lensList(methods)} did not run in the latest ${where.length === 1 ? 'analysis' : 'analyses'} of ${andList(where)}, so ${methods.length === 1 ? 'it flags' : 'they flag'} nothing there.`;
}

/**
 * What having no Etherscan key means for the money lenses: they do not run,
 * or, while a collection's loaded money trail feeds them, they run on the
 * stored trails alone and newer wallets go unchecked.
 */
export function withoutKey(trailFunded: boolean): string {
  const money = `${LENSES.AU.name} and ${LENSES.AC.name}`;
  return trailFunded ? `${money} run only on stored money trails, and newer wallets go unchecked` : `${money} do not run`;
}

/** One collection's stored files, sized: what the suggested list and the add form say of it. */
export interface StoredSize { chainId: number; address: string; name: string; transfers: number; trail: number | null }

/** The manifest as sizes, or null when none is cached yet (not the same as a manifest with no collection). */
export function storedSizes(m: Manifest | null): StoredSize[] | null {
  return m === null ? null : m.collections.map((e) => ({ chainId: e.chainId, address: e.address, name: e.name, transfers: e.transfers.bytes, trail: e.trail?.bytes ?? null }));
}

/** "stored data: 12.3 MB transfers + 3.4 GB money trail"; with no trail, the transfers alone. */
export function storedLine(s: Pick<StoredSize, 'transfers' | 'trail'>): string {
  return `stored data: ${formatBytes(s.transfers)} transfers${s.trail === null ? '' : ` + ${formatBytes(s.trail)} money trail`}`;
}

// ---- spot checks ----

/** A spot check that could not judge everything: never a clean answer. */
export const SPOT_AT_LEAST = 'At least: some wallets or trades could not be judged, so this is not a clean result.';
export const SPOT_CHECKING = 'Checking: reading the transaction, its tokens and its wallets’ money…';
export const SPOT_NOT_FINAL = 'This block is not final yet; the answer may change.';
export const SPOT_ONLY = 'This was a spot check of one transaction. Watch its collection to judge it on everything it has read.';
export const SPOT_STORED = 'From the latest analysis of its collection.';
