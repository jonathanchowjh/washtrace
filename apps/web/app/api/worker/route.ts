import { cookies } from 'next/headers';
import { handle, json } from '@/lib/api';
import { workerView } from '@/lib/views';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';

/** GET: each job's last pass, the funding backlog per chain, and which sources are configured (never their values). */
export async function GET(): Promise<Response> {
  // The reader's zone when a browser asks, for the dates in the notices; UTC otherwise.
  return handle(async () => json(await workerView(parseZone((await cookies()).get(ZONE_COOKIE)?.value)?.zone)));
}
