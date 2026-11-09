import { MAX_STREAMS, METHODS, moneyFor, type TradeRow } from '@washtrace/detect';
import { venueOf, VENUES, type LensKey, type TradeContext } from '@washtrace/detect/trades';
import { bad, collectionFrom, handle, json, readerZone } from '@/lib/api';
import { LENSES, NOT_RUN, weiToEth, type Lenses } from '@/lib/format';
import { judgedBy, lensContext, ownLenses } from '@/lib/metrics';
import { pages as pagesOf } from '@/lib/params';
import { TRADES_PAGE, holdsNothing, paramsOf, parseView } from '@/lib/trades-url';

/** The columns: the three built-ins, then each of your lenses by name, then the transaction. Per request, as the lenses are. */
const headerOf = (own: Lenses) => ['date', 'token', 'seller', 'buyer', 'price', 'currency', 'marketplace', 'held_seconds', 'buyer_age_seconds', 'price_vs_floor',
  ...METHODS.map((m) => LENSES[m].name + (LENSES[m].tone === 'apart' ? ' (not counted)' : '')), ...Object.values(own).map((l) => l.name), 'tx'];

/**
 * RFC 4180 quoting, plus a leading `'` on a field a spreadsheet would read as
 * a formula (OWASP's list: `= + - @`, tab, carriage return). An unknown raw
 * marketplace string is shown as itself, so it is the one field a stranger can
 * write. Numbers are never guarded, so a numeric column never gets a `'`.
 */
function cell(v: string | number | null): string {
  let s = v === null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One trade's line. A lens of yours past the block its run read (`through`) has not judged it: "not judged yet", never "" (not caught). */
function csvLine(r: TradeRow, ctx: Pick<TradeContext, 'ran' | 'through'>, cols: readonly LensKey[], money: ReadonlySet<string>): string {
  const priced = r.priceWei !== null && r.currency !== null && money.has(r.currency);
  const lens = (m: LensKey) => !ctx.ran.includes(m) ? NOT_RUN : !judgedBy(r, m, ctx.through) ? 'not judged yet' : r.lenses.includes(m) ? 'caught' : '';
  return [
    r.blockTime === null ? '' : new Date(r.blockTime * 1000).toISOString(), r.tokenId, r.from, r.to,
    priced ? weiToEth(r.priceWei!) : '', priced ? 'ETH' : '',
    r.marketplace === null ? '' : VENUES[venueOf(r.marketplace)]?.name ?? r.marketplace,
    r.heldS, r.buyerAgeS, r.floorRatio,
    ...cols.map(lens), r.txHash,
  ].map(cell).join(',') + '\n';
}

/** The rows of an iterator as a CSV body, one per pull, so a slow reader holds one row and a cancelled download closes the cursor. */
function csvBody(it: AsyncGenerator<TradeRow>, ctx: TradeContext, own: Lenses): ReadableStream<Uint8Array> {
  const cols = [...METHODS, ...Object.keys(own) as LensKey[]];
  const header = headerOf(own).map(cell).join(',') + '\n';
  const enc = new TextEncoder();
  let head = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await it.next();
        const lead = head ? header : '';
        head = false;
        if (next.done) {
          if (lead) controller.enqueue(enc.encode(lead));
          controller.close();
        } else {
          controller.enqueue(enc.encode(lead + csvLine(next.value, ctx, cols, ctx.money)));
        }
      } catch (err) {
        // controller.error does not call cancel, so a failed row would leave the cursor's connection held.
        await it.return(undefined).catch(() => {});
        controller.error(err);
      }
    },
    cancel: async () => { await it.return(undefined); },
  }, { highWaterMark: 0 });
}

async function* nothing(): AsyncGenerator<TradeRow> {}

/**
 * GET: the collection's trades under the same filters as the Trades page.
 * JSON is one page (50) with its count, and `through`: for each lens of yours
 * in `ran`, the block its run read, past which a row is not judged by it;
 * `format=csv` streams every trade the filters hold. A filter on
 * a lens that did not run, or a Find nothing can read, holds no trades.
 */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string; address: string }> }): Promise<Response> {
  return handle(async () => {
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    const { s, chainId, address, collection: c } = found;
    const url = new URL(req.url);
    const zone = await readerZone();
    const runs = await s.lensRuns(c.id);
    const own = ownLenses(runs);
    // A key of a lens that was deleted is junk, dropped here; one that has not run stays, and holds nothing.
    const { q, view } = parseView(paramsOf(url.searchParams), zone, new Set(Object.keys(own)));
    // Your lenses are read only through the block their run read, here as on the page.
    const ctx = { money: moneyFor(chainId), zone, ...lensContext(c.latest, runs) };
    const { ran } = ctx;
    const empty = holdsNothing(q, ran) !== null;

    if (url.searchParams.get('format') === 'csv') {
      // Each download holds a pool connection until it ends; past MAX_STREAMS the rest of the API would wait for one.
      if (s.streaming >= MAX_STREAMS) return bad('Too many downloads at once; try again in a minute.', 429);
      return new Response(csvBody(empty ? nothing() : s.tradeStream(c.id, q, ctx), ctx, own), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${address}-trades.csv"`, 'cache-control': 'no-store' },
      });
    }

    const { total, unjudged } = empty ? { total: 0, unjudged: 0 } : await s.tradeCount(c.id, q, ctx);
    const pages = pagesOf(total, TRADES_PAGE);
    const page = Math.min(pages, view.page);
    const rows = total === 0 ? [] : await s.trades(c.id, q, ctx, TRADES_PAGE, (page - 1) * TRADES_PAGE);
    return json({ total, unjudged, page, pages, ran, through: ctx.through, rows });
  });
}
