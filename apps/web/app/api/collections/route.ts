import { addressOf, bad, chainIdOf, handle, json, writeBody } from '@/lib/api';
import { FIELDS } from '@/lib/settings';
import { store } from '@/lib/store';

/** GET: every watched collection, its ingest and funding progress, and its latest analysis. */
export async function GET(): Promise<Response> {
  return handle(async () => json({ collections: await store().collections() }));
}

/**
 * POST `{chainId, address, name?, fromBlock?}`: watch a collection. Without
 * `fromBlock` the worker finds the contract's deployment block and reads
 * from there. Watching again is not an error; it answers 200 with the same id.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const { body, actor } = written;
    const chainId = chainIdOf(body.chainId);
    const address = typeof body.address === 'string' ? addressOf(body.address.trim()) : null;
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 120) : null;
    const fromBlock = body.fromBlock === undefined || body.fromBlock === null ? null
      : typeof body.fromBlock === 'number' && Number.isInteger(body.fromBlock) && body.fromBlock >= 0 ? body.fromBlock : undefined;
    if (chainId === null) return bad('chainId must be a positive integer, such as 1 for Ethereum.');
    if (address === null) return bad('address must be a contract address: 0x and 40 hex digits.');
    if (fromBlock === undefined) return bad('fromBlock must be a block number, or left out to start at deployment.');
    const s = store();
    const { id, created } = await s.addCollection(chainId, address, name, fromBlock);
    if (created) console.info('[washtrace] %s is watching %d/%s', actor, chainId, address);
    // The worker's report, not this process's environment: only the worker reads the chain.
    // A console value counts too, so a URL saved a moment ago doesn't warn before the worker's next report.
    const hasRpc = (await s.sources())[`rpc.${chainId}`] !== undefined || Boolean((await s.settings()).get(`rpc.${chainId}`)?.trim());
    const where = FIELDS.some((f) => f.key === `rpc.${chainId}`) ? 'Set one in Settings' : `Set WASHTRACE_RPC_${chainId} for the worker`;
    const warning = hasRpc ? undefined : `No RPC is configured for chain ${chainId}, so only its stored data, if it has any, is read. ${where}.`;
    return json({ id, chainId, address, created, warning }, created ? 201 : 200);
  });
}
