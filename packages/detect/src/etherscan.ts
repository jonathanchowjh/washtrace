import { WRAPPED } from './marketplaces.js';
import type { Flow, FlowKind } from './types.js';

export const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
/** Etherscan's own ceiling: page × offset may not exceed 10,000. */
const PAGE = 1_000;
const PAGES = 10;
const RETRIES = 4;
/** A Test's one try waits this long, so it answers inside the 20 seconds the console polls for. */
const PING_TIMEOUT_MS = 6_000;
/** One page waits this long. A busy wallet's pages can take over a minute to come back, and 30 seconds failed them every time. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** One wallet's reads stop asking for pages after this long, so a funding pass ends inside its stuck ceiling; it is tried again later. */
export const WALLET_MS = 6 * 60_000;

interface Row {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNumber: string;
  timeStamp: string;
  isError?: string;
  contractAddress?: string;
}

/**
 * Who paid whom, per wallet: the user transaction graph the paper built from
 * ETH transfers (its dataset 3), now read from Etherscan API V2. V1 was shut
 * off on 15 August 2025; V2 is one base URL and one key for every chain,
 * selected by `chainid`.
 *
 * Money is native transfers, internal transfers (contract payouts, such as a
 * marketplace paying a seller) and the chain's wrapped native tokens: WETH,
 * and on Ethereum Blur Pool, where Blur bids are held. In 2023 only ETH was
 * read; a wash trader funding a second wallet in WETH was invisible.
 *
 * A class because the key and its pacing are shared by every call. Etherscan
 * limits a key, not a chain, so one instance serves every chain.
 */
export class Etherscan {
  private last = 0;

  constructor(
    private readonly key: string,
    /** Calls per second. The free plan allows 5; 4 leaves room for a second consumer of the key. */
    private readonly perSecond = 4,
    /** Any API that answers Etherscan's account actions: Blockscout and Routescan do, per chain. */
    private readonly base = ETHERSCAN_V2,
  ) {}

  /**
   * Every flow in or out of `wallet`, and whether any list was longer than
   * Etherscan pages through. Past `budgetMs` no further page is asked for and
   * the read fails, rather than holding the funding pass past its ceiling.
   */
  async flows(chainId: number, wallet: string, budgetMs = Infinity): Promise<{ flows: Flow[]; truncated: boolean }> {
    const deadline = Date.now() + budgetMs;
    const lists: [FlowKind, Record<string, string>][] = [
      ['native', { action: 'txlist' }],
      ['internal', { action: 'txlistinternal' }],
      ...(WRAPPED[chainId] ?? []).map((token): [FlowKind, Record<string, string>] =>
        ['token', { action: 'tokentx', contractaddress: token }]),
    ];
    const flows: Flow[] = [];
    let truncated = false;
    for (const [kind, params] of lists) {
      for (let page = 1; page <= PAGES; page++) {
        if (Date.now() > deadline) throw new Error(`Etherscan took over ${Math.round(budgetMs / 60_000)} minutes to page through this wallet`);
        const rows = await this.call(chainId, { module: 'account', address: wallet, page: String(page), offset: String(PAGE), sort: 'asc', ...params });
        for (const r of rows) {
          if (r.isError === '1' || r.value === '0' || !r.to) continue;
          flows.push({
            txHash: r.hash.toLowerCase(),
            kind,
            from: r.from.toLowerCase(),
            to: r.to.toLowerCase(),
            valueWei: r.value,
            token: kind === 'token' ? (r.contractAddress ?? '').toLowerCase() : '',
            blockNumber: Number(r.blockNumber),
            blockTime: Number(r.timeStamp),
          });
        }
        if (rows.length < PAGE) break;
        if (page === PAGES) truncated = true;
      }
    }
    return { flows, truncated };
  }

  /** Who deployed `contract`, and in which transaction. Null where Etherscan does not know. */
  async creation(chainId: number, contract: string): Promise<{ creator: string; txHash: string } | null> {
    const rows = await this.call(chainId, { module: 'contract', action: 'getcontractcreation', contractaddresses: contract }) as unknown as { contractCreator?: string; txHash?: string }[];
    const row = rows[0];
    return row?.contractCreator && row.txHash ? { creator: row.contractCreator.toLowerCase(), txHash: row.txHash.toLowerCase() } : null;
  }

  /**
   * One cheap call, for the console's Test: the latest block number through
   * Etherscan's proxy module. Resolves when the key, the URL and the chain
   * are all accepted. Proxy answers are JSON-RPC shaped, not the account
   * module's status and result, so this does not go through `call`. Tried
   * once with a short timeout, a rate-limit refusal included.
   */
  async ping(chainId: number): Promise<void> {
    await this.pace();
    const res = await this.fetch(this.url(chainId, { module: 'proxy', action: 'eth_blockNumber' }), PING_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Etherscan answered HTTP ${res.status}`);
    const body = await res.json() as { result?: unknown; message?: string; error?: { message?: string } };
    if (typeof body.result === 'string' && /^0x[0-9a-f]+$/i.test(body.result)) return;
    const reason = body.error?.message ?? (typeof body.result === 'string' ? body.result : body.message ?? 'no block number');
    throw new Error(`Etherscan refused eth_blockNumber: ${reason}`);
  }

  /** One request, paced, with rate-limit refusals retried. "No transactions found" is an empty list, not an error. */
  async call(chainId: number, params: Record<string, string>): Promise<Row[]> {
    const url = this.url(chainId, params);
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`Etherscan answered HTTP ${res.status}`);
      const body = await res.json() as { status: string; message: string; result: unknown };
      if (body.status === '1' && Array.isArray(body.result)) return body.result as Row[];
      if (Array.isArray(body.result) && body.result.length === 0) return [];
      const reason = typeof body.result === 'string' ? body.result : body.message;
      if (/rate limit/i.test(reason) && attempt < RETRIES) {
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      // The key is never in the message: it is in the URL, and this reaches logs and pages.
      throw new Error(`Etherscan refused ${params.action ?? 'the call'}: ${reason}`);
    }
  }

  /** The request URL. It carries the key: never logged, never in an error. */
  private url(chainId: number, params: Record<string, string>): URL {
    const url = new URL(this.base);
    url.search = new URLSearchParams({ chainid: String(chainId), ...params, apikey: this.key }).toString();
    return url;
  }

  /** The network seam; tests override it on the instance. */
  fetch(url: URL, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  }

  /** Waits for this call's slot. The slot is taken before the wait, so callers at once (the ingest and fund jobs) queue a gap apart. */
  private async pace(): Promise<void> {
    const at = Math.max(Date.now(), this.last + 1_000 / this.perSecond);
    this.last = at;
    if (at > Date.now()) await sleep(at - Date.now());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
