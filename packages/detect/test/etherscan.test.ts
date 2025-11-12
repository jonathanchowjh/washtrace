import { describe, expect, it } from 'vitest';
import { Etherscan } from '../src/etherscan.js';

function row(i: number, more: Record<string, string> = {}) {
  return { hash: `0xH${i}`, from: '0xA', to: '0xB', value: '5', blockNumber: String(i), timeStamp: String(i), isError: '0', ...more };
}

/** An Etherscan whose network is a function of the request's query. */
function fake(answer: (q: URLSearchParams) => unknown): { e: Etherscan; urls: URL[] } {
  const e = new Etherscan('KEY', 1_000);
  const urls: URL[] = [];
  e.fetch = async (url: URL) => {
    urls.push(url);
    return new Response(JSON.stringify(answer(url.searchParams)));
  };
  return { e, urls };
}

describe('Etherscan', () => {
  it('reads native, internal, WETH and Blur Pool on Ethereum, lowercased', async () => {
    const { e, urls } = fake((q) => ({ status: '1', message: 'OK', result: q.get('action') === 'txlist' ? [row(1)] : [] }));
    const { flows, truncated } = await e.flows(1, '0xa');
    expect(urls.map((u) => [u.searchParams.get('action'), u.searchParams.get('contractaddress')])).toEqual([
      ['txlist', null], ['txlistinternal', null],
      ['tokentx', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'], ['tokentx', '0x0000000000a39bb272e79075ade125fd351887ac'],
    ]);
    expect(urls[0]!.searchParams.get('chainid')).toBe('1');
    expect(flows).toEqual([{ txHash: '0xh1', kind: 'native', from: '0xa', to: '0xb', valueWei: '5', token: '', blockNumber: 1, blockTime: 1 }]);
    expect(truncated).toBe(false);
  });

  it('reads who deployed a contract, lowercased, and null where Etherscan does not know', async () => {
    const { e, urls } = fake(() => ({ status: '1', message: 'OK', result: [{ contractAddress: '0xc', contractCreator: '0xABC', txHash: '0xDEF' }] }));
    expect(await e.creation(1, '0xc')).toEqual({ creator: '0xabc', txHash: '0xdef' });
    expect([urls[0]!.searchParams.get('action'), urls[0]!.searchParams.get('contractaddresses')]).toEqual(['getcontractcreation', '0xc']);
    expect(await fake(() => ({ status: '0', message: 'No data found', result: [] })).e.creation(1, '0xc')).toBeNull();
  });

  it('paces calls made at once a gap apart, as it does calls made one after another', async () => {
    const e = new Etherscan('KEY', 10);
    const sent: number[] = [];
    e.fetch = async () => { sent.push(Date.now()); return new Response(JSON.stringify({ status: '1', message: 'OK', result: [] })); };
    await Promise.all([e.creation(1, '0xa'), e.creation(1, '0xb'), e.creation(1, '0xc')]);
    expect(sent[1]! - sent[0]!).toBeGreaterThanOrEqual(95);
    expect(sent[2]! - sent[1]!).toBeGreaterThanOrEqual(95);
  });

  it('reads "No transactions found" as an empty list', async () => {
    const { e } = fake(() => ({ status: '0', message: 'No transactions found', result: [] }));
    expect((await e.flows(8453, '0xa')).flows).toEqual([]);
  });

  it('skips failed and zero-value transactions', async () => {
    const { e } = fake((q) => ({ status: '1', message: 'OK', result: q.get('action') === 'txlist' ? [row(1, { isError: '1' }), row(2, { value: '0' })] : [] }));
    expect((await e.flows(1, '0xa')).flows).toEqual([]);
  });

  it('pages, and says when a wallet has more than Etherscan will page through', async () => {
    const { e } = fake((q) => ({
      status: '1', message: 'OK',
      result: q.get('action') === 'txlist' ? Array.from({ length: 1_000 }, (_, i) => row(i)) : [],
    }));
    const { flows, truncated } = await e.flows(1, '0xa');
    expect(flows).toHaveLength(10_000);
    expect(truncated).toBe(true);
  });

  it('retries a rate-limit refusal, and never puts the key in an error', async () => {
    let calls = 0;
    const { e } = fake(() => (++calls === 1
      ? { status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' }
      : { status: '0', message: 'NOTOK', result: 'Invalid API Key' }));
    await expect(e.call(1, { action: 'txlist' })).rejects.toThrow(/Invalid API Key/);
    await expect(e.call(1, { action: 'txlist' })).rejects.not.toThrow(/KEY/);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('pings once with a short timeout, so a Test answers while the page still polls', async () => {
    const e = new Etherscan('KEY', 1_000);
    const timeouts: (number | undefined)[] = [];
    e.fetch = async (_url: URL, timeoutMs?: number) => {
      timeouts.push(timeoutMs);
      return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' }));
    };
    await expect(e.ping(1)).rejects.toThrow(/rate limit/);
    expect(timeouts).toEqual([6_000]);
  });

  it('pings with one cheap call, and a refusal names the reason but never the key', async () => {
    const { e, urls } = fake(() => ({ jsonrpc: '2.0', id: 83, result: '0x1908a3c' }));
    await e.ping(8453);
    expect([urls[0]!.searchParams.get('module'), urls[0]!.searchParams.get('action'), urls[0]!.searchParams.get('chainid')]).toEqual(['proxy', 'eth_blockNumber', '8453']);
    const refused = fake(() => ({ status: '0', message: 'NOTOK', result: 'Invalid API Key' })).e;
    await expect(refused.ping(1)).rejects.toThrow(/Invalid API Key/);
    await expect(refused.ping(1)).rejects.not.toThrow(/KEY/);
    const jsonRpcError = fake(() => ({ jsonrpc: '2.0', id: 83, error: { code: -32000, message: 'chain not supported' } })).e;
    await expect(jsonRpcError.ping(999)).rejects.toThrow(/chain not supported/);
  });
});
