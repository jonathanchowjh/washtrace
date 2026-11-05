import { handle, json } from '@/lib/api';
import { parseSearch, searchArgs, SEARCH_LIMIT } from '@/lib/search';
import { store } from '@/lib/store';

/** GET: what a search finds, as the console's search page does: `q` is a name, a token number (#1234), an address or its start, or a transaction hash. `kind` and `page` read one kind a page at a time; each kind answers at most 20 rows, with `more` saying which had another. */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const { only, page } = searchArgs({ kind: params.get('kind') ?? undefined, page: params.get('page') ?? undefined });
    return json(await store().search(parseSearch(params.get('q') ?? ''), { only, offset: (page - 1) * SEARCH_LIMIT }));
  });
}
