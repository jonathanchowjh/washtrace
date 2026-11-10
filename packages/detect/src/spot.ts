import type { LensFlag } from './store.js';
import type { Transfer, Witness } from './types.js';

/**
 * A spot check's answer for one transaction, and the shape the store's own
 * answer is given in too (source 'watched'), so a caller reads one shape.
 * `washTrade` is false only when every counted method ran on every trade and
 * none flagged; null when something could not be looked at.
 */
export interface SpotResult {
  washTrade: boolean | null;
  /** Every method or lens of yours that flagged a trade in the transaction. */
  methods: string[];
  /** The methods or lens that could not run: AU always, AC without money. */
  notRun: string[];
  /** Some wallets or trades could not be judged, so false would not be honest. */
  atLeast: boolean;
  /** The transaction's block was final when it was read; one that was not is never reused. */
  finalized: boolean;
  source: 'watched' | 'spot';
  transfers: (Transfer & { collection: string; flags: Record<string, Witness | Pick<LensFlag, 'path' | 'wallets'>> })[];
}
