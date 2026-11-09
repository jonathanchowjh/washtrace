import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError, UnknownRpcError, WebSocketRequestError, type PublicClient } from 'viem';
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
