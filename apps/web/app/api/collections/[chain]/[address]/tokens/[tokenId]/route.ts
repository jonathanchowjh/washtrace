import { addressOf, bad, chainOf, handle, json, tokenIdOf } from '@/lib/api';
import { tokenView } from '@/lib/views';

/** GET: one token's transfers in chain order with each method's verdict and witness, and the money among its wallets. */
export async function GET(_req: Request, { params }: { params: Promise<{ chain: string; address: string; tokenId: string }> }): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    const tokenId = tokenIdOf(p.tokenId);
    if (chainId === null || address === null || tokenId === null) return bad('Not a chain id, collection address and token id.', 404);
    const view = await tokenView(chainId, address, tokenId);
    if (view === null) return bad('This collection is not watched.', 404);
    return json(view);
  });
}
