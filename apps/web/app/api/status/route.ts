import { cookies } from 'next/headers';
import { handle, json } from '@/lib/api';
import { statusReport } from '@/lib/views';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';

/**
 * GET: is the detector keeping up. Each job's state, each collection's lag,
 * the funding queue, and `notices`: sentences, each
 * marked needs-you, working or info.
 * Unlike /api/health this is about the chain sources too, and asks for auth.
 */
export async function GET(): Promise<Response> {
  return handle(async () => {
    // The reader's zone when a browser asks, for the dates in the notices; UTC otherwise.
    const zone = parseZone((await cookies()).get(ZONE_COOKIE)?.value)?.zone;
    return json((await statusReport(zone)).report);
  });
}
