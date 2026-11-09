import { handle, json, readerZone } from '@/lib/api';
import { workerView } from '@/lib/views';

/** GET: each job's last pass, the funding backlog per chain, and which sources are configured (never their values). */
export async function GET(): Promise<Response> {
  // The reader's zone when a browser asks, for the dates in the notices; UTC otherwise.
  return handle(async () => json(await workerView(await readerZone())));
}
