import { moneyFor } from '@washtrace/detect';
import { bad, collectionFrom, handle, json } from '@/lib/api';
import { addressOf, tokenIdOf } from '@/lib/params';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * GET: what a hover card says of one wallet, token or ring in the collection:
 * a few counts, never a verdict read. `?wallet=` gives its trades here, those
 * counted flagged, and its first ring; `?token=` its transfers and those a
 * counted lens flags; `?ring=` the ring's line. Exactly one of the three.
 * `judged` is false before the collection's first analysis.
 */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    const { s, chainId, address, collection } = found;
    const sp = new URL(req.url).searchParams;
    const money = { money: moneyFor(chainId) };
    // Before any analysis nothing is judged, so a flagged count of 0 would read as clean: the card says not judged yet.
    const judged = collection.latest !== null;
    const wallet = addressOf(sp.get('wallet') ?? '');
    const token = tokenIdOf(sp.get('token') ?? '');
    const ring = addressOf(sp.get('ring') ?? '');
    if ([wallet, token, ring].filter((x) => x !== null).length !== 1) return bad('Give one of wallet, token or ring.', 400);
    if (wallet !== null) {
      const here = { collection: address };
      const [trades, flagged, rings] = await Promise.all([
        s.walletTradeCount(chainId, wallet, here), s.walletTradeCount(chainId, wallet, { ...here, flaggedOnly: true }), s.ringsOf(collection.id, { wallet }),
      ]);
      const first = rings.length === 0 ? [] : await s.ringLines(collection.id, rings.slice(0, 1), money);
      return json({ kind: 'wallet', judged, address: wallet, trades, flagged, rings: rings.length, ring: first[0] ?? null });
    }
    if (token !== null) {
      const transfers = await s.token(collection.id, token);
      if (transfers.length === 0) return bad('No transfer of this token is read.', 404);
      const flagged = transfers.filter((t) => t.flags.A !== undefined || t.flags.AC !== undefined).length;
      return json({ kind: 'token', judged, tokenId: token, transfers: transfers.length, flagged });
    }
    const [line] = await s.ringLines(collection.id, [ring!], money);
    if (line === undefined) return bad('No ring has this anchor in the latest analysis.', 404);
    return json({ kind: 'ring', judged, ring: line });
  });
}
