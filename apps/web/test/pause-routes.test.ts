import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'ab'.repeat(20);
const fake = {
  row: null as { pausedAt: number | null } | null,
  collection: vi.fn(async () => fake.row),
  pause: vi.fn(async () => true),
  resume: vi.fn(async () => true),
  removeCollection: vi.fn(async () => true),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
// handle() opts into dynamic rendering with connection(), which only works inside a Next request.
vi.mock('next/server', () => ({ connection: async () => {} }));

const { POST: pause } = await import('@/app/api/collections/[chain]/[address]/pause/route');
const { POST: resume } = await import('@/app/api/collections/[chain]/[address]/resume/route');
const { DELETE: remove } = await import('@/app/api/collections/[chain]/[address]/route');

const ctx = { params: Promise.resolve({ chain: '1', address: ADDR }) };
const req = (method: string, body = '{}') => new Request('http://x/api', { method, body, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fake.row = { pausedAt: null };
  vi.clearAllMocks();
});

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
    const res = await pause(new Request('http://x/api', { method: 'POST', body: '{}' }), ctx);
    expect(res.status).toBeGreaterThanOrEqual(400);
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
