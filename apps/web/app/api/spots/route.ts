import { bad, handle, json, writeBody } from '@/lib/api';
import { chainIdOf, txOf } from '@/lib/params';
import { fromVerdict } from '@/lib/spot';
import { store } from '@/lib/store';
import { txVerdict } from '@/lib/views';
import { lensRefusal } from '@washtrace/detect';
import { isOwnKey } from '@washtrace/detect/trades';

/**
 * POST `{ chainId, tx, lens? }`: is this transaction a wash trade? With no
 * lens, a transaction a watched collection's latest analysis judged is
 * answered at once, 200 `{ status: 'done', result }`. Otherwise a spot check
 * is queued, 202 `{ id, status, reused }`, which the caller polls at
 * GET /api/spots/{id}. With a lens it is always queued: stored verdicts hold
 * only the built-ins.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const { body } = written;
    const chainId = chainIdOf(body.chainId);
    if (chainId === null) return bad('chainId must be a chain id, such as 1.');
    const tx = typeof body.tx === 'string' ? txOf(body.tx) : null;
    if (tx === null) return bad('tx must be a transaction hash: 0x and 64 hex digits.');
    const s = store();
    let lens: { key: string; version: number } | null = null;
    if (body.lens !== undefined && body.lens !== null) {
      if (typeof body.lens !== 'string' || !isOwnKey(body.lens)) return bad('lens must be the key of a lens of yours, such as L7.');
      const found = await s.lens(Number(body.lens.slice(1)));
      if (found === null) return bad('No such lens.', 404);
      const refusal = lensRefusal(found.rule);
      if (refusal !== null) return bad(refusal);
      lens = { key: found.key, version: found.version };
    } else {
      const view = await txVerdict(chainId, tx);
      if (view.transfers.length > 0 && view.judged) return json({ status: 'done', result: fromVerdict(view) });
    }
    const queued = await s.requestSpot(chainId, tx, lens);
    const row = await s.spot(queued.id);
    return json({ id: queued.id, status: row?.status ?? 'queued', reused: queued.reused }, 202);
  });
}
