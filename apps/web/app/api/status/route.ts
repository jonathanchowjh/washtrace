import { cookies } from 'next/headers';
import { handle, json } from '@/lib/api';
import { configFromSources } from '@/lib/settings';
import { status } from '@/lib/status';
import { store, storedManifest } from '@/lib/store';
import { trailFunded } from '@/lib/views';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';

/**
 * GET: is the detector keeping up. Each job's state, each collection's lag,
 * the funding queue, and `notices`: sentences, each
 * marked needs-you, working or info.
 * Unlike /api/health this is about the chain sources too, and asks for auth.
 */
export async function GET(): Promise<Response> {
  return handle(async () => {
    const s = store();
    const [passes, collections, funding, sources, settings] = await Promise.all([s.passes(), s.collections(), s.fundingBacklog(), s.sources(), s.settings()]);
    // The worker's report of its sources, never this process's environment.
    // The reader's zone when a browser asks, for the dates in the notices; UTC otherwise.
    const zone = parseZone((await cookies()).get(ZONE_COOKIE)?.value)?.zone;
    const config = configFromSources(sources, settings);
    // The worker page's and Settings' answer, so the notice about it says the same.
    const fed = config.funding ? false : await trailFunded(s, collections);
    return json(status({ passes, collections, funding, config, trailFunded: fed, manifest: await storedManifest() }, Date.now(), zone));
  });
}
