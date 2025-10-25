import { ETHERSCAN_V2 } from './etherscan.js';
import { SECRET_KEYS, type SettingSource } from './store.js';
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

/**
 * Read on every pass, so the worker follows the environment and the
 * console's settings without being rebuilt. The environment wins, so a
 * deployment can pin a value; an empty variable (copied from .env.example)
 * counts as unset. Each setting key has one variable: `rpc.<chainId>` is
 * `WASHTRACE_RPC_<chainId>`, `etherscan.key` is `WASHTRACE_ETHERSCAN_KEY`, and
 * so on. `sources` says where each set value came from, never a secret's
 * value, for the console to lock what the environment pinned.
 */
export function workerConfig(env: Env, settings: ReadonlyMap<string, string> = new Map()): WorkerConfig {
  const sources: Record<string, SettingSource> = {};
  const pick = (key: string, variable: string): string | undefined => {
    const shown = (value: string) => (SECRET_KEYS(key) ? null : value);
    const fromEnv = env[variable]?.trim();
    if (fromEnv) {
      sources[key] = { source: 'env', value: shown(fromEnv) };
      return fromEnv;
    }
    const fromConsole = settings.get(key)?.trim();
    if (fromConsole) {
      sources[key] = { source: 'console', value: shown(fromConsole) };
      return fromConsole;
    }
    return undefined;
  };
  const rpc = new Map<number, string>();
  const chains = new Set([...Object.keys(env), ...settings.keys()].flatMap((k) => {
    const m = /^(?:WASHTRACE_RPC_|rpc\.)(\d+)$/.exec(k);
    return m ? [Number(m[1])] : [];
  }));
  for (const id of [...chains].sort((a, b) => a - b)) {
    const url = pick(`rpc.${id}`, `WASHTRACE_RPC_${id}`);
    if (url !== undefined) rpc.set(id, url);
  }
  const perSecond = Number(pick('etherscan.rps', 'WASHTRACE_ETHERSCAN_RPS') ?? '4');
  return {
    rpc,
    etherscanKey: pick('etherscan.key', 'WASHTRACE_ETHERSCAN_KEY') ?? null,
    etherscanPerSecond: Number.isFinite(perSecond) && perSecond > 0 ? perSecond : 4,
    etherscanUrl: pick('etherscan.url', 'WASHTRACE_ETHERSCAN_URL') ?? ETHERSCAN_V2,
    followHops: hops(pick('follow.hops', 'WASHTRACE_FOLLOW_HOPS')),
    sources,
  };
}

/** Default 3: enough for a payment back through three outside wallets, the demo's #113. */
function hops(raw: string | undefined): number {
  const n = Number(raw ?? '3');
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 3;
}
