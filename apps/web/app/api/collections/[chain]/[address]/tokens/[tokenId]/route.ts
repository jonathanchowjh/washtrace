import { bad, handle, json } from '@/lib/api';
import { addressOf, chainOf, tokenIdOf } from '@/lib/params';
import { verdictFields } from '@/lib/metrics';
import { tokenView } from '@/lib/views';

/** GET: one token's transfers in chain order with each method's verdict and witness, the money among its wallets, and the one verdict of the token (washTrade, judged, methods, apartOnly, notRun). */
export async function GET(_req: Request, { params }: { params: Promise<{ chain: string; address: string; tokenId: string }> }): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    const tokenId = tokenIdOf(p.tokenId);
    if (chainId === null || address === null || tokenId === null) return bad('Not a chain id, collection address and token id.', 404);
    const view = await tokenView(chainId, address, tokenId);
    if (view === 'not-watched') return bad('This collection is not watched.', 404);
    if ('empty' in view) return bad('No transfer of this token is read.', 404);
    const { collection, transfers, middles, flows } = view;
    return json({ collection, tokenId: view.tokenId, transfers, middles, flows, ...verdictFields(view) });
  });
}
