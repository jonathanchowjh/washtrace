import { cookies } from 'next/headers';
import { METHODS, moneyFor, type Method, type TradeRow } from '@washtrace/detect';
import { venueOf, VENUES } from '@washtrace/detect/trades';
import { addressOf, bad, chainOf, handle, json } from '@/lib/api';
import { LENSES } from '@/lib/format';
import { lensesRan } from '@/lib/metrics';
import { pages as pagesOf } from '@/lib/params';
import { store } from '@/lib/store';
import { TRADES_PAGE, holdsNothing, paramsOf, parseView, weiToEth } from '@/lib/trades-url';
import { ZONE_COOKIE, parseZone } from '@/lib/zone';

const HEADER = ['date', 'token', 'seller', 'buyer', 'price', 'currency', 'marketplace', 'held_seconds', 'buyer_age_seconds', 'price_vs_floor',
  ...METHODS.map((m) => LENSES[m].name + (LENSES[m].tone === 'apart' ? ' (not counted)' : '')), 'tx'];

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

function csvLine(r: TradeRow, ran: readonly Method[], money: ReadonlySet<string>): string {
  const priced = r.priceWei !== null && r.currency !== null && money.has(r.currency);
  const lens = (m: Method) => !ran.includes(m) ? 'did not run' : !r.judged ? 'not judged yet' : r.lenses.includes(m) ? 'caught' : '';
  return [
    r.blockTime === null ? '' : new Date(r.blockTime * 1000).toISOString(), r.tokenId, r.from, r.to,
    priced ? weiToEth(r.priceWei!) : '', priced ? 'ETH' : '',
    r.marketplace === null ? '' : VENUES[venueOf(r.marketplace)]?.name ?? r.marketplace,
    r.heldS, r.buyerAgeS, r.floorRatio,
    ...METHODS.map(lens), r.txHash,
  ].map(cell).join(',') + '\n';
}

/** The rows of an iterator as a CSV body, one per pull, so a slow reader holds one row and a cancelled download closes the cursor. */
function csvBody(it: AsyncGenerator<TradeRow>, ran: readonly Method[], money: ReadonlySet<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let head = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await it.next();
        const lead = head ? HEADER.map(cell).join(',') + '\n' : '';
        head = false;
        if (next.done) {
          if (lead) controller.enqueue(enc.encode(lead));
          controller.close();
        } else {
          controller.enqueue(enc.encode(lead + csvLine(next.value, ran, money)));
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
 * JSON is one page (50) with its count; `format=csv` streams every trade the
 * filters hold. A filter on a lens that did not run, or a Find nothing can
 * read, holds no trades.
 */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string; address: string }> }): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const s = store();
    const c = await s.collection(chainId, address);
    if (c === null) return bad('This collection is not watched.', 404);
    const url = new URL(req.url);
    const zone = parseZone((await cookies()).get(ZONE_COOKIE)?.value)?.zone ?? 'UTC';
    const { q, view } = parseView(paramsOf(url.searchParams), zone);
    const ran = lensesRan(c.latest);
    const ctx = { money: moneyFor(chainId), ran, zone };
    const empty = holdsNothing(q, ran) !== null;

    if (url.searchParams.get('format') === 'csv') {
      return new Response(csvBody(empty ? nothing() : s.tradeStream(c.id, q, ctx), ran, ctx.money), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${address}-trades.csv"`, 'cache-control': 'no-store' },
      });
    }

    const { total, unjudged } = empty ? { total: 0, unjudged: 0 } : await s.tradeCount(c.id, q, ctx);
    const pages = pagesOf(total, TRADES_PAGE);
    const page = Math.min(pages, view.page);
    const rows = total === 0 ? [] : await s.trades(c.id, q, ctx, TRADES_PAGE, (page - 1) * TRADES_PAGE);
    return json({ total, unjudged, page, pages, ran, rows });
  });
}
