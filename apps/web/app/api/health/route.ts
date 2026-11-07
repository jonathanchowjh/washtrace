import { connection } from 'next/server';
import { json } from '@/lib/api';
import { store } from '@/lib/store';

/** Unauthenticated (see proxy.ts) for the container's health check. Says only whether the store answers. */
export async function GET(): Promise<Response> {
  await connection();
  try {
    await store().pool.query('SELECT 1');
    return json({ ok: true });
  } catch {
    return json({ ok: false }, 503);
  }
}
