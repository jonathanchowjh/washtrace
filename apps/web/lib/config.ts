import { ETHERSCAN_V2, type WorkerConfig } from '@washtrace/detect';

/** A setting is missing or malformed. Pages say so instead of rendering as though the chain were quiet. */
export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

/** The store every replica shares. Required: the worker's cursors and the API's answers both live there. */
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
  };
}

/**
 * `off` makes this process API-only: it serves reads and accepts collections
 * but runs no passes. Not required for safety, since the advisory locks
 * already keep N workers to one pass each; it is for keeping chain traffic
 * out of replicas that serve requests.
 */
export function workerEnabled(env: Env): boolean {
  return env.WASHTRACE_WORKER !== 'off';
}
