import { bad, handle, json } from '@/lib/api';
import { lensIdFromPath } from '@/lib/lens-api';
import { store } from '@/lib/store';

/**
 * GET: one preview as the editor polls it. 404 once it is swept (an hour
 * after it was asked for) or its collection is removed, which the editor
 * words as "run it again".
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    // Previews are numbered like lenses: an int4 serial, so the same path check reads it.
    const id = lensIdFromPath((await params).id);
    const found = id === null ? null : await store().preview(id);
    return found === null ? bad('This preview is gone. Run it again.', 404) : json(found);
  });
}
