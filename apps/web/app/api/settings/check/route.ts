import { bad, handle, json, writeBody } from '@/lib/api';
import { CHAINS } from '@/lib/chains';
import { store } from '@/lib/store';

/**
 * POST `{kind: 'rpc', chainId}` or `{kind: 'etherscan'}`: ask the worker to
 * Test a source, answering `{ id }` to poll at /api/settings/check/[id]. The
 * worker runs it, not the API, which never calls a chain. Gated like a
 * settings write: a Test spends the owner's RPC and Etherscan quota. Any chain
 * the console knows may be tested, not only Ethereum's, the one RPC it saves:
 * the worker tests the URL it reads, and says so when it has none.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const { body } = written;
    if (body.kind === 'etherscan') return json({ id: await store().requestCheck('etherscan', null) }, 201);
    if (body.kind !== 'rpc') return bad("kind must be 'rpc' or 'etherscan'.");
    const chainId = body.chainId;
    const chains = Object.keys(CHAINS);
    if (typeof chainId !== 'number' || !Number.isInteger(chainId) || !chains.includes(String(chainId))) {
      return bad(`chainId must be a chain the console knows: ${chains.join(', ')}.`);
    }
    return json({ id: await store().requestCheck('rpc', chainId) }, 201);
  });
}
