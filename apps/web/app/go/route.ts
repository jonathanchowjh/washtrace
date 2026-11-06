import { NextResponse, type NextRequest } from 'next/server';
import { connection } from 'next/server';
import { addressOf, chainOf, txOf } from '@/lib/api';
import { parseSearch } from '@/lib/search';
import { store } from '@/lib/store';

/**
 * The sidebar's search: a transaction hash goes to its transaction, a watched
 * collection's address to the collection, any other address to the wallet.
 * Anything else goes straight to the one thing it finds, or to the results
 * when it finds none or several, so a search never ends on a blank page.
 *
 * A pasted hash carries no chain, so with none given it is searched for as
 * text is, and goes to the chain that holds it.
 */
export async function GET(req: NextRequest): Promise<Response> {
  await connection();
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const given = chainOf(req.nextUrl.searchParams.get('chain') ?? '');
  const chainId = given ?? 1;
  const to = (path: string) => NextResponse.redirect(new URL(path, req.url), 303);
  const tx = txOf(q);
  if (tx && given !== null) return to(`/tx/${given}/${tx}`);
  const address = addressOf(q);
  if (address) {
    const watched = await store().collection(chainId, address).catch(() => null);
    return to(watched ? `/c/${chainId}/${address}` : `/w/${chainId}/${address}`);
  }
  const results = `/search?q=${encodeURIComponent(q)}`;
  const parsed = parseSearch(q);
  if (parsed.kind === 'empty') return to(results);
  const hits = await store().search(parsed).catch(() => null);
  // A hash's hits are its transfers, which its page lists in full: more of them past the limit is still one transaction.
  const cut = hits !== null && Object.entries(hits.more).some(([k, more]) => more && !(parsed.kind === 'tx' && k === 'trades'));
  if (hits === null || cut) return to(results);
  // One page each, so a transaction's several transfers are one hit.
  const found = new Set([
    ...hits.collections.map((h) => `/c/${h.chainId}/${h.address}`),
    ...hits.tokens.map((h) => `/c/${h.chainId}/${h.address}/t/${h.tokenId}`),
    ...hits.wallets.map((h) => `/w/${h.chainId}/${h.address}`),
    ...hits.trades.map((h) => `/tx/${h.chainId}/${h.txHash}`),
  ]);
  return to(found.size === 1 ? [...found][0]! : results);
}
