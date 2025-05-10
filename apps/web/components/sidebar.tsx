'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { short } from '@/lib/format';
import { ZonePicker } from './zone';

const ITEM = 'flex items-center gap-2 rounded-[5px] px-2 py-1 whitespace-nowrap hover:bg-muted hover:text-foreground '
  + 'aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground';

/**
 * Collections, each watched collection by name, the worker, and a search box
 * that takes a wallet, a collection or a transaction. Under 768 px it is one
 * row that scrolls sideways, above the page.
 */
export function Sidebar({ watched }: { watched: { chainId: number; address: string; name: string | null }[] }) {
  const path = usePathname();
  const current = (href: string, exact = false) => (exact ? path === href : path === href || path.startsWith(`${href}/`)) ? 'page' : undefined;
  return (
    <aside className="flex items-center gap-1 overflow-x-auto border-b bg-sidebar p-2 text-[13px]/5 md:sticky md:top-0 md:h-screen md:flex-col md:items-stretch md:gap-3.5 md:self-start md:overflow-y-auto md:border-r md:border-b-0 md:px-2.5 md:py-3.5">
      <Link href="/" className="px-2 md:pb-1">
        <span className="block font-mono font-semibold text-foreground">washtrace</span>
        <span className="block text-xs text-muted-foreground max-md:hidden">NFT wash trading detector</span>
      </Link>
      <form action="/go" className="max-md:hidden">
        <label className="sr-only" htmlFor="q">Wallet, collection or transaction</label>
        <input
          id="q" name="q" placeholder="Search address or tx"
          className="w-full rounded-[5px] border bg-card px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        />
      </form>
      <nav aria-label="Collections" className="flex gap-px md:flex-col">
        <Link href="/" aria-current={current('/', true)} className={ITEM}>All collections</Link>
        {watched.map((c) => {
          const href = `/c/${c.chainId}/${c.address}`;
          return (
            <Link key={href} href={href} aria-current={current(href)} className={`${ITEM} md:pl-5`}>
              <span className="truncate">{c.name ?? short(c.address)}</span>
            </Link>
          );
        })}
      </nav>
            <nav aria-label="Service" className="flex md:mt-auto md:flex-col">
        <span className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase max-md:hidden">Behind the numbers</span>
        <Link href="/worker" aria-current={current('/worker')} className={ITEM}>Worker</Link>
      </nav>
      <div className="max-md:hidden"><ZonePicker /></div>
    </aside>
  );
}
