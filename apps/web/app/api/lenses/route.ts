import { handle, json, writeBody } from '@/lib/api';
import { collectionIdsOf, collectionRaced, lensFields, nameRaced, notWatched, taken } from '@/lib/lens-api';
import { store } from '@/lib/store';

/**
 * POST `{ name, rule, chainId, address }`: save a lens of yours and queue its
 * run on that collection; or `{ name, rule, collections: [{chainId, address}] }`
 * to queue it on each (the Lab's Save and run on N). The rule is checked again
 * here, and the name must be new (a built-in's included). 201 `{ lens }`.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const fields = lensFields(written.body);
    if (fields instanceof Response) return fields;
    const s = store();
    const ids = await collectionIdsOf(s, written.body);
    if (ids instanceof Response) return ids;
    if (await s.nameTaken(fields.name)) return taken(fields.name);
    try {
      // The lens and its first run in one statement: a failure leaves neither, so a retry never hits 409. The others are queued after it.
      const lens = await s.createLens(fields.name, fields.rule, ids[0]);
      for (const id of ids.slice(1)) await s.requestLensRun(lens.id, id);
      console.info('[washtrace] %s created lens %d', written.actor, lens.id);
      return json({ lens }, 201);
    } catch (err) {
      if (nameRaced(err)) return taken(fields.name);
      if (collectionRaced(err)) return notWatched();
      throw err;
    }
  });
}
