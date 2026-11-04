import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'ab'.repeat(20);
const fake = {
  row: null as { pausedAt: number | null } | null,
  collection: vi.fn(async () => fake.row),
  pause: vi.fn(async () => true),
  resume: vi.fn(async () => true),
  removeCollection: vi.fn(async () => true),
  addCollection: vi.fn(async () => ({ id: 1, created: true })),
  configure: vi.fn(async () => fake.row),
  sources: vi.fn(async () => ({})),
  settings: vi.fn(async () => new Map<string, string>()),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
// handle() opts into dynamic rendering with connection(), which only works inside a Next request.
vi.mock('next/server', () => ({ connection: async () => {} }));

const { POST: pause } = await import('@/app/api/collections/[chain]/[address]/pause/route');
const { POST: resume } = await import('@/app/api/collections/[chain]/[address]/resume/route');
const { DELETE: remove } = await import('@/app/api/collections/[chain]/[address]/route');
const { POST: config } = await import('@/app/api/collections/[chain]/[address]/config/route');
const { POST: watch } = await import('@/app/api/collections/route');
const { LOCAL_ONLY } = await import('@/lib/auth');

const ctx = { params: Promise.resolve({ chain: '1', address: ADDR }) };
const req = (method: string, body = '{}', headers: Record<string, string> = {}) =>
  new Request('http://x/api', { method, body, headers: { host: 'localhost:8080', 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  // The developer's shell must not change whether basic auth is on.
  vi.stubEnv('WASHTRACE_USERNAME', '');
  vi.stubEnv('WASHTRACE_PASSWORD', '');
  fake.row = { pausedAt: null };
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe('pause and resume', () => {
  it('pause answers paused: true, and is idempotent', async () => {
    fake.row = { pausedAt: 5 };
    fake.pause.mockResolvedValueOnce(false);
    const res = await pause(req('POST'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: true });
  });

  it('resume answers paused: false', async () => {
    const res = await resume(req('POST'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: false });
    expect(fake.resume).toHaveBeenCalled();
  });

  it('404s when the collection is not watched', async () => {
    fake.row = null;
    expect((await pause(req('POST'), ctx)).status).toBe(404);
    expect((await resume(req('POST'), ctx)).status).toBe(404);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await pause(new Request('http://x/api', { method: 'POST', body: '{}', headers: { host: 'localhost:8080' } }), ctx);
    expect(res.status).toBe(415);
    expect(fake.pause).not.toHaveBeenCalled();
  });
});

describe('delete', () => {
  it('409s unless the collection is paused', async () => {
    const res = await remove(req('DELETE'), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Pause this collection before deleting its data.');
    expect(fake.removeCollection).not.toHaveBeenCalled();
  });

  it('409s when it was resumed between the read and the delete', async () => {
    fake.collection.mockResolvedValueOnce({ pausedAt: 5 }).mockResolvedValueOnce({ pausedAt: null });
    fake.removeCollection.mockResolvedValueOnce(false);
    expect((await remove(req('DELETE'), ctx)).status).toBe(409);
  });

  it('404s when it was gone between the read and the delete', async () => {
    fake.collection.mockResolvedValueOnce({ pausedAt: 5 }).mockResolvedValueOnce(null);
    fake.removeCollection.mockResolvedValueOnce(false);
    expect((await remove(req('DELETE'), ctx)).status).toBe(404);
  });

  it('deletes a paused collection', async () => {
    fake.row = { pausedAt: 5 };
    const res = await remove(req('DELETE'), ctx);
    expect(res.status).toBe(200);
    expect(fake.removeCollection).toHaveBeenCalled();
  });
});

describe('who may write', () => {
  const ADD = { chainId: 1, address: ADDR };
  const writes = (headers: Record<string, string>) => [
    () => watch(req('POST', JSON.stringify(ADD), headers)),
    () => pause(req('POST', '{}', headers), ctx),
    () => resume(req('POST', '{}', headers), ctx),
    () => config(req('POST', '{"name":"x"}', headers), ctx),
    () => remove(req('DELETE', '{}', headers), ctx),
  ];
  const spies = [fake.addCollection, fake.configure, fake.pause, fake.resume, fake.removeCollection];

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
});
