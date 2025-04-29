import { NextResponse, type NextRequest } from 'next/server';
import { ACTOR_HEADER, authorize } from '@/lib/auth';

/**
 * Basic auth over every page and API route. Next's "proxy" convention,
 * formerly middleware; always on the Node.js runtime.
 */
export function proxy(req: NextRequest) {
  // Stripped first, whatever happens next: a client that could set this
  // would choose the name logged against a change it made.
  const headers = new Headers(req.headers);
  headers.delete(ACTOR_HEADER);

  const result = authorize(process.env, req.headers.get('authorization'));
  if (!result.ok) {
    return new NextResponse(result.message, {
      status: result.status,
      headers: result.status === 401 ? { 'WWW-Authenticate': 'Basic realm="washtrace", charset="UTF-8"' } : {},
    });
  }
  if (result.user !== null) headers.set(ACTOR_HEADER, encodeURIComponent(result.user));
  return NextResponse.next({ request: { headers } });
}

/**
 * Every route but static assets and the health check, which a container
 * orchestrator calls without credentials and which says only "up" or "down".
 * An exclusion added here is an unauthenticated route.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health$).*)'],
};
