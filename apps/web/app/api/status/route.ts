import { handle, json } from '@/lib/api';
import { configFromSources } from '@/lib/settings';
import { status } from '@/lib/status';
import { store } from '@/lib/store';

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
    return json(status({ passes, collections, funding, config: configFromSources(sources, settings) }, Date.now()));
  });
}
