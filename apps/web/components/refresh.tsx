'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-renders the page from the server on an interval. The worker writes on
 * its own clock; this only reads what it wrote.
 *
 * A tick that lands while a refresh is in flight is skipped, not queued; a
 * hidden tab does not poll; and the stamp is the moment the request started,
 * so "updated at" is never later than the data.
 */
export function Refresh({ everyMs = 15_000 }: { everyMs?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const busy = useRef(false);
  busy.current = pending;
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => {
      if (busy.current || document.visibilityState === 'hidden') return;
      setAt(Date.now());
      start(() => router.refresh());
    };
    const id = setInterval(tick, everyMs);
    return () => clearInterval(id);
  }, [everyMs, router]);

  return (
    <span className="text-xs text-muted-foreground" suppressHydrationWarning>
      {pending ? 'refreshing…' : at === null ? `live · every ${everyMs / 1000}s` : `updated ${new Date(at).toLocaleTimeString()}`}
    </span>
  );
}
