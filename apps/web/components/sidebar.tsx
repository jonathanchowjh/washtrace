'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LENSES, short } from '@/lib/format';
import type { Watched } from '@/lib/search';
import { INLINE_ICON, KindIcon, TierMark } from './kit';
import { SearchBox } from './search-box';
import { ZonePicker } from './zone';

type Theme = 'light' | 'dark';

/** The theme the page shows now: the saved choice stamped on <html> by the layout's script, else the OS's. */
function effective(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Switches the console between light and dark. Until it is pressed the console
 * follows the OS; a press is kept in this browser (localStorage can be blocked,
 * and then the choice lasts only until the page is closed).
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(effective()), []);

  if (theme === null) return <span className="block h-7 w-28" />;
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} mode`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('washtrace.theme', next); } catch { /* blocked storage: follow the OS next visit */ }
        setTheme(next);
      }}
      className="field flex items-center gap-2 whitespace-nowrap hover:bg-muted"
    >
      <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0">
        {next === 'dark'
          ? <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />
          : <><circle cx="8" cy="8" r="2.75" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></>}
      </svg>
      {next === 'dark' ? 'Dark mode' : 'Light mode'}
    </button>
  );
}

const ITEM = 'flex items-center gap-2 rounded-md px-2 py-1 whitespace-nowrap hover:bg-muted hover:text-foreground '
  + 'aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground';

/**
 * Collections, each watched collection by name, the worker and its settings, and a search box
 * that takes a collection name, a token number, a wallet or a transaction. Under 768 px it is
 * a header above the page, read in order: the name and the search box on one row, then the
 * links, wrapping onto as many rows as they need. A row that scrolled sideways hid Settings and
 * the theme past a phone's edge, and a fade at that edge did not say enough that they were there.
 */
export function Sidebar({ watched }: { watched: Watched[] }) {
  const path = usePathname();
  const current = (href: string, exact = false) => (exact ? path === href : path === href || path.startsWith(`${href}/`)) ? 'page' : undefined;
  return (
    // The wrapper stretches to the grid row, so the sidebar's ground and edge run the page's full height; the aside inside stays put while the page scrolls.
    <div className="bg-sidebar md:border-r">
      {/* Under 768 px the name leads and the search box takes the rest of its row, above the links, so its type-ahead list opens over the page rather than among them. */}
      <div className="flex items-center gap-1 border-b p-2 md:hidden">
        <Link href="/" className="shrink-0 px-2 font-mono text-[13px]/5 font-semibold text-foreground">washtrace</Link>
        <SearchBox id="q-top" className="min-w-0 flex-1" watched={watched} wide={false} />
      </div>
      <aside className="flex flex-wrap items-center gap-1 border-b bg-sidebar p-2 text-[13px]/5 md:sticky md:top-0 md:h-screen md:flex-col md:flex-nowrap md:items-stretch md:gap-3.5 md:overflow-y-auto md:border-b-0 md:px-2.5 md:py-3.5">
        <Link href="/" className="px-2 pb-1 max-md:hidden">
          <span className="block font-mono font-semibold text-foreground">washtrace</span>
          <span className="block text-xs text-muted-foreground">NFT wash trading detector</span>
        </Link>
        <SearchBox id="q" className="max-md:hidden" watched={watched} wide />
        <nav aria-label="Collections" className="flex flex-wrap gap-px md:flex-col">
          <Link href="/" aria-current={current('/', true)} className={ITEM}>All collections</Link>
          {watched.map((c) => {
            const href = `/c/${c.chainId}/${c.address}`;
            return (
              <Link key={href} href={href} aria-current={current(href)} className={`${ITEM} md:pl-5`}>
                <KindIcon kind="collection" className={INLINE_ICON} />
                <span className="truncate">{c.name ?? short(c.address)}</span>
                {/* Where its washed sales fall, floor to ceiling, in the marks the lenses wear everywhere; a screen reader hears the range as words. */}
                {c.range === null ? null : (
                  <>
                    <span aria-hidden title={c.range.low === c.range.high ? LENSES[c.range.low].name : `${LENSES[c.range.low].name} → ${LENSES[c.range.high].name}`} className="ml-auto flex shrink-0 items-center gap-1">
                      <TierMark tone={LENSES[c.range.low].tone} />{c.range.low === c.range.high ? null : <TierMark tone={LENSES[c.range.high].tone} />}
                    </span>
                    <span className="sr-only">, {c.range.low === c.range.high ? LENSES[c.range.low].name : `${LENSES[c.range.low].name} to ${LENSES[c.range.high].name}`}</span>
                  </>
                )}
              </Link>
            );
          })}
        </nav>
        <nav aria-label="Service" className="flex flex-wrap items-center gap-1 md:mt-auto md:flex-col md:items-stretch">
          <span className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase max-md:hidden">Behind the numbers</span>
          <Link href="/lab" aria-current={current('/lab')} className={ITEM}>Lab<span className="text-xs text-muted-foreground max-md:hidden">your lenses</span></Link>
          <Link href="/worker" aria-current={current('/worker')} className={ITEM}>Worker</Link>
          <Link href="/settings" aria-current={current('/settings')} className={ITEM}>Settings</Link>
          <ThemeToggle />
        </nav>
        <div className="max-md:hidden"><ZonePicker /></div>
      </aside>
    </div>
  );
}

