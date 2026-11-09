import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE, checkRule } from '@washtrace/detect/lens-rule';

const ADDR = '0x' + 'ab'.repeat(20);
const lens = { id: 7, key: 'L7', name: 'Blur 3-hop', rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 };
const fake = {
  collection: vi.fn(async (): Promise<{ id: number } | null> => ({ id: 3 })),
  nameTaken: vi.fn(async () => false),
  createLens: vi.fn(async () => lens),
  updateLens: vi.fn(async (): Promise<typeof lens | null> => ({ ...lens, version: 2 })),
  deleteLens: vi.fn(async () => true),
  requestLensRun: vi.fn(async () => {}),
  lens: vi.fn(async (): Promise<typeof lens | null> => lens),
  requestPreview: vi.fn(async (): Promise<{ id: number } | 'no-sales' | 'not-analysed'> => ({ id: 41 })),
  preview: vi.fn(async (): Promise<object | null> => ({ id: 41, status: 'queued' })),
  sources: vi.fn(async (): Promise<Record<string, object>> => ({})),
  settings: vi.fn(async () => new Map<string, string>()),
  followFurther: vi.fn(async (): Promise<'set' | 'already' | 'gone'> => 'set'),
  startTokens: vi.fn(async (): Promise<'set' | 'already' | 'gone'> => 'set'),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
// handle() opts into dynamic rendering with connection(), which only works inside a Next request.
vi.mock('next/server', () => ({ connection: async () => {} }));

const { POST: create } = await import('@/app/api/lenses/route');
const { PATCH: edit, DELETE: remove } = await import('@/app/api/lenses/[id]/route');
const { POST: runHere } = await import('@/app/api/lenses/[id]/runs/route');
const { POST: previewIt } = await import('@/app/api/lenses/previews/route');
const { GET: previewOf } = await import('@/app/api/lenses/previews/[id]/route');
const { POST: follow } = await import('@/app/api/collections/[chain]/[address]/follow/route');
const { POST: startReading } = await import('@/app/api/collections/[chain]/[address]/tokens/route');
const { LOCAL_ONLY } = await import('@/lib/auth');

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request('http://x/api', { method, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { host: 'localhost:8080', 'content-type': 'application/json', ...headers } });
const NEW = { name: 'Blur 3-hop', rule: DEFAULT_RULE, chainId: 1, address: ADDR };
/** What the store throws when the collection a run is queued on was removed after the route found it. */
const GONE = Object.assign(new Error('violates foreign key constraint'), { code: '23503', constraint: 'lens_runs_collection_id_fkey' });

beforeEach(() => {
  vi.stubEnv('WASHTRACE_USERNAME', '');
  vi.stubEnv('WASHTRACE_PASSWORD', '');
  vi.clearAllMocks();
  fake.collection.mockResolvedValue({ id: 3 });
  fake.nameTaken.mockResolvedValue(false);
  fake.lens.mockResolvedValue(lens);
  fake.updateLens.mockResolvedValue({ ...lens, version: 2 });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/lenses', () => {
  it('creates the lens with its run on the collection, in one store call', async () => {
    const res = await create(req('POST', NEW));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ lens });
    expect(fake.createLens).toHaveBeenCalledWith('Blur 3-hop', DEFAULT_RULE, 3);
    expect(fake.requestLensRun).not.toHaveBeenCalled();
  });

  it('trims the name and stores the checked rule, not the raw one', async () => {
    const raw: any = structuredClone(DEFAULT_RULE);
    raw.never.addresses = ['0x' + 'AB'.repeat(20)];
    raw.extra = 1;
    await create(req('POST', { ...NEW, name: '  Padded  ', rule: raw }));
    const [name, rule] = fake.createLens.mock.calls[0] as unknown as [string, any];
    expect(name).toBe('Padded');
    expect(rule.never.addresses).toEqual(['0x' + 'ab'.repeat(20)]);
    expect('extra' in rule).toBe(false);
  });

  it('answers each checkRule error as a 400 with the same words', async () => {
    const cases: any[] = [];
    const bad = (edit: (r: any) => void) => { const r: any = structuredClone(DEFAULT_RULE); edit(r); cases.push(r); };
    bad((r) => { r.edges.xyz = r.edges.eth; });
    bad((r) => { r.hops = { min: 3, max: 1 }; });
    bad((r) => { r.hops = { min: 1, max: null }; });
    bad((r) => { r.edges['nft-token'].use = false; r.minCycles = 3; });
    bad((r) => { r.edges['nft-watched'].use = true; });
    bad((r) => { r.order = 'loop'; r.window = { days: 30, side: 'before' }; });
    bad((r) => { r.window = { days: 99999, side: 'either' }; });
    bad((r) => { r.never.addresses = ['0x12']; });
    for (const rule of cases) {
      const expected = checkRule(rule);
      if (!('error' in expected)) throw new Error('the case should be refused');
      const res = await create(req('POST', { ...NEW, rule }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expected.error });
    }
    expect(fake.createLens).not.toHaveBeenCalled();
    expect(fake.requestLensRun).not.toHaveBeenCalled();
  });

  it('refuses an empty or too long name', async () => {
    for (const [name, error] of [['  ', 'Give the lens a name.'], [42, 'Give the lens a name.'], ['x'.repeat(61), 'A name is at most 60 characters.']] as const) {
      const res = await create(req('POST', { ...NEW, name }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect((await create(req('POST', { ...NEW, name: 'x'.repeat(60) }))).status).toBe(201);
  });

  it('refuses a name with a control character (NUL, newline, tab, DEL) before any store call, on create and edit', async () => {
    const error = 'A name cannot hold control characters.';
    for (const name of ['a\u0000b', 'a\nb', 'a\tb', 'a\u007fb', 'a\u001fb']) {
      const made = await create(req('POST', { ...NEW, name }));
      expect(made.status).toBe(400);
      expect(await made.json()).toEqual({ error });
      const edited = await edit(req('PATCH', { name, rule: DEFAULT_RULE }), idCtx('7'));
      expect(edited.status).toBe(400);
      expect(await edited.json()).toEqual({ error });
    }
    for (const spy of [fake.nameTaken, fake.createLens, fake.updateLens, fake.lens, fake.collection]) expect(spy).not.toHaveBeenCalled();
  });

  it('lets a lens be renamed to its own name in another case', async () => {
    const res = await edit(req('PATCH', { name: 'BLUR 3-HOP', rule: DEFAULT_RULE }), idCtx('7'));
    expect(res.status).toBe(200);
    expect(fake.nameTaken).toHaveBeenCalledWith('BLUR 3-HOP', 7);
    expect(fake.updateLens).toHaveBeenCalledWith(7, 'BLUR 3-HOP', DEFAULT_RULE, undefined);
  });

  it('409s a name that is taken, a built-in\'s included', async () => {
    fake.nameTaken.mockResolvedValueOnce(true);
    const res = await create(req('POST', NEW));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Another lens is already called "Blur 3-hop".' });
    expect(fake.createLens).not.toHaveBeenCalled();
  });

  it('409s when the name is taken between the check and the insert', async () => {
    fake.createLens.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const res = await create(req('POST', NEW));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Another lens is already called "Blur 3-hop".' });
  });

  it('404s a collection that is not watched, and creates nothing', async () => {
    fake.collection.mockResolvedValueOnce(null);
    const res = await create(req('POST', NEW));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'This collection is not watched.' });
    expect(fake.createLens).not.toHaveBeenCalled();
  });

  it('404s, not 500s, a collection removed between the check and the insert', async () => {
    fake.createLens.mockRejectedValueOnce(GONE);
    const res = await create(req('POST', NEW));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'This collection is not watched.' });
  });

  it('404s a body with no chain and address', async () => {
    expect((await create(req('POST', { ...NEW, address: 'nope' }))).status).toBe(404);
    expect((await create(req('POST', { ...NEW, chainId: '1' }))).status).toBe(404);
  });

  it('415s a body that is not JSON', async () => {
    const res = await create(new Request('http://x/api', { method: 'POST', body: '{}', headers: { host: 'localhost:8080' } }));
    expect(res.status).toBe(415);
  });
});

describe('PATCH /api/lenses/[id]', () => {
  it('changes the lens and answers it', async () => {
    const res = await edit(req('PATCH', { name: 'Renamed', rule: DEFAULT_RULE }), idCtx('7'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lens: { ...lens, version: 2 } });
    expect(fake.updateLens).toHaveBeenCalledWith(7, 'Renamed', DEFAULT_RULE, undefined);
    expect(fake.nameTaken).toHaveBeenCalledWith('Renamed', 7);
  });

  it('queues its run on the collection it was edited from, in the same store call, as Save and run says', async () => {
    const res = await edit(req('PATCH', NEW), idCtx('7'));
    expect(res.status).toBe(200);
    expect(fake.collection).toHaveBeenCalledWith(1, ADDR);
    expect(fake.updateLens).toHaveBeenCalledWith(7, 'Blur 3-hop', DEFAULT_RULE, 3);
    expect(fake.requestLensRun).not.toHaveBeenCalled();
  });

  it('404s a collection that is not watched, and edits nothing', async () => {
    fake.collection.mockResolvedValueOnce(null);
    const res = await edit(req('PATCH', NEW), idCtx('7'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'This collection is not watched.' });
    expect((await edit(req('PATCH', { ...NEW, chainId: 'x' }), idCtx('7'))).status).toBe(404);
    expect(fake.updateLens).not.toHaveBeenCalled();
  });

  it('404s, not 500s, a collection removed between the check and the update', async () => {
    fake.updateLens.mockRejectedValueOnce(GONE);
    const res = await edit(req('PATCH', NEW), idCtx('7'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'This collection is not watched.' });
  });

  it('succeeds while the lens is running here: updateLens requeues it and the worker\'s save finds its version behind', async () => {
    const res = await edit(req('PATCH', { name: 'Blur 3-hop', rule: { ...DEFAULT_RULE, minCycles: 1 } }), idCtx('7'));
    expect(res.status).toBe(200);
    expect(fake.requestLensRun).not.toHaveBeenCalled();
  });

  it('answers the same 400s and 409 as a create', async () => {
    const r: any = structuredClone(DEFAULT_RULE);
    r.hops = { min: 4, max: 2 };
    const refused = await edit(req('PATCH', { name: 'x', rule: r }), idCtx('7'));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'Hops: "from" is more than "to".' });
    expect((await edit(req('PATCH', { name: '', rule: DEFAULT_RULE }), idCtx('7'))).status).toBe(400);
    fake.nameTaken.mockResolvedValueOnce(true);
    const taken = await edit(req('PATCH', { name: 'Money loops back', rule: DEFAULT_RULE }), idCtx('7'));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: 'Another lens is already called "Money loops back".' });
  });

  it('404s an unknown lens', async () => {
    fake.lens.mockResolvedValueOnce(null);
    const res = await edit(req('PATCH', { name: 'x', rule: DEFAULT_RULE }), idCtx('99'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such lens.' });
    expect(fake.updateLens).not.toHaveBeenCalled();
  });

  it('404s when it is deleted between the check and the update', async () => {
    fake.updateLens.mockResolvedValueOnce(null);
    expect((await edit(req('PATCH', { name: 'x', rule: DEFAULT_RULE }), idCtx('7'))).status).toBe(404);
  });

  it('still edits a lens whose stored rule can no longer be read, so it can be repaired', async () => {
    fake.lens.mockRejectedValueOnce(new Error("lens 7's rule can't be read"));
    expect((await edit(req('PATCH', { name: 'Fixed', rule: DEFAULT_RULE }), idCtx('7'))).status).toBe(200);
  });
});

describe('DELETE /api/lenses/[id]', () => {
  it('DELETE returns 200 {deleted:true} and removes lens 7', async () => {
    const res = await remove(req('DELETE'), idCtx('7'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(fake.deleteLens).toHaveBeenCalledWith(7);
  });

  it('404s an unknown lens', async () => {
    fake.deleteLens.mockResolvedValueOnce(false);
    const res = await remove(req('DELETE'), idCtx('7'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such lens.' });
  });
});

describe('POST /api/lenses/[id]/runs', () => {
  it('queues the run on the collection', async () => {
    const res = await runHere(req('POST', { chainId: 1, address: ADDR }), idCtx('7'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect(fake.requestLensRun).toHaveBeenCalledWith(7, 3);
  });

  it('404s an unknown lens and an unwatched collection', async () => {
    fake.lens.mockResolvedValueOnce(null);
    const gone = await runHere(req('POST', { chainId: 1, address: ADDR }), idCtx('7'));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'No such lens.' });
    fake.collection.mockResolvedValueOnce(null);
    const unwatched = await runHere(req('POST', { chainId: 1, address: ADDR }), idCtx('7'));
    expect(unwatched.status).toBe(404);
    expect(await unwatched.json()).toEqual({ error: 'This collection is not watched.' });
    expect(fake.requestLensRun).not.toHaveBeenCalled();
  });

  it('404s, not 500s, a collection removed between the check and the queueing', async () => {
    fake.requestLensRun.mockRejectedValueOnce(GONE);
    const res = await runHere(req('POST', { chainId: 1, address: ADDR }), idCtx('7'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'This collection is not watched.' });
  });

  it('404s, not 500s, a lens deleted between the check and the queueing, and only on that foreign key', async () => {
    const lensGone = Object.assign(new Error('violates foreign key constraint'), { code: '23503', constraint: 'lens_runs_lens_id_fkey' });
    fake.requestLensRun.mockRejectedValueOnce(lensGone);
    const res = await runHere(req('POST', { chainId: 1, address: ADDR }), idCtx('7'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such lens.' });
    // Another key, or another code on that constraint, is not this race.
    for (const other of [{ code: '23503', constraint: 'lens_runs_other_fkey' }, { code: '23505', constraint: 'lens_runs_lens_id_fkey' }]) {
      fake.requestLensRun.mockRejectedValueOnce(Object.assign(new Error('x'), other));
      expect((await runHere(req('POST', { chainId: 1, address: ADDR }), idCtx('7'))).status).toBe(500);
    }
  });
});

describe('an id that is not one of your lenses', () => {
  // Built-ins have keys (A, AU, AC), not ids; ids are int4, so anything else never reaches the database.
  it.each(['A', 'AU', 'L7', '-1', '1.5', '', '2147483648', '99999999999999999999', '0x10'])('404s %j on every route', async (id) => {
    for (const res of [
      await edit(req('PATCH', { name: 'x', rule: DEFAULT_RULE }), idCtx(id)),
      await remove(req('DELETE'), idCtx(id)),
      await runHere(req('POST', { chainId: 1, address: ADDR }), idCtx(id)),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'No such lens.' });
    }
    for (const spy of [fake.updateLens, fake.deleteLens, fake.requestLensRun, fake.lens]) expect(spy).not.toHaveBeenCalled();
  });

  it('takes the largest int4', async () => {
    expect((await remove(req('DELETE'), idCtx('2147483647'))).status).toBe(200);
    expect(fake.deleteLens).toHaveBeenCalledWith(2147483647);
  });
});

describe('who may write', () => {
  const writes = (headers: Record<string, string>) => [
    () => create(req('POST', NEW, headers)),
    () => edit(req('PATCH', { name: 'x', rule: DEFAULT_RULE }, headers), idCtx('7')),
    () => remove(req('DELETE', {}, headers), idCtx('7')),
    () => runHere(req('POST', { chainId: 1, address: ADDR }, headers), idCtx('7')),
  ];
  const spies = [fake.createLens, fake.updateLens, fake.deleteLens, fake.requestLensRun];

  it('every write from another host is refused while basic auth is off', async () => {
    for (const write of writes({ host: 'evil.example' })) {
      const res = await write();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: LOCAL_ONLY });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('a proxied request to this machine is refused', async () => {
    for (const write of writes({ 'x-real-ip': '1.2.3.4' })) expect((await write()).status).toBe(403);
  });

  it('this machine through the published port may write', async () => {
    for (const write of writes({ host: '127.0.0.1:8080' })) expect((await write()).status).not.toBe(403);
  });

  it('with basic auth on, a write from any host is accepted', async () => {
    vi.stubEnv('WASHTRACE_USERNAME', 'u');
    vi.stubEnv('WASHTRACE_PASSWORD', 'p');
    for (const write of writes({ host: 'evil.example' })) expect((await write()).status).not.toBe(403);
  });

  it('a body that is not JSON is 415 on every route', async () => {
    const plain = { host: 'localhost:8080' };
    const send = (method: string) => new Request('http://x/api', { method, body: '{}', headers: plain });
    for (const res of [await create(send('POST')), await edit(send('PATCH'), idCtx('7')), await remove(send('DELETE'), idCtx('7')), await runHere(send('POST'), idCtx('7'))]) {
      expect(res.status).toBe(415);
    }
  });
});

describe('the log', () => {
  it('names the actor and the lens, as the pause route does', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await create(req('POST', NEW, { 'x-washtrace-user': 'ann' }));
    await edit(req('PATCH', { name: 'x', rule: DEFAULT_RULE }), idCtx('7'));
    await remove(req('DELETE'), idCtx('7'));
    await runHere(req('POST', { chainId: 1, address: ADDR }), idCtx('7'));
    expect(info.mock.calls.map((c) => c.slice(0, 1).concat(c.slice(2)))).toEqual([
      ['[washtrace] %s created lens %d', 7],
      ['[washtrace] %s edited lens %d', 7],
      ['[washtrace] %s deleted lens %d', 7],
      ['[washtrace] %s ran lens %d here', 7],
    ]);
    info.mockRestore();
  });
});

describe('POST /api/lenses/previews', () => {
  const ASK = { rule: DEFAULT_RULE, chainId: 1, address: ADDR };
  beforeEach(() => {
    fake.requestPreview.mockResolvedValue({ id: 41 });
  });

  it('queues the checked rule on the collection and answers 202 with the id', async () => {
    const raw: any = structuredClone(DEFAULT_RULE);
    raw.extra = 1;
    const res = await previewIt(req('POST', { ...ASK, rule: raw }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 41 });
    expect(fake.requestPreview).toHaveBeenCalledWith(3, DEFAULT_RULE);
  });

  it('is refused 403 with the local-only wording from another host while basic auth is off', async () => {
    const res = await previewIt(req('POST', ASK, { host: 'evil.example' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(LOCAL_ONLY);
    expect(fake.requestPreview).not.toHaveBeenCalled();
  });

  it('answers a rule checkRule refuses as a 400 with the same words, and queues nothing', async () => {
    const rule: any = structuredClone(DEFAULT_RULE);
    rule.hops = { min: 3, max: 1 };
    const expected = checkRule(rule);
    if (!('error' in expected)) throw new Error('the case should be refused');
    const res = await previewIt(req('POST', { ...ASK, rule }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(expected.error);
    expect(fake.requestPreview).not.toHaveBeenCalled();
  });

  it('is 404 for a collection that is not watched', async () => {
    fake.collection.mockResolvedValue(null);
    expect((await previewIt(req('POST', ASK))).status).toBe(404);
    expect(fake.requestPreview).not.toHaveBeenCalled();
  });

  it('is 409 saying why when there is nothing to preview on', async () => {
    fake.requestPreview.mockResolvedValue('no-sales');
    let res = await previewIt(req('POST', ASK));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This collection has no sales to preview on.' });
    fake.requestPreview.mockResolvedValue('not-analysed');
    res = await previewIt(req('POST', ASK));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This collection has not been analysed yet, so there is nothing to preview on.' });
  });
});

describe('GET /api/lenses/previews/[id]', () => {
  it('answers the preview row', async () => {
    const res = await previewOf(new Request('http://x/api'), idCtx('41'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 41, status: 'queued' });
    expect(fake.preview).toHaveBeenCalledWith(41);
  });

  it('is 404 saying it is gone for a swept preview, and for an id that is none', async () => {
    fake.preview.mockResolvedValueOnce(null);
    const gone = await previewOf(new Request('http://x/api'), idCtx('41'));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'This preview is gone. Run it again.' });
    const none = await previewOf(new Request('http://x/api'), idCtx('abc'));
    expect(none.status).toBe(404);
    expect(fake.preview).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/collections/[chain]/[address]/follow', () => {
  const ctx = { params: Promise.resolve({ chain: '1', address: ADDR }) };

  it('is refused where writes are, before anything is read', async () => {
    const res = await follow(req('POST', { hops: 5 }, { host: 'evil.example' }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(LOCAL_ONLY);
    expect(fake.followFurther).not.toHaveBeenCalled();
  });

  it.each([0, 11, 2.5, '5', null])('refuses hops %j', async (hops) => {
    const res = await follow(req('POST', { hops }), ctx);
    expect(res.status).toBe(400);
    expect(fake.followFurther).not.toHaveBeenCalled();
  });

  it('refuses hops at or below the global limit, which frees no quota', async () => {
    const res = await follow(req('POST', { hops: 3 }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('3 hops');
    fake.sources.mockResolvedValueOnce({ 'follow.hops': { value: '6' } });
    expect((await follow(req('POST', { hops: 6 }), ctx)).status).toBe(400);
    expect(fake.followFurther).not.toHaveBeenCalled();
  });

  it('answers 202 { set: true } when the limit is set, 200 { set: false } when it already was', async () => {
    const first = await follow(req('POST', { hops: 5 }), ctx);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ set: true });
    expect(fake.followFurther).toHaveBeenCalledWith(3, 5);
    fake.followFurther.mockResolvedValueOnce('already');
    const again = await follow(req('POST', { hops: 5 }), ctx);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ set: false });
  });

  it('answers 404 for a collection that is not watched, or that went between the two reads', async () => {
    fake.collection.mockResolvedValueOnce(null);
    expect((await follow(req('POST', { hops: 5 }), ctx)).status).toBe(404);
    fake.followFurther.mockResolvedValueOnce('gone');
    expect((await follow(req('POST', { hops: 5 }), ctx)).status).toBe(404);
    expect((await follow(req('POST', { hops: 5 }), { params: Promise.resolve({ chain: 'x', address: 'y' }) })).status).toBe(404);
  });
});

describe('POST /api/collections/[chain]/[address]/tokens', () => {
  const ctx = { params: Promise.resolve({ chain: '1', address: ADDR }) };

  it('is refused where writes are, before anything is read', async () => {
    const res = await startReading(req('POST', {}, { host: 'evil.example' }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(LOCAL_ONLY);
    expect(fake.collection).not.toHaveBeenCalled();
    expect(fake.startTokens).not.toHaveBeenCalled();
  });

  it('answers 202 { started: true } on the first press and 200 { started: false } on the next', async () => {
    const first = await startReading(req('POST', {}), ctx);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ started: true });
    expect(fake.startTokens).toHaveBeenCalledWith(3);
    fake.startTokens.mockResolvedValueOnce('already');
    const again = await startReading(req('POST', {}), ctx);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ started: false });
  });

  it('answers 404 for a collection that is not watched, that went between the two reads, or no collection at all', async () => {
    fake.collection.mockResolvedValueOnce(null);
    expect((await startReading(req('POST', {}), ctx)).status).toBe(404);
    fake.startTokens.mockResolvedValueOnce('gone');
    expect((await startReading(req('POST', {}), ctx)).status).toBe(404);
    expect((await startReading(req('POST', {}), { params: Promise.resolve({ chain: 'x', address: 'y' }) })).status).toBe(404);
    expect(fake.startTokens).toHaveBeenCalledTimes(1);
  });
});
