import { addressOf, bad, chainOf, handle, json } from '@/lib/api';
import { verdictFields } from '@/lib/metrics';
import { walletView } from '@/lib/views';

/**
 * GET: a wallet's funding state, its 50 busiest counterparties, and its
 * latest 500 trades with their verdicts; `cut` says which list had more. The
 * verdict fields are the transaction route's, over the trades shown.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ chain: string; address: string }> }): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and wallet address.', 404);
    const view = await walletView(chainId, address);
    const { funding, counterparties, transfers, cut } = view;
    return json({ chainId, address, funding, counterparties, transfers, cut, ...verdictFields(view) });
  });
}
