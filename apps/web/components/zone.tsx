'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
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
 */
export function ZonePicker() {
  const router = useRouter();
  const choice = useZoneChoice();
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []), []);

  // First visit, or a detected zone that no longer matches where the reader is: store it, and let the server re-bucket.
  useEffect(() => {
    const now = detectedZone();
    const stored = parseZone(cookie());
    if (stored === null || (stored.auto && stored.zone !== now)) {
      write(`auto:${now}`);
      router.refresh();
    }
  }, [router]);

  if (choice === null) return <span className="block h-[52px]" />;
  const value = choice.auto ? 'auto' : choice.zone;
  return (
    <label className="block px-2 text-xs text-muted-foreground">
      <span className="mb-1 block text-[11px] font-medium tracking-wide uppercase">Times shown in</span>
      <select
        value={value}
        onChange={(e) => { write(e.target.value === 'auto' ? `auto:${detectedZone()}` : e.target.value); router.refresh(); }}
        className="w-full rounded-[5px] border bg-card px-1.5 py-1 text-xs text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      >
        <option value="auto">Detect automatically ({detectedZone()})</option>
        {zones.includes(choice.zone) || choice.auto ? null : <option value={choice.zone}>{choice.zone}</option>}
        {zones.map((z) => <option key={z} value={z}>{z.replaceAll('_', ' ')}</option>)}
      </select>
    </label>
  );
}
