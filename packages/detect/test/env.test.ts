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

  it('reads as before with no settings', () => {
    const c = workerConfig({});
    expect(c.rpc.size).toBe(0);
    expect(c.etherscanKey).toBeNull();
    expect(c.etherscanPerSecond).toBe(4);
    expect(c.followHops).toBe(3);
    expect(c.sources).toEqual({});
  });
});
