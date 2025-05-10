import { ETHERSCAN_V2 } from './etherscan.js';
import type { WorkerConfig } from './worker.js';

/**
 * Every environment variable either service reads. In the package, not in
 * an app, because the API and the worker are two processes that must read
 * the same deployment the same way.
 */

/** A setting is missing or malformed. Said as such, never as an empty chain. */
export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

/** The store both services share. Required: the worker's cursors and the API's answers both live there. */
export function storeUrl(env: Env): string {
  const url = env.WASHTRACE_STORE_URL ?? env.DATABASE_URL;
  if (!url) throw new ConfigError('No store is configured. Set WASHTRACE_STORE_URL to a Postgres database washtrace may create its schema in.');
  return url;
}

/**
 * One variable per chain, `WASHTRACE_RPC_<chainId>`, so a chain is added
 * without editing a JSON blob that holds every provider key at once.
 */
export function rpcUrls(env: Env): Map<number, string> {
  const out = new Map<number, string>();
  for (const [k, v] of Object.entries(env)) {
    const m = /^WASHTRACE_RPC_(\d+)$/.exec(k);
    if (m && v) out.set(Number(m[1]), v);
  }
  return out;
}

/** Read on every pass, so the worker follows the environment it is given without being rebuilt. */
export function workerConfig(env: Env): WorkerConfig {
  const perSecond = Number(env.WASHTRACE_ETHERSCAN_RPS ?? '4');
  return {
    rpc: rpcUrls(env),
    etherscanKey: env.WASHTRACE_ETHERSCAN_KEY || null,
    etherscanPerSecond: Number.isFinite(perSecond) && perSecond > 0 ? perSecond : 4,
    etherscanUrl: env.WASHTRACE_ETHERSCAN_URL || ETHERSCAN_V2,
    followHops: hops(env.WASHTRACE_FOLLOW_HOPS),
  };
}

/** Default 3: enough for a payment back through three outside wallets, the demo's #113. */
function hops(raw: string | undefined): number {
  const n = Number(raw ?? '3');
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 3;
}
