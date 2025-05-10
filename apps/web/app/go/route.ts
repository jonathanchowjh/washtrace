import { NextResponse, type NextRequest } from 'next/server';
import { connection } from 'next/server';
import { addressOf, chainOf, txOf } from '@/lib/api';
import { store } from '@/lib/store';

/**
 * The sidebar's search: a transaction hash goes to its transaction, a watched
 * collection's address to the collection, any other address to the wallet.
 */
export async function GET(req: NextRequest): Promise<Response> {
  await connection();
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const chainId = chainOf(req.nextUrl.searchParams.get('chain') ?? '1') ?? 1;
  const to = (path: string) => NextResponse.redirect(new URL(path, req.url), 303);
  const tx = txOf(q);
  if (tx) return to(`/tx/${chainId}/${tx}`);
  const address = addressOf(q);
  if (!address) return to(`/?q=${encodeURIComponent(q)}`);
  const watched = await store().collection(chainId, address).catch(() => null);
  return to(watched ? `/c/${chainId}/${address}` : `/w/${chainId}/${address}`);
}
