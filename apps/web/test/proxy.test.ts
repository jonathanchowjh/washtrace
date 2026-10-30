import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { mayWrite } from '@/lib/auth';

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

describe('mayWrite', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('lets this machine write without auth', () => {
    for (const host of ['localhost:8080', '127.0.0.1:3000', '[::1]:8080', 'localhost'])
      expect(mayWrite({}, h({ host, 'x-forwarded-for': '172.17.0.1', 'x-forwarded-host': host }))).toBe(true);
  });
  it('refuses another host, or a request a proxy marked, without auth', () => {
    expect(mayWrite({}, h({ host: 'washtrace.example.com' }))).toBe(false);
    expect(mayWrite({}, h({ host: 'localhost.evil.com' }))).toBe(false);
    expect(mayWrite({}, h({ host: 'localhost:8080', 'x-real-ip': '203.0.113.9' }))).toBe(false);
    expect(mayWrite({}, h({ host: 'localhost:8080', forwarded: 'for=203.0.113.9' }))).toBe(false);
  });
  it('lets anyone through once basic auth is on: the proxy has checked them', () => {
    expect(mayWrite({ WASHTRACE_USERNAME: 'ada', WASHTRACE_PASSWORD: 'pw' }, h({ host: 'washtrace.example.com' }))).toBe(true);
  });
});
