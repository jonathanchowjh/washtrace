import { bad, chainOf, handle, json, txOf } from '@/lib/api';
import { txView } from '@/lib/views';

/**
 * GET: "is this sale a wash trade?" Every watched transfer in the
 * transaction, each with the methods that flag it. `washTrade` is true when
 * Round trips or Linked wallets flags it (Money loops back is not counted),
 * and `methods` lists every lens that ran and flagged it, so a caller can
 * choose its own strictness. `washTrade: null` with `judged: false` is a
 * transaction that is read but that no analysis has covered yet. An unknown
 * transaction is 404, never `washTrade: false`: not having looked is not a
 * clean result.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ chain: string; tx: string }> }): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const tx = txOf(p.tx);
    if (chainId === null || tx === null) return bad('Not a chain id and transaction hash.', 404);
    const { transfers, washTrade, judged, by } = await txView(chainId, tx);
    if (transfers.length === 0) return bad('No watched collection has a transfer in this transaction.', 404);
    return json({ chainId, tx, washTrade, judged, methods: by, transfers });
  });
}
