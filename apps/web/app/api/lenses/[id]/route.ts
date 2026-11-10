import { handle, json, writeBody } from '@/lib/api';
import { collectionIdsOf, collectionRaced, lensFields, lensIdFromPath, nameRaced, noLens, notWatched, taken } from '@/lib/lens-api';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH `{ name, rule, chainId?, address? }`: change one of your lenses. Its
 * version moves and its runs are queued again in the same statement, so an
 * edit made while a run is in flight needs nothing more here: that run's save
 * finds its version behind. The collection, when named (the editor names the
 * one it was opened from), gets a run queued in that statement too, so Save
 * and run runs there even where the lens never ran. `collections` names
 * several, each queued in that statement.
 */
export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const id = lensIdFromPath((await params).id);
    if (id === null) return noLens();
    const fields = lensFields(written.body);
    if (fields instanceof Response) return fields;
    const s = store();
    // A lens whose stored rule no longer reads throws here; it may still be edited, which is how it is repaired.
    if ((await s.lens(id).catch(() => ({}))) === null) return noLens();
    const named = 'chainId' in written.body || 'address' in written.body || 'collections' in written.body;
    const runOn = named ? await collectionIdsOf(s, written.body) : [];
    if (runOn instanceof Response) return runOn;
    if (await s.nameTaken(fields.name, id)) return taken(fields.name);
    try {
      const lens = await s.updateLens(id, fields.name, fields.rule, runOn);
      if (!lens) return noLens();
      console.info('[washtrace] %s edited lens %d', written.actor, id);
      return json({ lens });
    } catch (err) {
      if (nameRaced(err)) return taken(fields.name);
      if (collectionRaced(err)) return notWatched();
      throw err;
    }
  });
}

/** DELETE: remove one of your lenses, with its runs and flags on every collection. A built-in has no id, so it is never found. */
export async function DELETE(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const id = lensIdFromPath((await params).id);
    if (id === null || !(await store().deleteLens(id))) return noLens();
    console.info('[washtrace] %s deleted lens %d', written.actor, id);
    return json({ deleted: true });
  });
}
