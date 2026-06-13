import { authConfigured } from '@/lib/auth';
import { bad, handle, json, readJson } from '@/lib/api';
import { FIELDS, READ_ONLY } from '@/lib/settings';
import { store } from '@/lib/store';

/**
 * POST `{kind: 'rpc', chainId}` or `{kind: 'etherscan'}`: ask the worker to
 * Test a source, answering `{ id }` to poll at /api/settings/check/[id]. The
 * worker runs it, not the API, which never calls a chain. Gated like a
 * settings write: a Test spends the owner's RPC and Etherscan quota.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    if (!authConfigured(process.env)) return bad(READ_ONLY, 403);
    const body = await readJson(req);
    if (body instanceof Response) return body;
    if (body.kind === 'etherscan') return json({ id: await store().requestCheck('etherscan', null) }, 201);
    if (body.kind !== 'rpc') return bad("kind must be 'rpc' or 'etherscan'.");
    const chainId = body.chainId;
    const chains = FIELDS.flatMap((f) => (f.key.startsWith('rpc.') ? [f.key.slice(4)] : []));
    if (typeof chainId !== 'number' || !Number.isInteger(chainId) || !chains.includes(String(chainId))) {
      return bad(`chainId must be a chain with an RPC setting: ${chains.join(', ')}.`);
    }
    return json({ id: await store().requestCheck('rpc', chainId) }, 201);
  });
}
