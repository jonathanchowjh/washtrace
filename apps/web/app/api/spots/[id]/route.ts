import { bad, handle, json } from '@/lib/api';
import { lensIdFromPath } from '@/lib/lens-api';
import { store } from '@/lib/store';

/** GET: one spot check as its asker polls it. 404 once swept, a day after it was asked for. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    // Spot checks are numbered like lenses: an int4 serial, so the same path check reads it.
    const id = lensIdFromPath((await params).id);
    const found = id === null ? null : await store().spot(id);
    return found === null ? bad('No such spot check.', 404) : json(found);
  });
}
