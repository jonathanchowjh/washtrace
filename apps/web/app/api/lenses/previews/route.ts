import { bad, handle, json, writeBody } from '@/lib/api';
import { collectionIdOf } from '@/lib/lens-api';
import { store } from '@/lib/store';
import { checkRule } from '@washtrace/detect/lens-rule';

/**
 * POST `{ chainId, address, rule }`: queue a preview of a rule that is not
 * saved, on a sample of that collection's sales. The rule is checked here as
 * the editor checked it. 202 `{ id }`, which the editor polls; 409 when the
 * collection has nothing to sample.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const checked = checkRule(written.body.rule);
    if ('error' in checked) return bad(checked.error);
    const s = store();
    const collectionId = await collectionIdOf(s, written.body);
    if (collectionId instanceof Response) return collectionId;
    const queued = await s.requestPreview(collectionId, checked.rule);
    if (queued === 'no-sales') return bad('This collection has no sales to preview on.', 409);
    if (queued === 'not-analysed') return bad('This collection has not been analysed yet, so there is nothing to preview on.', 409);
    return json({ id: queued.id }, 202);
  });
}
