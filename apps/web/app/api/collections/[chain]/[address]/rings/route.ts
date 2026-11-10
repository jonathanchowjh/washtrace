import { moneyFor } from '@washtrace/detect';
import { collectionFrom, handle, json } from '@/lib/api';
import { pageOf, pages } from '@/lib/params';
import { RINGS_PAGE } from '@/lib/views';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * GET: the collection's rings in its latest analysis, RINGS_PAGE a page,
 * the most ETH first: each the wallets the counted evidence joins, named by
 * its anchor. `?page=` past the last reads as the last.
 */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    const { s, chainId, collection } = found;
    const ctx = { money: moneyFor(chainId) };
    const asked = pageOf(new URL(req.url).searchParams.get('page') ?? undefined);
    let page = asked;
    let read = await s.rings(collection.id, ctx, RINGS_PAGE, (page - 1) * RINGS_PAGE);
    const last = pages(read.total, RINGS_PAGE);
    if (page > last) read = await s.rings(collection.id, ctx, RINGS_PAGE, ((page = last) - 1) * RINGS_PAGE);
    return json({ rings: read.rows, total: read.total, page, pages: last });
  });
}
