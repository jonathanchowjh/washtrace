import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

// NextResponse.next({ request: { headers } }) hands the rewritten request headers
// to Next as x-middleware-request-<name>, listed in x-middleware-override-headers.
const forwarded = (res: Response, name: string) =>
  (res.headers.get('x-middleware-override-headers') ?? '').split(',').includes(name) ? res.headers.get(`x-middleware-request-${name}`) : null;
const req = (headers: Record<string, string>) => new NextRequest('http://x/api/settings', { headers });

afterEach(() => vi.unstubAllEnvs());

describe('proxy and the actor header', () => {
  it('strips a client-sent user while auth is off', () => {
    vi.stubEnv('WASHTRACE_USERNAME', '');
    vi.stubEnv('WASHTRACE_PASSWORD', '');
    const res = proxy(req({ 'x-washtrace-user': 'mallory' }));
    expect(res.status).toBe(200);
    expect(forwarded(res, 'x-washtrace-user')).toBeNull();
  });

  it('replaces a client-sent user with the authorised one while auth is on', () => {
    vi.stubEnv('WASHTRACE_USERNAME', 'ada');
    vi.stubEnv('WASHTRACE_PASSWORD', 'pw');
    const res = proxy(req({ 'x-washtrace-user': 'mallory', authorization: `Basic ${btoa('ada:pw')}` }));
    expect(res.status).toBe(200);
    expect(forwarded(res, 'x-washtrace-user')).toBe('ada');
  });
});
