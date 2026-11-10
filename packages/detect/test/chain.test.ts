import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError, TransactionReceiptNotFoundError, UnknownRpcError, WebSocketRequestError, type PublicClient } from 'viem';
import { Chain, CHECK_TIMEOUT_MS, TERRAFORMS, TRANSFER } from '../src/chain.js';

/** A Chain whose node answers from these functions; nothing reaches a network. */
function fake(answer: { finalized?: () => unknown; balance?: () => unknown; logs?: () => unknown }): { c: Chain; asked: unknown[] } {
  const c = new Chain(1, 'https://rpc.example/key');
  const asked: unknown[] = [];
  // check() reads through its own client, with its own short timeout.
  Object.assign((c as unknown as { checkClient: PublicClient }).checkClient, {
    getBlock: async () => ({ number: BigInt((answer.finalized ?? (() => 2_000_000))() as number) }),
    getBalance: async (args: unknown) => { asked.push(['balance', args]); return (answer.balance ?? (() => 0n))(); },
    request: async (args: unknown) => { asked.push(['logs', args]); return (answer.logs ?? (() => []))(); },
  });
  return { c, asked };
}

describe('Chain.check', () => {
  it('reads the finalized block, an old balance and 50,000 blocks of Terraforms transfers', async () => {
    const { c, asked } = fake({});
    expect(await c.check()).toEqual({ finalized: 2_000_000, archive: true, logs: true });
    expect(asked).toContainEqual(['balance', { address: '0x0000000000000000000000000000000000000000', blockNumber: 1_000_000n }]);
    expect(asked).toContainEqual(['logs', {
      method: 'eth_getLogs',
      params: [{ address: TERRAFORMS, topics: [TRANSFER], fromBlock: `0x${(2_000_000 - 49_999).toString(16)}`, toBlock: `0x${(2_000_000).toString(16)}` }],
    }]);
  });

  it('says false for a part that fails, and throws only when the finalized block cannot be read', async () => {
    const no = () => { throw new Error('refused'); };
    expect(await fake({ balance: no }).c.check()).toEqual({ finalized: 2_000_000, archive: false, logs: true });
    expect(await fake({ logs: no }).c.check()).toEqual({ finalized: 2_000_000, archive: true, logs: false });
    await expect(fake({ finalized: no }).c.check()).rejects.toThrow(/refused/);
  });
});

describe('Chain.check against a node that never answers', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); }
  });

  /** A local node: `answer` replies or, returning false, leaves the request hanging. Records each request body. */
  async function node(answer: (body: any, res: ServerResponse) => boolean): Promise<{ url: string; bodies: any[] }> {
    const bodies: any[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => { const body = JSON.parse(raw); bodies.push(body); answer(body, res); });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/key`, bodies };
  }

  /** Real I/O goes on while timers are fake: wait for the node to have seen `n` requests. */
  async function seen(bodies: unknown[], n: number): Promise<void> {
    while (bodies.length < n) await new Promise((r) => setImmediate(r));
  }

  it('gives up on the finalized block after one try, within the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { url, bodies } = await node(() => false);
    const settled = new Chain(1, url).check().then(() => 'answered', () => 'threw');
    await seen(bodies, 1);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 100);
    expect(await settled).toBe('threw');
    expect(bodies).toHaveLength(1);
  });

  it('reads the archive and the logs at once, each its own request, false when they hang', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const block = { number: '0x1e8480', hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'1'.repeat(64)}`, timestamp: '0x1', transactions: [], logsBloom: `0x${'0'.repeat(512)}`, miner: `0x${'0'.repeat(40)}`, difficulty: '0x0', gasLimit: '0x1', gasUsed: '0x0', extraData: '0x', size: '0x1', uncles: [], nonce: '0x0000000000000000', baseFeePerGas: '0x1', stateRoot: `0x${'1'.repeat(64)}`, receiptsRoot: `0x${'1'.repeat(64)}`, transactionsRoot: `0x${'1'.repeat(64)}`, sha3Uncles: `0x${'1'.repeat(64)}`, mixHash: `0x${'1'.repeat(64)}` };
    const { url, bodies } = await node((body, res) => {
      if (Array.isArray(body) || body.method !== 'eth_getBlockByNumber') return false;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: block }));
      return true;
    });
    let result: unknown = null;
    const settled = new Chain(1, url).check().then((r) => { result = r; });
    await seen(bodies, 3);
    // One timeout for both, not one after the other.
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 100);
    await settled;
    expect(result).toEqual({ finalized: 2_000_000, archive: false, logs: false });
    expect(bodies.map((b) => (Array.isArray(b) ? 'batch' : b.method)).sort()).toEqual(['eth_getBalance', 'eth_getBlockByNumber', 'eth_getLogs']);
  });
});

describe('Chain.transfers when a log read fails', () => {
  /** A Chain whose log reads throw `errors` in turn, then answer empty. Returns how many reads were made. */
  function failing(...errors: unknown[]): { c: Chain; reads: () => number; span: () => number; spans: number[] } {
    const c = new Chain(1, 'https://rpc.example/key');
    let reads = 0;
    const spans: number[] = [];
    (c as unknown as { client: { request: () => unknown } }).client.request = async () => {
      spans.push((c as unknown as { span: number }).span);
      const err = errors[reads++];
      if (err !== undefined) throw err;
      return [];
    };
    return { c, reads: () => reads, span: () => (c as unknown as { span: number }).span, spans };
  }
  const url = 'https://rpc.example/key';

  it('rethrows a 429 at once and keeps the span', async () => {
    const { c, reads, span } = failing(new HttpRequestError({ url, status: 429 }));
    const before = span();
    await expect(c.transfers(TERRAFORMS, 1, 100_000)).rejects.toBeInstanceOf(HttpRequestError);
    expect(reads()).toBe(1);
    expect(span()).toBe(before);
  });

  it('rethrows a dropped connection (no HTTP status) without shrinking the span', async () => {
    const err = new HttpRequestError({ url, cause: new TypeError('fetch failed') });
    const { c, reads, span } = failing(err);
    const before = span();
    await expect(c.transfers(TERRAFORMS, 1, 100_000)).rejects.toBe(err);
    expect(reads()).toBe(1);
    expect(span()).toBe(before);
  });

  it('halves on a timeout and on a 503, as before: a range too heavy often looks like either', async () => {
    for (const err of [new TimeoutError({ body: {}, url }), new HttpRequestError({ url, status: 503 })]) {
      const { c, reads, spans } = failing(err);
      await c.transfers(TERRAFORMS, 1, 100_000);
      expect(reads()).toBe(2);
      expect(spans).toEqual([2_000, 1_000]);
    }
  });

  it('keeps the span on a JSON-RPC rate limit, found in the error or in its cause', async () => {
    const rpc = (code: number) => new RpcRequestError({ body: {}, url, error: { code, message: 'rate limited' } });
    for (const err of [
      rpc(429),
      rpc(-32007),
      new UnknownRpcError(rpc(429)),
      new UnknownRpcError(new HttpRequestError({ url, status: 429 })),
      new WebSocketRequestError({ url }),
    ]) {
      const { c, reads, span } = failing(err);
      await expect(c.transfers(TERRAFORMS, 1, 100_000)).rejects.toBe(err);
      expect(reads()).toBe(1);
      expect(span()).toBe(2_000);
    }
  });

  it('halves on a 200 whose body was not JSON: no status, but not a lost connection', async () => {
    const { c, spans } = failing(new HttpRequestError({ url, cause: new SyntaxError('Unexpected token <') }));
    await c.transfers(TERRAFORMS, 1, 100_000);
    expect(spans).toEqual([2_000, 1_000]);
  });

  it('halves the span on a range refusal, as before', async () => {
    const limit = new LimitExceededRpcError(new RpcRequestError({ body: {}, url, error: { code: -32005, message: 'query returned more than 10000 results' } }));
    const { c, reads, spans } = failing(limit);
    await c.transfers(TERRAFORMS, 1, 100_000);
    expect(reads()).toBe(2);
    expect(spans).toEqual([2_000, 1_000]);
  });

  it('halves the span on an error it does not recognise, as before', async () => {
    const { c, reads, span } = failing(new Error('block range is too wide'), new HttpRequestError({ url, status: 400 }));
    await c.transfers(TERRAFORMS, 1, 100_000);
    expect(reads()).toBe(3);
    // Halved twice, then doubled by the empty read that followed.
    expect(span()).toBe(1_000);
  });
});

describe('Chain.tokenTransfers and Chain.receipt', () => {
  const url = 'https://rpc.example/key';
  const pad = (hex: string) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;
  const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`;
  /** One Transfer log of token `id` in `block`, as a node returns it. */
  const log = (id: number, block: number) => ({
    address: TERRAFORMS, topics: [TRANSFER, pad(A), pad(B), pad(id.toString(16))], data: '0x',
    blockNumber: `0x${block.toString(16)}`, transactionHash: pad(block.toString(16)), logIndex: '0x0',
  });

  /** A Chain whose log query answers each call from `answer(range)`, recording the ranges asked. */
  function node(answer: (from: number, to: number) => unknown): { c: Chain; ranges: [number, number][]; params: any[] } {
    const c = new Chain(1, url);
    const ranges: [number, number][] = [];
    const params: any[] = [];
    const client = (c as unknown as { client: { request: (a: any) => unknown; getTransactionReceipt: (a: any) => unknown } }).client;
    client.request = async ({ params: [p] }: any) => {
      params.push(p);
      const range: [number, number] = [Number(p.fromBlock), Number(p.toBlock)];
      ranges.push(range);
      const out = answer(...range);
      if (out instanceof Error) throw out;
      return out;
    };
    client.getTransactionReceipt = async ({ hash }: any) => ({ transactionHash: hash, logs: [] });
    return { c, ranges, params };
  }

  it('asks for the whole range first, filtered to the token', async () => {
    const { c, ranges, params } = node((from) => [log(7, from)]);
    const got = await c.tokenTransfers(TERRAFORMS, '7', 100, 5_000);
    expect(ranges).toEqual([[100, 5_000]]);
    expect(params[0]).toEqual({ address: TERRAFORMS, topics: [TRANSFER, null, null, pad('7')], fromBlock: '0x64', toBlock: `0x${(5_000).toString(16)}` });
    expect(got).toMatchObject([{ tokenId: '7', from: A, to: B, blockNumber: 100 }]);
  });

  /** A provider that refuses any range wider than `cap` blocks, as many cap eth_getLogs. */
  const capped = (cap: number) => (from: number, to: number) => (to - from + 1 > cap ? new Error('block range is too wide') : [log(7, from)]);

  it('halves on a refusal and reads every part in order, never again as wide as a refused range', async () => {
    const { c, ranges } = node(capped(300));
    const got = await c.tokenTransfers(TERRAFORMS, '7', 1, 1_000);
    // Growing back to 500 would be refused on every other query against a provider's fixed cap.
    expect(ranges).toEqual([[1, 1_000], [1, 500], [1, 250], [251, 500], [501, 750], [751, 1_000]]);
    expect(got.map((t) => t.blockNumber)).toEqual([1, 251, 501, 751]);
  });

  it('a later token of the same check starts at the width the first one was refused down to', async () => {
    const { c, ranges } = node(capped(300));
    const width = { span: Infinity };
    await c.tokenTransfers(TERRAFORMS, '7', 1, 1_000, Infinity, width);
    expect(width.span).toBe(250);
    ranges.length = 0;
    await c.tokenTransfers(TERRAFORMS, '8', 1, 1_000, Infinity, width);
    expect(ranges).toEqual([[1, 250], [251, 500], [501, 750], [751, 1_000]]);
    // The Chain lives as long as the worker: another check learns afresh.
    ranges.length = 0;
    await c.tokenTransfers(TERRAFORMS, '9', 1, 1_000);
    expect(ranges[0]).toEqual([1, 1_000]);
  });

  it('an outage teaches no width: only a query answered after a refusal does', async () => {
    let down = true;
    const { c, ranges } = node((from) => (down ? new Error('upstream unavailable') : [log(7, from)]));
    const width = { span: Infinity };
    await expect(c.tokenTransfers(TERRAFORMS, '7', 1, 1_000, Infinity, width)).rejects.toThrow('upstream unavailable');
    expect(width.span).toBe(Infinity);
    down = false;
    ranges.length = 0;
    await c.tokenTransfers(TERRAFORMS, '7', 1, 1_000, Infinity, width);
    expect(ranges).toEqual([[1, 1_000]]);
  });

  it('stops with a sentence once the check\'s time is up', async () => {
    const { c, ranges } = node(capped(300));
    await expect(c.tokenTransfers(TERRAFORMS, '7', 1, 1_000, Date.now() - 1))
      .rejects.toThrow('Reading the history of token 7 took longer than a spot check allows: this RPC answers only narrow log queries.');
    expect(ranges).toHaveLength(0);
  });

  it('rethrows a rate limit at once', async () => {
    const err = new HttpRequestError({ url, status: 429 });
    const { c, ranges } = node(() => err);
    await expect(c.tokenTransfers(TERRAFORMS, '7', 1, 1_000)).rejects.toBe(err);
    expect(ranges).toHaveLength(1);
  });

  it('leaves the span learned for whole collections alone', async () => {
    const { c } = node(() => new Error('too wide'));
    const span = () => (c as unknown as { span: number }).span;
    const before = span();
    await expect(c.tokenTransfers(TERRAFORMS, '7', 1, 1)).rejects.toThrow('too wide');
    expect(span()).toBe(before);
  });

  it('reads a receipt, and null for a transaction the node does not have', async () => {
    const c = new Chain(1, url);
    const client = (c as unknown as { client: { getTransactionReceipt: (a: any) => unknown } }).client;
    client.getTransactionReceipt = async ({ hash }: any) => {
      if (hash === pad('1')) return { blockNumber: 42n, status: 'reverted', logs: [log(7, 42)] };
      throw new TransactionReceiptNotFoundError({ hash });
    };
    expect(await c.receipt(pad('1'))).toEqual({ blockNumber: 42, reverted: true, logs: [log(7, 42)] });
    expect(await c.receipt(pad('2'))).toBeNull();
  });

  it('reads many receipts by hash', async () => {
    const c = new Chain(1, url);
    const client = (c as unknown as { client: { getTransactionReceipt: (a: any) => unknown } }).client;
    client.getTransactionReceipt = async ({ hash }: any) => ({ transactionHash: hash, logs: [log(1, 1)] });
    const got = await c.receipts([pad('1'), pad('2')]);
    expect([...got.keys()]).toEqual([pad('1'), pad('2')]);
    expect(got.get(pad('2'))).toEqual([log(1, 1)]);
  });
});
