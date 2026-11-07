import { bad, handle, json, writeBody } from '@/lib/api';
import { FIELDS } from '@/lib/settings';
import { store } from '@/lib/store';

/**
 * POST `{kind: 'rpc', chainId}` or `{kind: 'etherscan'}`: ask the worker to
 * Test a source, answering `{ id }` to poll at /api/settings/check/[id]. The
 * worker runs it, not the API, which never calls a chain. Gated like a
 * settings write: a Test spends the owner's RPC and Etherscan quota.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const { body } = written;
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
