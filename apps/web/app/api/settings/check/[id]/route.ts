import { authConfigured } from '@/lib/auth';
import { bad, handle, json } from '@/lib/api';
import { READ_ONLY } from '@/lib/settings';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET: a Test as it stands, `{ finished, ok, detail }`, which the settings
 * page polls until finished. Gated like the request that made it, since a
 * check's detail describes the owner's sources.
 */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    if (!authConfigured(process.env)) return bad(READ_ONLY, 403);
    const { id } = await params;
    const row = /^\d{1,15}$/.test(id) ? await store().check(Number(id)) : null;
    return row ? json(row) : bad('No such check.', 404);
  });
}
