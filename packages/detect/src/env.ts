import { ETHERSCAN_V2 } from './etherscan.js';
import { STORED_REPO } from './hub.js';
import { MAX_FOLLOW_HOPS } from './lens-rule.js';

/**
 * The settings that hold a secret: an RPC URL carries its provider's key.
 * Their values are kept in `settings`, which the worker needs, but only
 * masked in `setting_sources`, which the API reads, and in anything the API
 * returns.
 */
export const SECRET_KEYS = (key: string): boolean => key.startsWith('rpc.') || key === 'etherscan.key';

/**
 * Where the worker found one setting. `value` is the value used and `env` what
 * .env holds (null when it does not set it), each as the console may show it:
 * a secret masked, `etherscan.url` with its credentials masked, else raw.
 */
export interface SettingSource {
  source: 'env' | 'console';
  value: string | null;
  env: string | null;
}

/**
 * Every environment variable either service reads. In the package, not in
 * an app, because the API and the worker are two processes that must read
 * the same deployment the same way.
 */

/** What the worker reads from the environment and the console's settings on every pass, so a changed setting needs no restart. */
export interface WorkerConfig {
  /** RPC URL per chain id. A collection on a chain with none reports so, and waits. */
  rpc: ReadonlyMap<number, string>;
  etherscanKey: string | null;
  etherscanPerSecond: number;
  etherscanUrl: string;
  /** Hops of money to follow out of a trader for SCC AU. 0 reads traders only, as the paper did. */
  followHops: number;
  /** Days before a trader's money and tokens are read again when it trades. 0 (or unset) is off. */
  followReread?: number;
  /**
   * Whether the token read (Start reading) also reads every wallet a trader
   * paid in the listed tokens: one middle, all a one-middle loop needs, at up
   * to FOLLOW_FANOUT more reads a trader. Off by default, the cheaper floor.
   */
  tokensPayees: boolean;
  /** The Hugging Face dataset (owner/name) stored data is downloaded from. */
  storedRepo: string;
  /** Where each set value came from, keyed by setting key. Never a secret's value: the store publishes this. */
  sources: Record<string, SettingSource>;
}

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
 * Read on every pass, so the worker follows the environment and the
 * console's settings without being rebuilt. A value saved in the console
 * wins; the environment is the starting value, used until one is saved, then
 * the default. An empty or whitespace-only value (copied from .env.example)
 * counts as unset at every level. Each setting key has one variable:
 * `rpc.<chainId>` is `WASHTRACE_RPC_<chainId>`, `etherscan.key` is
 * `WASHTRACE_ETHERSCAN_KEY`, and so on. `sources` says, per setting, which
 * level it used, the value used and what the environment holds, each as the
 * console may show it (a secret masked, see shownSecret), for the console to
 * offer the environment's value back.
 *
 * The Etherscan URL follows its key: while the key comes from the
 * environment, so does the URL (or the default), never from the console.
 * Otherwise a console user could send the environment's key to an address
 * of their own.
 */
export function workerConfig(env: Env, settings: ReadonlyMap<string, string> = new Map()): WorkerConfig {
  const sources: Record<string, SettingSource> = {};
  const pick = (key: string, variable: string, envOnly = false): string | undefined => {
    const shown = (value: string) => (SECRET_KEYS(key) ? shownSecret(key, value) : key === 'etherscan.url' ? maskedUrl(value) : value);
    const fromEnv = env[variable]?.trim();
    const fromConsole = envOnly ? undefined : settings.get(key)?.trim();
    const used = fromConsole || fromEnv;
    if (!used) return undefined;
    sources[key] = { source: fromConsole ? 'console' : 'env', value: shown(used), env: fromEnv ? shown(fromEnv) : null };
    return used;
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
  const etherscanKey = pick('etherscan.key', 'WASHTRACE_ETHERSCAN_KEY') ?? null;
  return {
    rpc,
    etherscanKey,
    etherscanPerSecond: Number.isFinite(perSecond) && perSecond > 0 ? perSecond : 4,
    etherscanUrl: pick('etherscan.url', 'WASHTRACE_ETHERSCAN_URL', sources['etherscan.key']?.source === 'env') ?? ETHERSCAN_V2,
    followHops: hops(pick('follow.hops', 'WASHTRACE_FOLLOW_HOPS')),
    followReread: reread(pick('follow.reread', 'WASHTRACE_FOLLOW_REREAD')),
    // Only 'on' turns it on: a typo reads as the default, which reads fewer wallets.
    tokensPayees: pick('tokens.payees', 'WASHTRACE_TOKENS_PAYEES') === 'on',
    storedRepo: pick('stored.repo', 'WASHTRACE_STORED_REPO') ?? STORED_REPO,
    sources,
  };
}

/**
 * A secret as the console may show it: '••••' and its last 4 characters when
 * longer than 8, else '••••' alone. An RPC URL that parses as http(s) keeps
 * its scheme and host, to say which provider it is, as
 * `https://eth-mainnet.g.alchemy.com/••••A1B2`. Anything else (unparseable,
 * or another scheme) is dots and its last 4.
 */
export function shownSecret(key: string, value: string): string {
  if (value.length <= 8) return '••••';
  const tail = `••••${value.slice(-4)}`;
  if (!key.startsWith('rpc.')) return tail;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.host}/${tail}` : tail;
  } catch {
    return tail;
  }
}

/**
 * `url` with its credentials as '••••': its userinfo and every query value,
 * where a compatible API may take a key (urlSecrets below). Its host
 * and path stay, to say where it points. Kept as written, not re-serialised.
 */
export function maskedUrl(url: string): string {
  const q = url.indexOf('?');
  // Up to the last @ before the host ends, after the scheme and any slashes: the URL parser also reads userinfo in
  // `https:a:b@x`, `https:/a:b@x` and `https:\a:b@x`.
  const head = (q < 0 ? url : url.slice(0, q)).replace(/^([^:\/\\?#]*:[\/\\]*)[^\/\\?#]*@/, '$1••••@');
  if (q < 0) return head;
  const query = url.slice(q + 1).split('&').map((kv) => {
    const i = kv.indexOf('=');
    // A value with no name is still a value: urlSecrets counts it.
    if (i < 0) return kv === '' ? kv : '••••';
    return kv.length > i + 1 ? `${kv.slice(0, i + 1)}••••` : kv;
  });
  return `${head}?${query.join('&')}`;
}

/** Default 3: enough for a payment back through three outside wallets, the demo's #113. */
function hops(raw: string | undefined): number {
  const n = Number(raw ?? '3');
  return Number.isInteger(n) && n >= 0 && n <= MAX_FOLLOW_HOPS ? n : 3;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An error in a line: viem's short message and details, not its full
 * message, which adds the request body and the version. Other errors as
 * they are.
 */
export function briefOf(err: unknown): string {
  const e = err as { shortMessage?: unknown; details?: unknown } | null;
  if (typeof e?.shortMessage !== 'string') return messageOf(err);
  return typeof e.details === 'string' && e.details !== '' ? `${e.shortMessage} ${e.details}` : e.shortMessage;
}

/**
 * `text` with every secret and every URL taken out, cut to one short line.
 * RPC and HTTP clients put the request URL in their errors, and an RPC
 * URL is often its own key, so a URL is never kept even when not configured.
 */
export function redact(text: string, secrets: readonly string[]): string {
  // URLs first, whole: hiding a secret inside one first would leave the rest of it.
  let out = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
  // Ignoring case: a URL's host is lowercased once parsed, and a provider may echo it as it was written.
  for (const s of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[hidden]');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}

/**
 * The URL and its parts, as secrets. A provider's key is a path segment, a
 * query value or a subdomain, and a provider may echo it on its own, in the
 * URL without its scheme, or decoded, so each part is kept both as written
 * and decoded. With `credentialsOnly`, only the parts that can carry a key in
 * a public API's URL: its userinfo and query values. Its host and path are
 * public ("etherscan" among them), and hiding them would hide whose error it is.
 */
export function urlSecrets(url: string, credentialsOnly = false): string[] {
  const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const parts = credentialsOnly ? [] : [url, bare, bare.replace(/\/+$/, '')];
  try {
    const u = new URL(url);
    if (!credentialsOnly) parts.push(u.host, u.hostname, ...u.hostname.split('.').filter((l) => l.length >= 6), ...u.pathname.split('/').filter((p) => p.length >= 6));
    parts.push(u.username, u.password);
    // The Authorization header the transport sends for them, which a proxy may echo.
    if (u.username !== '' || u.password !== '') {
      parts.push(Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'));
    }
    parts.push(...u.search.slice(1).split('&').map((kv) => kv.slice(kv.indexOf('=') + 1)).filter((v) => v.length >= 6));
  } catch {
    // Not a URL: every run of six or more between separators.
    if (!credentialsOnly) parts.push(...url.split(/[/?&=:@#]/).filter((p) => p.length >= 6));
  }
  // A query value encodes a space as '+', which decodeURIComponent leaves.
  return parts.flatMap((p) => {
    try { return [p, decodeURIComponent(p), decodeURIComponent(p.replace(/\+/g, ' '))]; } catch { return [p]; }
  });
}

/**
 * Every secret in a config: the RPC URLs whole (an RPC URL is often its own
 * key), the credentials in the Etherscan URL (a compatible API may take a key
 * in its query), and the key.
 */
export function configSecrets(config: WorkerConfig): string[] {
  return [...[...config.rpc.values()].flatMap((u) => urlSecrets(u)), ...urlSecrets(config.etherscanUrl, true), config.etherscanKey ?? ''];
}

/** Default 0 (off). A whole number of days up to a year; anything else is off. */
function reread(raw: string | undefined): number {
  const n = Number(raw ?? '0');
  return Number.isInteger(n) && n >= 0 && n <= 365 ? n : 0;
}
