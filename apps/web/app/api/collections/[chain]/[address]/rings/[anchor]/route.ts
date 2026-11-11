import { moneyFor } from '@washtrace/detect';
import { bad, collectionFrom, handle, json } from '@/lib/api';
import { addressOf } from '@/lib/params';

type Ctx = { params: Promise<{ chain: string; address: string; anchor: string }> };

/** GET: one ring by its anchor: its line, its wallets (`traded` false for one in between, on none of its flagged trades), and its tokens. */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    const { s, chainId, collection } = found;
    const anchor = addressOf((await params).anchor);
    const ring = anchor === null ? null : await s.ring(collection.id, anchor, { money: moneyFor(chainId) });
    if (ring === null) return bad('No ring has this anchor in the latest analysis.', 404);
    return json(ring);
  });
}
