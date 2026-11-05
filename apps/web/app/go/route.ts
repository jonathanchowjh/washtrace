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
 */
export async function GET(req: NextRequest): Promise<Response> {
  await connection();
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const chainId = chainOf(req.nextUrl.searchParams.get('chain') ?? '1') ?? 1;
  const to = (path: string) => NextResponse.redirect(new URL(path, req.url), 303);
  const tx = txOf(q);
  if (tx) return to(`/tx/${chainId}/${tx}`);
  const address = addressOf(q);
  if (address) {
    const watched = await store().collection(chainId, address).catch(() => null);
    return to(watched ? `/c/${chainId}/${address}` : `/w/${chainId}/${address}`);
  }
  const results = `/search?q=${encodeURIComponent(q)}`;
  const parsed = parseSearch(q);
  if (parsed.kind === 'empty') return to(results);
  const hits = await store().search(parsed).catch(() => null);
  if (hits === null || Object.values(hits.more).some(Boolean)) return to(results);
  const found = [
    ...hits.collections.map((h) => `/c/${h.chainId}/${h.address}`),
    ...hits.tokens.map((h) => `/c/${h.chainId}/${h.address}/t/${h.tokenId}`),
    ...hits.wallets.map((h) => `/w/${h.chainId}/${h.address}`),
    ...hits.trades.map((h) => `/tx/${h.chainId}/${h.txHash}`),
  ];
  return to(found.length === 1 ? found[0]! : results);
}
