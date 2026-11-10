import { handle, json } from '@/lib/api';
import { parseSearch, scopeOf, searchArgs, SEARCH_LIMIT } from '@/lib/search';
import { store } from '@/lib/store';

/**
 * GET: what a search finds, as the console's search page does: `q` is a name, a token number (#1234), an address or its start, or a transaction hash.
 * `kind` and `page` read one kind a page at a time; each kind answers at most 20 rows, with `more` saying which had another. `scope=<chain>:<address>`
 * narrows tokens and wallets to one watched collection's; an unwatched one narrows nothing.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const { only, page } = searchArgs({ kind: params.get('kind') ?? undefined, page: params.get('page') ?? undefined });
    const s = store();
    const scope = scopeOf(params.get('scope'));
    const c = scope === null ? null : await s.collection(scope.chainId, scope.address);
    return json(await s.search(parseSearch(params.get('q') ?? ''), { only, offset: (page - 1) * SEARCH_LIMIT, scope: c === null ? undefined : { id: c.id, chainId: c.chainId } }));
  });
}
