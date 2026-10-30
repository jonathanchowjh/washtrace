import type { SettingSource } from '@washtrace/detect';

/**
 * The settings the console can change, how each is checked, and how each is
 * shown. The worker reads the same keys (workerConfig), a console value
 * first, then the environment; this file only decides what the API accepts
 * and what it answers.
 * Free of runtime imports, so the settings page can use FIELDS as well.
 */

/**
 * One setting the console offers. `validate` is the console's check on a
 * save: the sentence a 400 says, or null. `used` is the worker's own, looser
 * parsing (env.ts): whether it takes the value or falls back to its default.
 * Every value `used` refuses, `validate` refuses too, so its sentence explains.
 */
export interface Field {
  key: string;
  label: string;
  secret: boolean;
  validate(v: string): string | null;
  used(v: string): boolean;
  /** What the worker uses while this is not set (env.ts), for the page to say. None for a source, which is off until set. */
  fallback?: string;
  /** How a value is shown, when not as it is: the Etherscan URL without its credentials. */
  show?(v: string): string;
}

/** A field as the API answers it: where its value came from and as much of it as may be shown. */
export interface FieldView {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
  /** A secret is masked (shownSecret), and '••••' alone for someone who may not change it; anything else is its value. */
  shown: string | null;
  source: 'env' | 'console' | null;
  /** What `.env` holds for it, shown the same way (null: nothing), for Reset to say what it goes back to. '••••' for a secret when the viewer may not write. */
  env: string | null;
  /** True when this viewer can't change it: `pinned`, or they may not write. */
  locked: boolean;
  /** Why no one can change it here, whoever views it (see pinned), or null. */
  pinned: string | null;
  /** Why the worker ignores this value and uses the default, or null when it uses it. Never said of a secret, whose value is not reported. */
  invalid: string | null;
}

const MASK = '••••';

/**
 * `url` with its credentials as '••••': its userinfo and every query value,
 * where a compatible API may take a key. Its host and path stay, to say where
 * it points. The same as the worker reports it (env.ts), and the same again
 * on a URL already masked.
 */
function maskedUrl(url: string): string {
  const q = url.indexOf('?');
  // Up to the last @ before the host ends, after the scheme and any slashes: the URL parser also reads userinfo in
  // `https:a:b@x`, `https:/a:b@x` and `https:\a:b@x`.
  const head = (q < 0 ? url : url.slice(0, q)).replace(/^([^:\/\\?#]*:[\/\\]*)[^\/\\?#]*@/, `$1${MASK}@`);
  if (q < 0) return head;
  const query = url.slice(q + 1).split('&').map((kv) => {
    const i = kv.indexOf('=');
    if (i < 0) return kv === '' ? kv : MASK;
    return kv.length > i + 1 ? `${kv.slice(0, i + 1)}${MASK}` : kv;
  });
  return `${head}?${query.join('&')}`;
}

/** An http(s) URL, or null. `new URL` alone accepts `eth.example:8545` as a URL with the scheme `eth.example:`. */
function urlOf(v: string): URL | null {
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

/** Every setting, in the order the page shows them. RPC is Ethereum only here: other chains are set in the environment. */
export const FIELDS: readonly Field[] = [
  {
    key: 'rpc.1',
    label: 'Ethereum RPC URL',
    secret: true,
    // http too, for a node on the local network. Not wss: the worker reads over HTTP.
    validate: (v) => {
      if (!['https:', 'http:'].includes(urlOf(v)?.protocol ?? '')) return 'An RPC URL starts with https:// (or http:// for a node on your network).';
      // Pasted back as shown, the URL would lose the key the mask stands for.
      return v.includes(MASK) ? `Type the whole URL: ${MASK} stands for a part that is kept hidden.` : null;
    },
    used: () => true,
  },
  {
    key: 'etherscan.key',
    label: 'Etherscan API key',
    secret: true,
    validate: (v) => (/^[A-Za-z0-9]+$/.test(v) ? null : 'An Etherscan key is letters and digits only, as etherscan.io/myapikey shows it.'),
    used: () => true,
  },
  {
    key: 'etherscan.rps',
    label: 'Etherscan calls per second',
    secret: false,
    validate: (v) => (v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? null : 'Calls per second must be a number above 0, such as 4.'),
    used: (v) => Number.isFinite(Number(v)) && Number(v) > 0,
    fallback: '4',
  },
  {
    key: 'etherscan.url',
    label: 'Etherscan API URL',
    secret: false,
    validate: (v) => {
      if (urlOf(v)?.protocol !== 'https:') return 'The Etherscan URL starts with https://.';
      // Saved as shown, the URL would lose the key the mask stands for.
      return v.includes(MASK) ? `Type the whole URL: ${MASK} stands for a part that is kept hidden.` : null;
    },
    // The worker takes any value here; a bad one shows when Etherscan is tested.
    used: () => true,
    fallback: 'https://api.etherscan.io/v2/api',
    show: maskedUrl,
  },
  {
    key: 'follow.hops',
    label: 'Follow hops',
    secret: false,
    validate: (v) => (/^\d+$/.test(v) && Number(v) <= 10 ? null : 'Follow hops must be a whole number from 0 to 10.'),
    // hops() in env.ts: '5.0' and '1e1' pass; outside 0–10 the worker uses 3.
    used: (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10,
    fallback: '3',
  },
  {
    key: 'stored.repo',
    label: 'Stored data dataset',
    secret: false,
    validate: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v) ? null : 'The dataset is a Hugging Face owner/name, such as jonathanmiro97/washtrace-data.'),
    // The worker takes any value here; a wrong one shows as no stored data found.
    used: () => true,
    fallback: 'jonathanmiro97/washtrace-data',
  },
];

/**
 * A secret as the console may show it: '••••' plus its last 4 characters when
 * longer than 8, else '••••'. An http(s) RPC URL keeps its scheme and host
 * (`https://eth-mainnet.g.alchemy.com/••••A1B2`). The same rule as
 * shownSecret in the worker's env.ts, copied because this file takes no
 * runtime imports.
 */
export function shownSecret(key: string, value: string): string {
  if (value.length <= 8) return MASK;
  const tail = `${MASK}${value.slice(-4)}`;
  if (!key.startsWith('rpc.')) return tail;
  const u = urlOf(value);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? `${u.protocol}//${u.host}/${tail}` : tail;
}

/**
 * Why the console can't change `key`, whoever asks, or null. Only the
 * Etherscan URL is ever pinned: while the key comes from the environment and
 * none is saved here, the URL comes from the environment or the default only
 * (env.ts), so a console URL can't receive the environment's key. `sources`
 * is the worker's last report; `settings` is what the console saved, which
 * counts at once, before the worker's next report.
 */
export function pinned(key: string, sources: Record<string, SettingSource>, settings: ReadonlyMap<string, string>): string | null {
  if (key !== 'etherscan.url') return null;
  if (settings.get('etherscan.key')?.trim()) return null;
  return sources['etherscan.key']?.source === 'env' ? 'The Etherscan key comes from .env, so its URL can only come from .env too. Save an Etherscan key here to change the URL.' : null;
}

/**
 * Each field for the page. `settings` is what the console saved; `sources` is
 * what the worker last reported per key: the level it used, the value used
 * and what `.env` holds, each already masked by the worker. A console value
 * beats the environment's, and shows even before the worker's next report;
 * once cleared, the environment's `env` is what the worker will use. While a
 * field is pinned the worker ignores a saved value, so it isn't shown. A secret
 * is shown masked (shownSecret), and to someone who may not change it as
 * '••••' alone, whatever its source.
 */
export function view(settings: ReadonlyMap<string, string>, sources: Record<string, SettingSource>, writable: boolean): FieldView[] {
  return FIELDS.map((f) => {
    const reported = sources[f.key];
    const why = pinned(f.key, sources, settings);
    // A saved value the worker ignores while the field is pinned is not shown: what it uses is the environment's, or the default.
    const saved = (why === null && settings.get(f.key)?.trim()) || null;
    const source = saved !== null ? 'console' : reported?.source === 'env' || reported?.env != null ? 'env' : null;
    const envHolds = reported?.env ?? null;
    let shown: string | null = null;
    let env: string | null = envHolds;
    if (f.secret) {
      env = envHolds === null ? null : writable ? envHolds : MASK;
      if (source === 'console') shown = writable ? shownSecret(f.key, saved!) : MASK;
      else if (source === 'env') shown = writable ? envHolds ?? reported?.value ?? MASK : MASK;
    } else {
      shown = saved ?? envHolds;
      if (shown !== null && f.show) shown = f.show(shown);
      if (env !== null && f.show) env = f.show(env);
    }
    return {
      key: f.key,
      label: f.label,
      secret: f.secret,
      set: source !== null,
      shown,
      source,
      env,
      locked: !writable || why !== null,
      pinned: why,
      invalid: !f.secret && shown !== null && !f.used(shown) ? f.validate(shown) : null,
    };
  });
}

/** The 403 every settings write and Test answers to someone who may not change settings: anyone could otherwise change them, or spend the RPC quota. */
export const READ_ONLY = 'Settings can only be changed from this machine until basic auth is on: set WASHTRACE_USERNAME and WASHTRACE_PASSWORD.';

/** What the page says to someone who may change settings with no basic auth on: they can only be on this machine, but it is open to anyone there. */
export const OPEN = 'Anyone who can reach this console on this machine can change these. Set WASHTRACE_USERNAME and WASHTRACE_PASSWORD before putting it online.';

/** The variable that pins a setting in the worker's environment, as env.ts reads it: `rpc.1` is WASHTRACE_RPC_1. */
export function variableOf(key: string): string {
  return `WASHTRACE_${key.toUpperCase().replace('.', '_')}`;
}

/** What the console knows of the worker's sources: which chains it can read, whether funding is on, and the numbers it runs with (null: its default). Never a URL or the key. */
export interface SourcesConfig {
  chains: number[];
  funding: boolean;
  perSecond: number | null;
  followHops: number | null;
}

/**
 * The worker's sources as the console says them, from where the worker last
 * said each value came from (`sources`) and what the console saved
 * (`settings`). The API never reads its own environment for this: only the
 * worker's counts. A non-empty console RPC or key counts at once, so a fresh
 * save doesn't warn until the worker's next report. The numbers come from the
 * report alone, and only when the worker uses them; otherwise null.
 */
export function configFromSources(sources: Record<string, SettingSource>, settings: ReadonlyMap<string, string> = new Map()): SourcesConfig {
  const saved = (key: string) => Boolean(settings.get(key)?.trim());
  const chains = new Set([...Object.keys(sources), ...[...settings.keys()].filter(saved)].flatMap((k) => {
    const m = /^rpc\.(\d+)$/.exec(k);
    return m ? [Number(m[1])] : [];
  }));
  const reported = (key: string): number | null => {
    const v = sources[key]?.value;
    const f = FIELDS.find((x) => x.key === key)!;
    return v != null && f.used(v) ? Number(v) : null;
  };
  return {
    chains: [...chains].sort((a, b) => a - b),
    funding: sources['etherscan.key'] !== undefined || saved('etherscan.key'),
    perSecond: reported('etherscan.rps'),
    followHops: reported('follow.hops'),
  };
}

/** How many hops out the worker follows money: what it reported, or its default. What its funding lanes serve, so the backlog counts with it. */
export function hopsFollowed(config: SourcesConfig): number {
  return config.followHops ?? Number(FIELDS.find((f) => f.key === 'follow.hops')!.fallback);
}
