import { METHODS, type Lens, type Method } from '@washtrace/detect';
import { COPIES, DEFAULT_RULE, INT4_MAX, NAME_MAX, checkRule, nameError, type LensRule } from '@washtrace/detect/lens-rule';
import { bad } from './api';
import { addressOf, chainIdOf } from './params';
import { LENSES } from './format';

/**
 * What the three lens routes share: reading a lens id, a name and a rule from
 * a request, and the refusals they answer alike. The rule is checked here as
 * the editor checked it, because the editor is not the only caller.
 */

export const noLens = (): Response => bad('No such lens.', 404);
export const taken = (name: string): Response => bad(`Another lens is already called "${name}".`, 409);
export const notWatched = (): Response => bad('This collection is not watched.', 404);

/** A lens id in a route's path (`/api/lenses/7`): digits that fit the int4 column. Built-in keys (A, AU, AC) and anything else are not ids. Not trades' lensIdOf, which reads a key (L7). */
export function lensIdFromPath(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return id >= 1 && id <= INT4_MAX ? id : null;
}

/** The lens's trimmed name and checked rule from a body, or the 400 saying what is wrong. */
export function lensFields(body: Record<string, unknown>): { name: string; rule: LensRule } | Response {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const refused = nameError(name);
  if (refused !== null) return bad(refused);
  const checked = checkRule(body.rule);
  return 'error' in checked ? bad(checked.error) : { name, rule: checked.rule };
}

/** The id of the watched collection a body names, or the 404 saying it is not one. */
export async function collectionIdOf(
  s: { collection(chainId: number, address: string): Promise<{ id: number } | null> },
  body: Record<string, unknown>,
): Promise<number | Response> {
  const chainId = chainIdOf(body.chainId);
  const address = typeof body.address === 'string' ? addressOf(body.address) : null;
  if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
  const c = await s.collection(chainId, address);
  return c ? c.id : notWatched();
}

/** The unique index on lower(name) refusing an insert or update that raced the name check. */
export const nameRaced = (err: unknown): boolean => (err as { code?: string } | null)?.code === '23505';

/**
 * The run's foreign key refusing a write that queues a run on a collection
 * removed since collectionIdOf found it. The collection is gone, so the write
 * answers as if it had never been found: notWatched, not a 500.
 */
export const collectionRaced = (err: unknown): boolean => {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23503' && e.constraint === 'lens_runs_collection_id_fkey';
};

/**
 * The run's foreign key refusing Run here on a lens deleted since the route
 * found it: the insert saw the lens, then its key check waited for the delete
 * and failed. The lens is gone, so it answers noLens, not a 500.
 */
export const lensRaced = (err: unknown): boolean => {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23503' && e.constraint === 'lens_runs_lens_id_fkey';
};

/**
 * What the editor opens with for `?lens=new`, `copy-<key>` or `edit-L<id>`
 * (the key of a built-in or one of your lenses), or null for anything else, so
 * the page ignores the parameter. The copy of a built-in is its closest rule;
 * a copy of a lens of yours is its rule as saved.
 */
export function editorStart(raw: string | undefined, yours: readonly Lens[]): {
  title: string; name: string; rule: LensRule; differs: string | null; lensId?: number;
} | null {
  if (raw === 'new') return { title: 'New lens', name: '', rule: DEFAULT_RULE, differs: null };
  const [verb, ...rest] = (raw ?? '').split('-');
  const key = rest.join('-');
  const own = yours.find((l) => l.key === key);
  if (verb === 'edit' && own) return { title: own.name, name: own.name, rule: own.rule, differs: null, lensId: own.id };
  if (verb !== 'copy') return null;
  const copyName = (n: string) => `${n} (copy)`.slice(0, NAME_MAX);
  if (own) return { title: `Copy of ${own.name}`, name: copyName(own.name), rule: own.rule, differs: null };
  if (!METHODS.includes(key as Method)) return null;
  const m = key as Method;
  return { title: `Copy of ${LENSES[m].name}`, name: copyName(LENSES[m].name), rule: COPIES[m].rule, differs: COPIES[m].differs };
}
