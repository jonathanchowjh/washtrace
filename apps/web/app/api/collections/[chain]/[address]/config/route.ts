import type { CollectionRow } from '@washtrace/detect';
import { addressOf, chainOf } from '@/lib/params';
import { bad, collectionFrom, handle, json, writeBody } from '@/lib/api';
import { configChange, effectiveRules } from '@/lib/collections';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ chain: string; address: string }> };

function body(c: CollectionRow) {
  return { chainId: c.chainId, address: c.address, name: c.name, overrides: c.rules, rules: effectiveRules(c.rules), priority: c.priority };
}

/** GET: the collection's name, the rules it overrides, and the rules its analysis runs under. */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    return json(body(found.collection));
  });
}

/**
 * POST `{name?, rules?, priority?}`: merge into the collection's settings. A key left out
 * is left alone; a rule set to null goes back to its default. A changed rule
 * queues the collection for analysis, so its flags follow within a pass.
 */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const change = configChange(written.body);
    if (typeof change === 'string') return bad(change);
    const collection = await store().configure(chainId, address, change);
    if (!collection) return bad('This collection is not watched.', 404);
    console.info('[washtrace] %s configured %d/%s: %s', written.actor, chainId, address, JSON.stringify(change));
    return json(body(collection));
  });
}
