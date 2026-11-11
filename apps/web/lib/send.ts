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

/**
 * Asks `url` for a row now, then every `every` ms while `done` says the row is
 * not final; `onRow` gets each row before the next ask is scheduled. A failed
 * ask (no answer, a body that is no JSON such as a proxy's error page, a
 * non-2xx, or a body with no string `status`) calls `onLost` and asks again; a
 * 404 (the row is gone) calls `onGone` with the body it gave, if any, and
 * stops. Returns the stop function, which a component's effect returns as its
 * cleanup: an answer that arrives after it is dropped.
 */
export function poll<T extends { status: string }>(url: string, opts: {
  every: number; done: (row: T) => boolean; onRow: (row: T) => void; onLost: () => void; onGone: (body: { error?: string } | null) => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function ask() {
    const res = await fetch(url).catch(() => null);
    const said = res ? await res.json().catch(() => null) : null;
    if (stopped) return;
    if (res?.status === 404) return opts.onGone(said);
    if (!res?.ok || typeof said?.status !== 'string') {
      opts.onLost();
      timer = setTimeout(ask, opts.every);
      return;
    }
    opts.onRow(said);
    if (!opts.done(said)) timer = setTimeout(ask, opts.every);
  }
  void ask();
  return () => { stopped = true; clearTimeout(timer); };
}
