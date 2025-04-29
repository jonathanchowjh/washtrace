import { handle, json } from '@/lib/api';
import { workerView } from '@/lib/views';

/** GET: each job's last pass, the funding backlog per chain, and which sources are configured (never their values). */
export async function GET(): Promise<Response> {
  return handle(async () => json(await workerView()));
}
