import { bad, handle, idOf, json, refuseWrite } from '@/lib/api';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET: a Test as it stands, `{ finished, ok, detail }`, which the settings
 * page polls until finished. Gated like the request that made it, since a
 * check's detail describes the owner's sources.
 */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const refused = refuseWrite(req);
    if (refused) return refused;
    const { id } = await params;
    const n = idOf(id);
    const row = n === null ? null : await store().check(n);
    return row ? json(row) : bad('No such check.', 404);
  });
}
