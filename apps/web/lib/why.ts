/**
 * Why a token or wallet is in a lens's list, in words: the loops and linked
 * pairs its caught trades point at, and the wallets in them. One form for
 * every lens, so a reader learns it once. Each part says what it opens, if
 * anything; the list turns those parts into links.
 */

import type { TokenLine, WalletLine } from '@washtrace/detect';
import type { LensKey } from '@washtrace/detect/trades';
import { plural, num, timesRound } from './format';

export type WhyPart = { text: string; opens?: 'loops' | 'wallets' };

/** "1 loop and 2 linked pairs", the zero kinds left out; empty when there are neither. */
function counts(loops: number, pairs: number): string {
  return [loops > 0 ? plural(loops, 'loop') : null, pairs > 0 ? plural(pairs, 'linked pair') : null].filter((s) => s !== null).join(' and ');
}

/**
 * A row's loop counts. A built-in's analysis fills them in and a lens of
 * yours's run fills them from its flags (laps = loops, pairs = 0), so one
 * form reads both. A count that is missing (null) silences only its own part,
 * never the line, and a zero count is left out, so nothing reads "0 loops".
 */
type Counts<K extends string> = Record<K, number>;

/** "3 loops among 4 wallets, round 5 times, 2 closed by money, 1 through a middle wallet". */
export function tokenWhy(_method: LensKey, line: TokenLine): WhyPart[] {
  const l = line as TokenLine & Counts<'loops' | 'pairs' | 'wallets' | 'laps' | 'closedByMoney' | 'middles'>;
  const what = counts(l.loops, l.pairs);
  if (what === '') return [];
  const parts: WhyPart[] = [{ text: what, opens: 'loops' }];
  if (l.wallets > 0) parts.push({ text: ' among ' }, { text: plural(l.wallets, 'wallet'), opens: 'wallets' });
  // How often round only when some loop went round more than once: once a loop says nothing the loops did not.
  const tails = [
    l.laps > l.loops ? `round ${timesRound(l.laps)}` : null,
    l.closedByMoney > 0 ? `${num(l.closedByMoney)} closed by money` : null,
    l.middles > 0 ? `${num(l.middles)} through a middle wallet` : null,
  ].filter((s) => s !== null);
  if (tails.length > 0) parts.push({ text: tails.map((t) => `, ${t}`).join('') });
  return parts;
}

/** "in 41 loops and 2 linked pairs with 6 wallets". */
export function walletWhy(_method: LensKey, line: WalletLine): WhyPart[] {
  const l = line as WalletLine & Counts<'loops' | 'pairs' | 'partners'>;
  const what = counts(l.loops, l.pairs);
  if (what === '') return [];
  const parts: WhyPart[] = [{ text: 'in ' }, { text: what, opens: 'loops' }];
  if (l.partners > 0) parts.push({ text: ' with ' }, { text: plural(l.partners, 'wallet'), opens: 'wallets' });
  return parts;
}
