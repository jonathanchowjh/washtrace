import type { NextRequest } from 'next/server';
import { connection } from 'next/server';
import { txHref, walletHref } from '@/lib/links';
import { addressOf, chainOf, txOf } from '@/lib/params';
import { hitRow, parseSearch, scopeOf, scopeParam, tradeHref } from '@/lib/search';
import { store } from '@/lib/store';

/**
 * The sidebar's search: a transaction hash goes to its transaction, a watched
 * collection's address to the collection, any other address to the wallet.
 * Anything else goes straight to the one thing it finds, or to the results
 * when it finds none or several, so a search never ends on a blank page.
 *
 * A pasted hash or address carries no chain, and the sidebar sends none, so
 * with none given it is searched for as text is and goes to the chain that
 * holds it: a Base collection's address opens on Base, not as an empty wallet
 * on Ethereum. An address nothing holds still opens its wallet page, on
 * Ethereum, which says it is in no watched collection.
 */
export async function GET(req: NextRequest): Promise<Response> {
  await connection();
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const given = chainOf(req.nextUrl.searchParams.get('chain') ?? '');
  // A relative Location, which the browser resolves against the address it asked on. req.url is the server's
  // own: in the container it is the 0.0.0.0 it binds, so an absolute one sent the reader off to another host.
  const to = (path: string) => new Response(null, { status: 303, headers: { Location: path } });
  const tx = txOf(q);
  if (tx && given !== null) return to(txHref(given, tx));
  const address = addressOf(q);
  if (address && given !== null) {
    const watched = await store().collection(given, address).catch(() => null);
    return to(watched ? `/c/${given}/${address}` : walletHref(given, address));
  }
  // A search from inside a collection (the sidebar under /c/) is narrowed to it, and its results page says so.
  const scope = scopeOf(req.nextUrl.searchParams.get('scope'));
  const scoped = scope === null ? null : await store().collection(scope.chainId, scope.address).catch(() => null);
  const results = `/search?q=${encodeURIComponent(q)}${scoped && scope ? `&scope=${scopeParam(scope)}` : ''}`;
  const parsed = parseSearch(q);
  if (parsed.kind === 'empty') return to(results);
  const hits = await store().search(parsed, scoped ? { scope: { id: scoped.id, chainId: scoped.chainId } } : {}).catch(() => null);
  if (address && hits !== null) {
    // A watched collection's contract can also have traded as a wallet; the collection is what was meant.
    if (hits.collections.length === 1 && !hits.more.collections) return to(`/c/${hits.collections[0]!.chainId}/${address}`);
    if (hits.collections.length === 0 && hits.wallets.length === 0) return to(walletHref(1, address));
  }
  // A hash's hits are its transfers, which its page lists in full: more of them past the limit is still one transaction.
  const cut = hits !== null && Object.entries(hits.more).some(([k, more]) => more && !(parsed.kind === 'tx' && k === 'trades'));
  if (hits === null || cut) return to(results);
  // One page each, so a transaction's several transfers are one hit.
  const found = new Set([
    ...hits.collections.map((h) => `/c/${h.chainId}/${h.address}`),
    ...hits.tokens.map((h) => `/c/${h.chainId}/${h.address}/t/${h.tokenId}`),
    ...hits.wallets.map((_, i) => hitRow(hits, 'wallets', i, scoped ? scope : null).href),
    ...hits.trades.map((h) => tradeHref(hits, h)),
  ]);
  return to(found.size === 1 ? [...found][0]! : results);
}
