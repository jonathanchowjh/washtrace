import { bad, handle, json } from '@/lib/api';
import { addressOf, chainOf } from '@/lib/params';
import { verdictFields } from '@/lib/metrics';
import { walletOpts, walletView } from '@/lib/views';

/**
 * GET: a wallet's funding state, a page of its money partners and a page of
 * its trades, with the wallet page's params: `trades`, `partners` and `flows`
 * pages, `collection`, `flagged=1`, `q`, `psort`, and `with` and `dir` for
 * what passed between it and one other wallet (`between`). `pages` says each
 * list's page and count, `counts` every trade and those counted flagged, and
 * `cut` which list has more than one page. The verdict fields are the
 * transaction route's, over the trades shown.
 */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string; address: string }> }): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and wallet address.', 404);
    const view = await walletView(chainId, address, walletOpts(Object.fromEntries(new URL(req.url).searchParams)));
    const { funding, collections, counterparties, transfers, counts, pages, cut, between } = view;
    return json({ chainId, address, funding, collections, counterparties, transfers, counts, pages, cut, between, ...verdictFields(view) });
  });
}
