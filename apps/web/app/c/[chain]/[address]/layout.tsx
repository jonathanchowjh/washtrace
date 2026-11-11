import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { CollectionNav } from '@/components/collection-nav';
import { lensKeyOf } from '@/lib/api';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { short } from '@/lib/format';
import { addressOf, chainOf } from '@/lib/params';

type Props = { params: Promise<{ chain: string; address: string }>; children: ReactNode };

/**
 * Every page of one collection sits under its parent line and tab bar, so a
 * token, a list or a trade always says which collection it belongs to and
 * which part of it the reader is in. The counts come after the page, from
 * the browser: a slow count never holds the page back, and a prefetch of a
 * tab never reads them.
 */
export default async function CollectionLayout({ params, children }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const c = await collectionOf(chainId, address);
  if (!c) notFound();
  // The page under it reads the same runs, from the same request's cache.
  const runs = await runsOf(c.id);
  const lenses = [...METHODS, ...runs.map((r) => r.lens.key)];
  // Each lens's counts are read by the browser, once a page and again when an analysis, a read or (for yours) a run changes them:
  // here they ran for every prefetch and refresh. Only the lens in view is asked for.
  const stamp = `analysis=${c.latest?.id ?? 'none'}&transfers=${c.transfers}`;
  const finished = new Map<string, number | 'none'>(runs.map((r) => [r.lens.key, r.run?.finishedAt ?? 'none']));
  const counts = Object.fromEntries(lenses.map((m) => [m,
    `/api/collections/${chainId}/${address}/counts?method=${encodeURIComponent(m)}&${stamp}${finished.has(m) ? `&run=${finished.get(m)}` : ''}`]));
  return (
    <>
      <CollectionNav base={`/c/${chainId}/${address}`} name={c.name ?? short(address)} analyzedAt={c.latest?.ranAt ?? null} lenses={lenses}
        opensOn={lensKeyOf(null, {})} counts={counts} rings={c.latest?.rings ?? null} />
      {children}
    </>
  );
}
