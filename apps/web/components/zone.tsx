'use client';

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { ZONE_COOKIE, detectedZone, parseZone, type ZoneChoice } from '@/lib/zone';

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

function cookie(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${ZONE_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

// A string snapshot, so useSyncExternalStore sees the same value until the cookie changes.
const snapshot = () => cookie() ?? `auto:${detectedZone()}`;

function write(value: string) {
  document.cookie = `${ZONE_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
  listeners.forEach((fn) => fn());
}

/** The reader's zone and whether it was detected. Null while rendering on the server, which cannot know it. */
export function useZoneChoice(): ZoneChoice | null {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  return useMemo(() => (raw === null ? null : parseZone(raw) ?? { zone: detectedZone(), auto: true }), [raw]);
}

export function useZone(): string | null {
  return useZoneChoice()?.zone ?? null;
}

/**
 * Where the reader picks the zone every time is shown in, detected by
 * default. A change is written to the cookie and the page is read again,
 * because the server buckets a collection's history by that zone's calendar.
 *
 * Not a native select: its popup is drawn by the OS, and 400+ zones make it
 * taller than the screen with no way to cap it. This is a small searchable
 * listbox whose height is capped, opening upward because the control sits at
 * the bottom of the sidebar.
 */
export function ZonePicker() {
  const router = useRouter();
  const choice = useZoneChoice();
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []), []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLButtonElement>(null);
  const id = useId();

  // First visit, or a detected zone that no longer matches where the reader is: store it, and let the server re-bucket.
  useEffect(() => {
    const now = detectedZone();
    const stored = parseZone(cookie());
    if (stored === null || (stored.auto && stored.zone !== now)) {
      write(`auto:${now}`);
      router.refresh();
    }
  }, [router]);

  // Clicking anywhere else closes the panel.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // The active option stays in view as the arrows move it.
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  if (choice === null) return <span className="block h-[52px]" />;

  // Detecting automatically is always first; the zone the cookie holds but the platform does not list comes next.
  const value = choice.auto ? 'auto' : choice.zone;
  const unlisted = zones.includes(choice.zone) || choice.auto ? [] : [choice.zone];
  const wanted = query.trim().toLowerCase().replaceAll('_', ' ');
  const matches = [...unlisted, ...zones].filter((z) => z.toLowerCase().replaceAll('_', ' ').includes(wanted));
  const options = [{ value: 'auto', text: `Detect automatically (${detectedZone()})` }, ...matches.map((z) => ({ value: z, text: z.replaceAll('_', ' ') }))];
  const current = Math.min(active, options.length - 1);

  const show = () => {
    setQuery('');
    // Found in the whole list, not in `options`, which the last search may still be filtering.
    setActive(Math.max(0, ['auto', ...unlisted, ...zones].indexOf(value)));
    setOpen(true);
  };
  const close = () => { setOpen(false); field.current?.focus(); };
  const pick = (v: string) => {
    write(v === 'auto' ? `auto:${detectedZone()}` : v);
    router.refresh();
    close();
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(current + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(current - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (wanted && matches.length === 0) return; pick(options[current]!.value); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  return (
    <div ref={root} className="relative block px-2 text-xs text-muted-foreground">
      <span id={`${id}-label`} className="mb-1 block text-[11px] font-medium tracking-wide uppercase">Times shown in</span>
      <button
        ref={field}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-field`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => { if (!open && ['Enter', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); show(); } }}
        className="w-full truncate rounded-[5px] border bg-card px-1.5 py-1 text-left text-xs text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      >
        <span id={`${id}-field`}>{choice.auto ? `Detect automatically (${choice.zone})` : choice.zone.replaceAll('_', ' ')}</span>
      </button>
      {open ? (
        <div className="absolute right-2 bottom-full left-2 z-20 mb-1 rounded-[5px] border bg-card p-1 shadow-md">
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={`${id}-${current}`}
            aria-label="Search zones"
            placeholder="Search zones"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(e.target.value.trim() ? 1 : 0); }}
            onKeyDown={onSearchKey}
            onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}
            className="mb-1 w-full rounded-[5px] border bg-background px-1.5 py-1 text-xs text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          />
          <ul id={`${id}-list`} role="listbox" onMouseDown={(e) => e.preventDefault()} aria-label="Times shown in" className="max-h-64 overflow-y-auto">
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={o.value === value}
                onClick={() => pick(o.value)}
                onMouseMove={() => setActive(i)}
                className={`cursor-pointer truncate rounded-[4px] px-1.5 py-1 text-foreground ${i === current ? 'bg-muted' : ''} ${o.value === value ? 'font-medium' : ''}`}
              >
                {o.text}
              </li>
            ))}
            {matches.length === 0 ? <li role="presentation" className="px-1.5 py-1">No zone matches</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
