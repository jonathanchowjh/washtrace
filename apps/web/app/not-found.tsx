'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Head } from '@/components/ui';
import { chainName } from '@/lib/chains';
import { scopeOfPath } from '@/lib/search';

/**
 * Any address nothing answers. Under /c/ it is a collection the layout did not
 * find, so the page says it is not watched and offers to watch it; a missing
 * token, wallet or ring of a watched one lands on the collection's own
 * not-found instead. A client component: a not-found page gets no params, and
 * the path is the only place the asked collection is written.
 */
export default function NotFound() {
  const asked = scopeOfPath(usePathname());
  if (asked === null) {
    return (
      <>
        <Head title="Not found" />
        <div className="rounded-lg border bg-card p-4 text-sm sm:p-5">
          <p className="text-foreground">Nothing is at this address.</p>
          <p className="mt-3"><Link href="/" className="underline">Back to Collections</Link></p>
        </div>
      </>
    );
  }
  return (
    <>
      <Head title="Not watched" sub="washtrace only reads the collections it is told to watch." />
      <div className="rounded-lg border bg-card p-4 text-sm sm:p-5">
        <p className="font-medium text-foreground">This collection is not watched.</p>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Chain</dt><dd>{chainName(asked.chainId)}</dd>
          <dt className="text-muted-foreground">Contract</dt><dd className="font-mono [overflow-wrap:anywhere]">{asked.address}</dd>
        </dl>
        <p className="mt-3">Watch it and the worker reads its transfers from the chain, then judges its trades.</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* The home page holds the watch form: this opens it. */}
          <Link href={`/?watch=${asked.chainId}:${asked.address}`} className="btn">Watch it</Link>
          <Link href="/" className="underline">Back to Collections</Link>
        </div>
      </div>
    </>
  );
}
