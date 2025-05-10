import type { CollectionRow } from '@washtrace/detect';
import { ACTOR_HEADER } from '@/lib/auth';
import { addressOf, bad, chainOf, handle, json, readJson } from '@/lib/api';
import { configChange, effectiveRules } from '@/lib/collections';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ chain: string; address: string }> };

function body(c: CollectionRow) {
  return { chainId: c.chainId, address: c.address, name: c.name, overrides: c.rules, rules: effectiveRules(c.rules) };
}

/** GET: the collection's name, the rules it overrides, and the rules its analysis runs under. */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const collection = await store().collection(chainId, address);
    if (!collection) return bad('This collection is not watched.', 404);
    return json(body(collection));
  });
}

/**
 * POST `{name?, rules?}`: merge into the collection's settings. A key left out
 * is left alone; a rule set to null goes back to its default. A changed rule
 * queues the collection for analysis, so its flags follow within a pass.
 */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const raw = await readJson(req);
    if (raw instanceof Response) return raw;
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const change = configChange(raw);
    if (typeof change === 'string') return bad(change);
    const collection = await store().configure(chainId, address, change);
    if (!collection) return bad('This collection is not watched.', 404);
    const actor = decodeURIComponent(req.headers.get(ACTOR_HEADER) ?? 'anonymous');
    console.info('[washtrace] %s configured %d/%s: %s', actor, chainId, address, JSON.stringify(change));
    return json(body(collection));
  });
}
