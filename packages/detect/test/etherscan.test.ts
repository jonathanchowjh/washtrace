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
});
