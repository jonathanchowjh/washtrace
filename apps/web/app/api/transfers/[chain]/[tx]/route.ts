import { METHODS } from '@washtrace/detect';
import { bad, chainOf, handle, json, txOf } from '@/lib/api';
import { store } from '@/lib/store';

/**
 * GET: "is this sale a wash trade?" Every watched transfer in the
 * transaction, each with the methods that flag it. `washTrade` is true when
 * any method does; `methods` says which, so a caller can choose its own
 * strictness. An unknown transaction is 404, never `washTrade: false`: not
 * having looked is not a clean result.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ chain: string; tx: string }> }): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const tx = txOf(p.tx);
    if (chainId === null || tx === null) return bad('Not a chain id and transaction hash.', 404);
    const transfers = await store().transaction(chainId, tx);
    if (transfers.length === 0) return bad('No watched collection has a transfer in this transaction.', 404);
    const methods = METHODS.filter((m) => transfers.some((t) => t.flags[m]));
    return json({ chainId, tx, washTrade: methods.length > 0, methods, transfers });
  });
}
