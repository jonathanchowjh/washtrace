import { addressOf, bad, chainOf, handle, json, writeBody } from '@/lib/api';
import { configFromSources, hopsFollowed } from '@/lib/settings';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/** The most hops follow.hops allows (env.ts hops()), so a collection's own limit keeps the setting's bound. The lens editor keeps the same number (data-needs.tsx). */
const MOST = 10;

/**
 * POST `{ hops }`: follow this collection's money out to `hops`, past the
 * global follow.hops, for this collection only (Fetch them). The worker seeds
 * and reads the wallets in its own time, so the answer is 202. Pressed twice,
 * or with a limit it already has, it changes nothing and answers 200
 * `{ set: false }`. A limit at or below the global one frees no quota, so it
 * is refused rather than stored.
 */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const { hops } = written.body;
    if (typeof hops !== 'number' || !Number.isInteger(hops) || hops < 1 || hops > MOST) return bad(`hops is a whole number from 1 to ${MOST}.`);
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const s = store();
    const c = await s.collection(chainId, address);
    if (!c) return bad('This collection is not watched.', 404);
    const global = hopsFollowed(configFromSources(await s.sources(), await s.settings()));
    if (hops <= global) return bad(`Every collection is already followed ${global} hops out: ask for more than that.`);
    const set = await s.followFurther(c.id, hops);
    if (set === 'gone') return bad('This collection is not watched.', 404);
    if (set === 'set') console.info('[washtrace] %s follows %d/%s out to %d hops', written.actor, chainId, address, hops);
    return json({ set: set === 'set' }, set === 'set' ? 202 : 200);
  });
}
