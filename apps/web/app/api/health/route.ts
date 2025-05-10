import { connection } from 'next/server';
import { store } from '@/lib/store';

/** Unauthenticated (see proxy.ts) for the container's health check. Says only whether the store answers. */
export async function GET(): Promise<Response> {
  await connection();
  try {
    await store().pool.query('SELECT 1');
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
