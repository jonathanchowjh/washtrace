import type { SpotResult } from '@washtrace/detect';
import type { TxVerdict } from './views';

/**
 * The store's own answer for a transaction, in the shape a spot check gives,
 * so whoever asks reads one shape whichever answered. A stored analysis read
 * its collection whole, so nothing in it is "at least" for a spot check's
 * reasons, and its blocks were final when ingest read them.
 */
export function fromVerdict(v: TxVerdict): SpotResult {
  return {
    washTrade: v.washTrade,
    methods: v.by,
    notRun: v.notRun,
    atLeast: false,
    finalized: true,
    source: 'watched',
    transfers: v.transfers.map(({ collection, ...t }) => ({ ...t, collection: collection?.address ?? '', flags: t.flags })),
  };
}
