import { NextResponse, type NextRequest } from 'next/server';
import { connection } from 'next/server';
import { txHref } from '@/lib/links';
import { addressOf, chainOf, txOf } from '@/lib/params';
import { parseSearch } from '@/lib/search';
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
  const to = (path: string) => NextResponse.redirect(new URL(path, req.url), 303);
  const tx = txOf(q);
  if (tx && given !== null) return to(`/tx/${given}/${tx}`);
  const address = addressOf(q);
  if (address && given !== null) {
    const watched = await store().collection(given, address).catch(() => null);
    return to(watched ? `/c/${given}/${address}` : `/w/${given}/${address}`);
  }
  const results = `/search?q=${encodeURIComponent(q)}`;
  const parsed = parseSearch(q);
  if (parsed.kind === 'empty') return to(results);
  const hits = await store().search(parsed).catch(() => null);
  if (address && hits !== null) {
    // A watched collection's contract can also have traded as a wallet; the collection is what was meant.
    if (hits.collections.length === 1 && !hits.more.collections) return to(`/c/${hits.collections[0]!.chainId}/${address}`);
    if (hits.collections.length === 0 && hits.wallets.length === 0) return to(`/w/1/${address}`);
  }
  // A hash's hits are its transfers, which its page lists in full: more of them past the limit is still one transaction.
  const cut = hits !== null && Object.entries(hits.more).some(([k, more]) => more && !(parsed.kind === 'tx' && k === 'trades'));
  if (hits === null || cut) return to(results);
  // One page each, so a transaction's several transfers are one hit.
  const found = new Set([
    ...hits.collections.map((h) => `/c/${h.chainId}/${h.address}`),
    ...hits.tokens.map((h) => `/c/${h.chainId}/${h.address}/t/${h.tokenId}`),
    ...hits.wallets.map((h) => `/w/${h.chainId}/${h.address}`),
    // Under its collection's tabs when every transfer of it is in that one collection; past one page of hits that is not known.
    ...hits.trades.map((h) => txHref(h.chainId, h.txHash, !hits.more.trades && hits.trades.every((o) => o.txHash !== h.txHash || o.address === h.address) ? `/c/${h.chainId}/${h.address}` : null)),
  ]);
  return to(found.size === 1 ? [...found][0]! : results);
}
