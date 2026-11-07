/**
 * Why a token or wallet is in a lens's list, in words: the loops and linked
 * pairs its caught trades point at, and the wallets in them. One form for
 * every lens, so a reader learns it once. Each part says what it opens, if
 * anything; the list turns those parts into links.
 */

import type { TokenLine, WalletLine } from '@washtrace/detect';
import { plural, num } from './format';

export type WhyPart = { text: string; opens?: 'loops' | 'wallets' };

/** "1 loop and 2 linked pairs", the zero kinds left out; empty when there are neither. */
function counts(loops: number, pairs: number): string {
  return [loops > 0 ? plural(loops, 'loop') : null, pairs > 0 ? plural(pairs, 'linked pair') : null].filter((s) => s !== null).join(' and ');
}

/** "3 loops among 4 wallets, 5 laps, 2 closed by money, 1 through a middle wallet". */
export function tokenWhy(l: TokenLine): WhyPart[] {
  const what = counts(l.loops, l.pairs);
  if (what === '') return [];
  const parts: WhyPart[] = [{ text: what, opens: 'loops' }];
  if (l.wallets > 0) parts.push({ text: ' among ' }, { text: plural(l.wallets, 'wallet'), opens: 'wallets' });
  // Laps only when some loop went round more than once: one lap a loop says nothing the loops did not.
  const tails = [
    l.laps > l.loops ? plural(l.laps, 'lap') : null,
    l.closedByMoney > 0 ? `${num(l.closedByMoney)} closed by money` : null,
    l.middles > 0 ? `${num(l.middles)} through a middle wallet` : null,
  ].filter((s) => s !== null);
  if (tails.length > 0) parts.push({ text: tails.map((t) => `, ${t}`).join('') });
  return parts;
}

/** "in 41 loops and 2 linked pairs with 6 wallets". */
export function walletWhy(l: WalletLine): WhyPart[] {
  const what = counts(l.loops, l.pairs);
  if (what === '') return [];
  const parts: WhyPart[] = [{ text: 'in ' }, { text: what, opens: 'loops' }];
  if (l.partners > 0) parts.push({ text: ' with ' }, { text: plural(l.partners, 'wallet'), opens: 'wallets' });
  return parts;
}
