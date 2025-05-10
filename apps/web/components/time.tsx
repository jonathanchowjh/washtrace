'use client';

import { localTime, type TimeStyle } from '@/lib/format';
import { useZone } from './zone';

/**
 * A moment in the reader's zone, detected or chosen in the sidebar. The
 * server cannot know that zone, so it renders a placeholder and the browser
 * fills in the clock time on hydration, with no mismatch between the two.
 */
export function Time({ ms, style = 'datetime' }: { ms: number; style?: TimeStyle }) {
  const zone = useZone();
  const iso = new Date(ms).toISOString();
  return <time dateTime={iso} title={zone === null ? iso : `${localTime(ms, 'datetime', zone)} (${zone})`}>{zone === null ? '…' : localTime(ms, style, zone)}</time>;
}
