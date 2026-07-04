import { describe, expect, it } from 'vitest';
import { workerConfig } from '../src/env.js';

describe('workerConfig', () => {
  it('lets the environment win over a console setting', () => {
    const c = workerConfig({ WASHTRACE_RPC_1: 'https://env' }, new Map([['rpc.1', 'https://console']]));
    expect(c.rpc.get(1)).toBe('https://env');
    expect(c.sources['rpc.1']).toEqual({ source: 'env', value: null });
  });

  it('treats an empty variable as unset', () => {
    const c = workerConfig({ WASHTRACE_RPC_1: '' }, new Map([['rpc.1', 'https://console']]));
    expect(c.rpc.get(1)).toBe('https://console');
    expect(c.sources['rpc.1']!.source).toBe('console');
  });

  it('reports non-secret values, never secret ones', () => {
    const c = workerConfig({ WASHTRACE_ETHERSCAN_KEY: 'k', WASHTRACE_FOLLOW_HOPS: '2' });
    expect(c.sources['etherscan.key']!.value).toBeNull();
    expect(c.sources['follow.hops']).toEqual({ source: 'env', value: '2' });
  });

  it('takes console settings where the environment says nothing, and defaults where neither does', () => {
    const c = workerConfig({ WASHTRACE_ETHERSCAN_RPS: '  ' }, new Map([['rpc.8453', 'https://base'], ['etherscan.key', 'console-key'], ['follow.hops', '1']]));
    expect(c.rpc.get(8453)).toBe('https://base');
    expect(c.etherscanKey).toBe('console-key');
    expect(c.followHops).toBe(1);
    expect(c.etherscanPerSecond).toBe(4);
    expect(c.sources).toEqual({
      'rpc.8453': { source: 'console', value: null },
      'etherscan.key': { source: 'console', value: null },
      'follow.hops': { source: 'console', value: '1' },
    });
  });

  it('takes the Etherscan URL from the environment or the default, never the console, while the key is from the environment', () => {
    // Else a console user could send the environment's key to an address of their own.
    const settings = new Map([['etherscan.url', 'https://attacker.example/api']]);
    const byDefault = workerConfig({ WASHTRACE_ETHERSCAN_KEY: 'ENVKEY1234' }, settings);
    expect(byDefault.etherscanUrl).toBe('https://api.etherscan.io/v2/api');
    expect(byDefault.sources['etherscan.url']).toBeUndefined();
    const byEnv = workerConfig({ WASHTRACE_ETHERSCAN_KEY: 'ENVKEY1234', WASHTRACE_ETHERSCAN_URL: 'https://proxy.example/api' }, settings);
    expect(byEnv.etherscanUrl).toBe('https://proxy.example/api');
    expect(byEnv.sources['etherscan.url']).toEqual({ source: 'env', value: 'https://proxy.example/api' });
  });

  it('takes the console Etherscan URL with a console key, or with no key', () => {
    const url = 'https://proxy.example/api';
    const c = workerConfig({}, new Map([['etherscan.key', 'CONSOLEKEY'], ['etherscan.url', url]]));
    expect(c.etherscanUrl).toBe(url);
    expect(c.sources['etherscan.url']).toEqual({ source: 'console', value: url });
    expect(workerConfig({}, new Map([['etherscan.url', url]])).etherscanUrl).toBe(url);
  });

  it('reports the Etherscan URL with its credentials masked, and uses it whole', () => {
    const url = 'https://ada:pw5678@proxy.example/v2/api?apikey=SECRET1234&chainid=1';
    const c = workerConfig({ WASHTRACE_ETHERSCAN_URL: url });
    expect(c.etherscanUrl).toBe(url);
    expect(c.sources['etherscan.url']).toEqual({ source: 'env', value: 'https://••••@proxy.example/v2/api?apikey=••••&chainid=••••' });
  });

  it('masks the userinfo however the URL is spelled, as the URL parser reads it', () => {
    // Each parses as https with this userinfo, so the worker would send it.
    for (const [url, masked] of [
      ['https:ada:pw5678@x/api', 'https:••••@x/api'],
      ['https:/ada:pw5678@x/api', 'https:/••••@x/api'],
      ['https:\\ada:pw5678@x/api', 'https:\\••••@x/api'],
    ]) {
      expect(new URL(url!).password).toBe('pw5678');
      expect(workerConfig({ WASHTRACE_ETHERSCAN_URL: url }).sources['etherscan.url']!.value).toBe(masked);
    }
  });

  it('reads as before with no settings', () => {
    const c = workerConfig({});
    expect(c.rpc.size).toBe(0);
    expect(c.etherscanKey).toBeNull();
    expect(c.etherscanPerSecond).toBe(4);
    expect(c.followHops).toBe(3);
    expect(c.sources).toEqual({});
  });

  it('the stored repo defaults to the published dataset, and the environment beats the console', () => {
    expect(workerConfig({}).storedRepo).toBe('jonathanmiro97/washtrace-data');
    expect(workerConfig({}, new Map([['stored.repo', 'me/data']])).storedRepo).toBe('me/data');
    const c = workerConfig({ WASHTRACE_STORED_REPO: 'env/data' }, new Map([['stored.repo', 'me/data']]));
    expect(c.storedRepo).toBe('env/data');
    expect(c.sources['stored.repo']).toEqual({ source: 'env', value: 'env/data' });
  });
});
