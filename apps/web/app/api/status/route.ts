import { handle, json } from '@/lib/api';
import { workerConfig, workerEnabled } from '@/lib/config';
import { status } from '@/lib/status';
import { store } from '@/lib/store';

/**
 * GET: is the detector keeping up. Each job's state, each collection's lag,
 * the funding queue, and `problems`: what needs a person, in sentences.
 * Unlike /api/health this is about the chain sources too, and asks for auth.
 */
export async function GET(): Promise<Response> {
  return handle(async () => {
    const s = store();
    const [passes, collections, funding] = await Promise.all([s.passes(), s.collections(), s.fundingBacklog()]);
    return json(status({ passes, collections, funding, config: workerConfig(process.env), worker: workerEnabled(process.env) }, Date.now()));
  });
}
