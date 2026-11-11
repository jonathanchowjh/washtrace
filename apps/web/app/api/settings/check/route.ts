import { bad, handle, json, writeBody } from '@/lib/api';
import { chainIdOf } from '@/lib/params';
import { store } from '@/lib/store';

/**
 * POST `{kind: 'rpc', chainId}` or `{kind: 'etherscan'}`: ask the worker to
 * Test a source, answering `{ id }` to poll at /api/settings/check/[id]. The
 * worker runs it, not the API, which never calls a chain. Gated like a
 * settings write: a Test spends the owner's RPC and Etherscan quota. Any chain
 * id may be tested, not only one the console names: the worker reads any
 * WASHTRACE_RPC_<id>, Settings lists each it reports with a Test, and the
 * worker says so when it has no URL for the chain.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const { body } = written;
    if (body.kind === 'etherscan') return json({ id: await store().requestCheck('etherscan', null) }, 201);
    if (body.kind !== 'rpc') return bad("kind must be 'rpc' or 'etherscan'.");
    const chainId = chainIdOf(body.chainId);
    if (chainId === null) return bad('chainId must be a positive whole number.');
    return json({ id: await store().requestCheck('rpc', chainId) }, 201);
  });
}
