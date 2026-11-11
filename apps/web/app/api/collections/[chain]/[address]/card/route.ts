import { moneyFor } from '@washtrace/detect';
import { bad, collectionFrom, handle, json } from '@/lib/api';
import { counted, toneOf } from '@/lib/metrics';
import { addressOf, tokenIdOf } from '@/lib/params';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * GET: what a hover card says of one wallet, token or ring in the collection.
 * Give exactly one of the three:
 * - `?wallet=`: its trades here, those counted flagged, its highest-ranked ring and its `tier`;
 * - `?token=`: its transfers, those a counted lens flags, the highest-ranked ring of its flagged trades and its `tier`;
 * - `?ring=`: the ring's line.
 * A `tier` is the strongest counted lens that flags it: `cycle` when Round trips does, `ceiling` when only Linked
 * wallets does, else null. `judged` is false before the collection's first analysis.
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
      const [trades, flagged, rings, tiers] = await Promise.all([
        s.walletTradeCount(chainId, wallet, here), s.walletTradeCount(chainId, wallet, { ...here, flaggedOnly: true }), s.ringsOf(collection.id, { wallet }),
        s.walletTiers(collection.id, [wallet]),
      ]);
      // ringsOf is in anchor order; ringLines ranks them, so the card names the wallet's highest ring.
      const [top] = rings.length === 0 ? [] : await s.ringLines(collection.id, rings, money);
      return json({ kind: 'wallet', judged, address: wallet, trades, flagged, rings: rings.length, ring: top ?? null, tier: tiers.get(wallet) ?? null });
    }
    if (token !== null) {
      const transfers = await s.token(collection.id, token);
      if (transfers.length === 0) return bad('No transfer of this token is read.', 404);
      const flagged = transfers.filter((t) => t.flags.A !== undefined || t.flags.AC !== undefined).length;
      // The floor when Round trips flags any of its trades, else the ceiling when Linked wallets does.
      const tier = transfers.some((t) => toneOf(t) === 'cycle') ? 'cycle' : transfers.some(counted) ? 'ceiling' : null;
      const anchors = await s.ringsOf(collection.id, { tokenId: token });
      const [top] = anchors.length === 0 ? [] : await s.ringLines(collection.id, anchors, money);
      return json({ kind: 'token', judged, tokenId: token, transfers: transfers.length, flagged, ring: top ?? null, tier });
    }
    const [line] = await s.ringLines(collection.id, [ring!], money);
    if (line === undefined) return bad('No ring has this anchor in the latest analysis.', 404);
    return json({ kind: 'ring', judged, ring: line });
  });
}
