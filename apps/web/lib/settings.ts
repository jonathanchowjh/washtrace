import type { SettingSource } from '@washtrace/detect';

/**
 * The settings the console can change, how each is checked, and how each is
 * shown. The worker reads the same keys (workerConfig), with the environment
 * winning; this file only decides what the API accepts and what it answers.
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
}

/** A field as the API answers it: where its value came from and as much of it as may be shown. */
export interface FieldView {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
  /** A secret is '••••', plus its last 4 for someone who may change it; anything else is its value. */
  shown: string | null;
  source: 'env' | 'console' | null;
  /** True when this viewer can't change it: set by the environment, or basic auth is off. */
  locked: boolean;
  /** Why the worker ignores this value and uses the default, or null when it uses it. Never said of a secret, whose value is not reported. */
  invalid: string | null;
}

const MASK = '••••';

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
    validate: (v) => (['https:', 'http:'].includes(urlOf(v)?.protocol ?? '') ? null : 'An RPC URL starts with https:// (or http:// for a node on your network).'),
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
  },
  {
    key: 'etherscan.url',
    label: 'Etherscan API URL',
    secret: false,
    validate: (v) => (urlOf(v)?.protocol === 'https:' ? null : 'The Etherscan URL starts with https://.'),
    // The worker takes any value here; a bad one shows when Etherscan is tested.
    used: () => true,
  },
  {
    key: 'follow.hops',
    label: 'Follow hops',
    secret: false,
    validate: (v) => (/^\d+$/.test(v) && Number(v) <= 10 ? null : 'Follow hops must be a whole number from 0 to 10.'),
    // hops() in env.ts: '5.0' and '1e1' pass; outside 0–10 the worker uses 3.
    used: (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10,
  },
];

/**
 * Each field for the page. `settings` is what the console saved; `sources` is
 * where the worker last said each value came from. The environment wins, as
 * it does in the worker; a console value shows even before the worker's next
 * report. The API never reads the worker's environment, so a secret the
 * environment set is only known to be set, and shows no part of itself. A
 * console secret shows its last 4 only to someone who may change it, and only
 * when it is long enough that 4 characters are a small part of it.
 */
export function view(settings: ReadonlyMap<string, string>, sources: Record<string, SettingSource>, writable: boolean): FieldView[] {
  return FIELDS.map((f) => {
    const reported = sources[f.key];
    const saved = settings.get(f.key)?.trim() || null;
    const source = reported?.source === 'env' ? 'env' : saved !== null ? 'console' : null;
    let shown: string | null = null;
    if (f.secret && source !== null) {
      shown = writable && source === 'console' && saved !== null && saved.length > 8 ? MASK + saved.slice(-4) : MASK;
    } else if (!f.secret) {
      shown = source === 'env' ? (reported?.value ?? null) : saved;
    }
    return {
      key: f.key,
      label: f.label,
      secret: f.secret,
      set: source !== null,
      shown,
      source,
      locked: !writable || source === 'env',
      invalid: !f.secret && shown !== null && !f.used(shown) ? f.validate(shown) : null,
    };
  });
}

/** The 403 every settings write and Test answers while basic auth is off: anyone could otherwise change them, or spend the RPC quota. */
export const READ_ONLY = 'Settings are read-only until basic auth is on: set WASHTRACE_USERNAME and WASHTRACE_PASSWORD.';
