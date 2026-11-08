import { handle, json, writeBody } from '@/lib/api';
import { collectionIdOf, collectionRaced, lensIdFromPath, lensRaced, noLens, notWatched } from '@/lib/lens-api';
import { store } from '@/lib/store';

/** POST `{ chainId, address }`: queue one of your lenses to run on a watched collection. A run already running is left alone. 202 `{ queued: true }`. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const id = lensIdFromPath((await params).id);
    if (id === null) return noLens();
    const s = store();
    if ((await s.lens(id).catch(() => ({}))) === null) return noLens();
    const collectionId = await collectionIdOf(s, written.body);
    if (collectionId instanceof Response) return collectionId;
    try {
      await s.requestLensRun(id, collectionId);
    } catch (err) {
      if (collectionRaced(err)) return notWatched();
      if (lensRaced(err)) return noLens();
      throw err;
    }
    console.info('[washtrace] %s ran lens %d here', written.actor, id);
    return json({ queued: true }, 202);
  });
}
