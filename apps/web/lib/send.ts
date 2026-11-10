/**
 * Sends a write to one of the console's routes, as JSON (`{}` when there is no
 * body: the routes refuse anything that is not JSON): the body it answered,
 * parsed (or {} when there is none), when it took; else the error the route
 * gave, or what went wrong when it gave none. Every write the console makes
 * from the browser goes through it, so each says a failure the same way. `T` is
 * the body the caller's route answers, taken on its word, so what the caller
 * reads of it is type-checked; left out, the body is unknown.
 */
export async function send<T = unknown>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: object): Promise<{ error: null; body: T } | { error: string }> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).catch(() => null);
  const said = res ? await res.json().catch(() => ({})) : {};
  if (res?.ok) return { error: null, body: said };
  return { error: said.error ?? (res ? `The service answered ${res.status}.` : 'The service did not answer.') };
}
