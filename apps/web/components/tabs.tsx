'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export type Tab = 'sync' | 'paused' | 'all';

/** The browser's remembered default tab. */
const KEY = 'washtrace.collections.tab';

const TABS: Tab[] = ['sync', 'paused', 'all'];

/** The remembered tab, or `sync`. Storage can throw (a private window), and then there is nothing to remember. */
function remembered(): Tab {
  try {
    const v = localStorage.getItem(KEY);
    return TABS.find((t) => t === v) ?? 'sync';
  } catch {
    return 'sync';
  }
}

/**
 * The collections list split by whether the worker is reading each one. The
 * server filters the rows by `?tab=`; this draws the tabs with their counts,
 * and sends a visit with no `?tab=` to the tab this browser chose to open on.
 */
export function CollectionTabs({ counts, current }: { counts: { sync: number; paused: number; all: number; behind: number }; current: Tab }) {
  const router = useRouter();
  const named = useSearchParams().has('tab');
  // Storage is read after mount, so the server's markup and the first client render agree.
  const [open, setOpen] = useState<Tab>('sync');
  useEffect(() => setOpen(remembered()), []);

  useEffect(() => {
    if (named) return;
    const tab = remembered();
    if (tab !== 'sync') router.replace(`/?tab=${tab}`);
  }, [named, router]);

  const label: Record<Tab, string> = {
    sync: `In sync (${counts.sync}${counts.behind > 0 ? ` · ${counts.behind} behind` : ''})`,
    paused: `Paused (${counts.paused})`,
    all: `All (${counts.all})`,
  };

  function choose(tab: Tab) {
    setOpen(tab);
    try { localStorage.setItem(KEY, tab); } catch { /* nothing to remember it in */ }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <nav aria-label="Collections by whether the worker is reading them" className="flex max-w-full gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t} href={`/?tab=${t}`} aria-current={t === current ? 'page' : undefined}
            className={`whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium ${t === current ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >{label[t]}</Link>
        ))}
      </nav>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Which tab this page shows when you visit it, remembered in this browser">
        Open on
        <select
          value={open} onChange={(e) => choose(e.target.value as Tab)}
          className="rounded-[5px] border bg-card px-2 py-1 text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          <option value="sync">In sync</option>
          <option value="paused">Paused</option>
          <option value="all">All</option>
        </select>
      </label>
    </div>
  );
}
