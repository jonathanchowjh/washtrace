import { moneyFor } from '@washtrace/detect';
import { handle, json } from '@/lib/api';
import { bestKind, CONNECTED, parseSearch, scopeOf, searchArgs, SEARCH_LIMIT, type SearchReply } from '@/lib/search';
import { store } from '@/lib/store';

/**
 * GET: what a search finds, as the console's search page does: `q` is a name, a token number (#1234), an address or its start, or a transaction hash.
 * `kind` and `page` read one kind a page at a time; each kind answers at most 20 rows, with `more` saying which had another. `scope=<chain>:<address>`
 * narrows tokens and wallets to one watched collection's; an unwatched one narrows nothing. A scoped search of every kind whose best match is a
 * wallet adds `connected`: that wallet's rings and the tokens it traded in the collection, which the search box lists under it.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const { only, page } = searchArgs({ kind: params.get('kind') ?? undefined, page: params.get('page') ?? undefined });
    const s = store();
    const scope = scopeOf(params.get('scope'));
    const c = scope === null ? null : await s.collection(scope.chainId, scope.address);
    const parsed = parseSearch(params.get('q') ?? '');
    const hits: SearchReply = await s.search(parsed, { only, offset: (page - 1) * SEARCH_LIMIT, scope: c === null ? undefined : { id: c.id, chainId: c.chainId } });
    const best = hits.wallets[0];
    // Only the box's read, of every kind, adds it: a page of one kind lists no best match.
    if (c === null || only !== undefined || bestKind(hits, parsed) !== 'wallets' || best === undefined || best.chainId !== c.chainId) return json(hits);
    const [anchors, tokens] = await Promise.all([s.ringsOf(c.id, { wallet: best.address }), s.walletTokens(c.chainId, best.address, c.address, CONNECTED)]);
    const rings = (await s.ringLines(c.id, anchors, { money: moneyFor(c.chainId) })).slice(0, CONNECTED);
    hits.connected = { wallet: best.address, rings: rings.map((r) => ({ anchor: r.anchor, rank: r.rank })), tokens };
    return json(hits);
  });
}
