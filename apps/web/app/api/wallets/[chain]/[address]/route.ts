import { addressOf, bad, chainOf, handle, json } from '@/lib/api';
import { store } from '@/lib/store';

/** GET: a wallet's funding state, who it moved money with, and its transfers in every watched collection with their verdicts. */
export async function GET(_req: Request, { params }: { params: Promise<{ chain: string; address: string }> }): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and wallet address.', 404);
    const s = store();
    const [funding, counterparties, transfers] = await Promise.all([
      s.wallet(chainId, address), s.counterparties(chainId, address), s.walletTransfers(chainId, address),
    ]);
    return json({ chainId, address, funding, counterparties, transfers });
  });
}
