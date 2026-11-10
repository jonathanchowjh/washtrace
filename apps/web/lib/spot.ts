import type { SpotResult } from '@washtrace/detect';
import type { TxVerdict } from './views';

/**
 * The store's own answer for a transaction, in the shape a spot check gives,
 * so whoever asks reads one shape whichever answered. A stored analysis read
 * its collection whole, so nothing in it is "at least" for a spot check's
 * reasons, and its blocks were final when ingest read them.
 */
export function fromVerdict(v: TxVerdict): SpotResult {
  // The store calls a transaction clean once every transfer is judged; a spot check, only once every counted method ran.
  const ranAll = !v.notRun.some((m) => m === 'A' || m === 'AC');
  return {
    washTrade: v.washTrade === false && !ranAll ? null : v.washTrade,
    methods: v.by,
    notRun: v.notRun,
    atLeast: false,
    finalized: true,
    source: 'watched',
    transfers: v.transfers.map(({ collection, ...t }) => ({ ...t, collection: collection?.address ?? '', flags: t.flags })),
  };
}
