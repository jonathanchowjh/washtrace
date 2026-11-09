import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maskedUrl as workerMaskedUrl, shownSecret as workerShownSecret, type SettingSource } from '@washtrace/detect';
import { LOCAL_ONLY } from '@/lib/auth';
import { FIELDS, configFromSources, maskedUrl, shownSecret, variableOf, fieldViews } from '@/lib/settings';

type Sources = Record<string, SettingSource & { reportedAt: number }>;
const fake = {
  values: new Map<string, string>(),
  reported: {} as Sources,
  settings: vi.fn(async () => fake.values),
  sources: vi.fn(async () => fake.reported),
  setSetting: vi.fn(async (_key: string, _value: string | null, _actor: string) => {}),
  requestCheck: vi.fn(async (_kind: string, _chainId: number | null) => 42),
  check: vi.fn(async (_id: number) => ({ finished: true, ok: true, detail: { finalized: 26_253_624 } }) as unknown),
  addCollection: vi.fn(async () => ({ id: 7, created: true })),
  collections: vi.fn(async () => [] as { id: number; trailImportedSha: string | null }[]),
  importedFunding: vi.fn(async (_id: number) => true),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
// handle() opts into dynamic rendering with connection(), which only works inside a Next request.
vi.mock('next/server', () => ({ connection: async () => {} }));

const settingsRoute = await import('@/app/api/settings/route');
const checkRoute = await import('@/app/api/settings/check/route');
const checkIdRoute = await import('@/app/api/settings/check/[id]/route');
const collectionsRoute = await import('@/app/api/collections/route');

const RPC = 'https://eth-mainnet.g.alchemy.com/v2/sEcReTkEyA1B2';
const PIN = 'The Etherscan key comes from .env, so its URL can only come from .env too. Save an Etherscan key here to change the URL.';
const MASKED_RPC = 'https://eth-mainnet.g.alchemy.com/••••A1B2';
const src = (source: 'env' | 'console', value: string | null, env: string | null = null): SettingSource & { reportedAt: number } => ({ source, value, env, reportedAt: 1 });
const field = (fields: ReturnType<typeof fieldViews>, key: string) => fields.find((f) => f.key === key)!;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api', { method: 'POST', body: JSON.stringify(body), headers: { host: 'washtrace.example.com', 'content-type': 'application/json', ...headers } });
const local = { host: 'localhost:8080' };
const get = (headers: Record<string, string> = {}) => new Request('http://x/api', { headers: { host: 'washtrace.example.com', ...headers } });
const auth = (on: boolean) => {
  vi.stubEnv('WASHTRACE_USERNAME', on ? 'ada' : '');
  vi.stubEnv('WASHTRACE_PASSWORD', on ? 'pw' : '');
};

beforeEach(() => {
  fake.values = new Map();
  fake.reported = {};
  vi.clearAllMocks();
  auth(true);
});
afterEach(() => vi.unstubAllEnvs());

describe('view', () => {
  it('shows a secret as dots and its last 4, never the value', () => {
    const fields = fieldViews(new Map([['rpc.1', RPC]]), { 'rpc.1': src('console', null) }, true);
    const rpc = field(fields, 'rpc.1');
    expect(rpc).toMatchObject({ set: true, shown: MASKED_RPC, source: 'console', locked: false, secret: true });
    expect(JSON.stringify(fields)).not.toContain('sEcReT');
  });

  it('shows no part of a secret to a read-only viewer', () => {
    const rpc = field(fieldViews(new Map([['rpc.1', RPC]]), {}, false), 'rpc.1');
    expect(rpc).toMatchObject({ set: true, shown: '••••', source: 'console' });
  });

  it('shows a secret the environment set as set, with no part of it', () => {
    const key = field(fieldViews(new Map(), { 'etherscan.key': src('env', '••••') }, true), 'etherscan.key');
    expect(key).toMatchObject({ set: true, shown: '••••', source: 'env', locked: false });
  });

  it('shows a field the environment set, unlocked, with what the environment holds', () => {
    const hops = field(fieldViews(new Map(), { 'follow.hops': src('env', '5', '5') }, true), 'follow.hops');
    expect(hops).toMatchObject({ set: true, shown: '5', source: 'env', env: '5', locked: false, invalid: null });
  });

  it("shows a console value over the environment's, and keeps the environment's for Reset", () => {
    const hops = field(fieldViews(new Map([['follow.hops', '2']]), { 'follow.hops': src('console', '2', '5') }, true), 'follow.hops');
    expect(hops).toMatchObject({ shown: '2', source: 'console', env: '5' });
  });

  it('shows a secret from the environment masked, as the worker reported it', () => {
    const sources = { 'rpc.1': src('env', MASKED_RPC, MASKED_RPC) };
    expect(field(fieldViews(new Map(), sources, true), 'rpc.1')).toMatchObject({ shown: MASKED_RPC, source: 'env', locked: false });
    expect(field(fieldViews(new Map(), sources, false), 'rpc.1')).toMatchObject({ shown: '••••', env: '••••' });
  });

  it("falls back to the environment's value the moment a console value is cleared, before the worker reports", () => {
    const rpc = field(fieldViews(new Map(), { 'rpc.1': src('console', MASKED_RPC, 'https://eth-mainnet.g.alchemy.com/••••ZZ99') }, true), 'rpc.1');
    expect(rpc).toMatchObject({ source: 'env', shown: 'https://eth-mainnet.g.alchemy.com/••••ZZ99' });
  });

  it('locks every field while read-only', () => {
    const fields = fieldViews(new Map([['follow.hops', '2']]), {}, false);
    expect(fields.map((f) => f.key)).toEqual(FIELDS.map((f) => f.key));
    expect(fields.every((f) => f.locked)).toBe(true);
  });

  it('says a field is not set when neither the console nor the environment set it', () => {
    expect(field(fieldViews(new Map(), {}, true), 'etherscan.rps')).toMatchObject({ set: false, shown: null, source: null, locked: false, invalid: null });
  });

  it('shows a console value even before the worker reports it', () => {
    expect(field(fieldViews(new Map([['etherscan.rps', '3']]), {}, true), 'etherscan.rps')).toMatchObject({ set: true, shown: '3', source: 'console' });
  });

  it('says why the worker ignores an invalid environment value', () => {
    const hops = field(fieldViews(new Map(), { 'follow.hops': src('env', '99', '99') }, true), 'follow.hops');
    expect(hops.invalid).toBe('Follow hops must be a whole number from 0 to 10.');
  });

  it('calls invalid only what the worker ignores, not what the console would refuse to save', () => {
    const env = (key: string, v: string) => field(fieldViews(new Map(), { [key]: src('env', v, v) }, true), key).invalid;
    expect(env('follow.hops', '5.0')).toBeNull();
    expect(env('follow.hops', '1e1')).toBeNull();
    expect(env('etherscan.url', 'http://x')).toBeNull();
    expect(env('etherscan.rps', '1e3')).toBeNull();
    expect(env('etherscan.rps', '0')).toBe('Calls per second must be a number above 0, such as 4.');
  });
});

describe('view, the Etherscan URL', () => {
  const PINNED = PIN;
  const envKey = { 'etherscan.key': src('env', '••••', '••••') };

  it('locks the URL, saying why, while the key is from the environment and none is saved', () => {
    const url = field(fieldViews(new Map(), envKey, true), 'etherscan.url');
    expect(url).toMatchObject({ locked: true, pinned: PINNED });
  });

  it('shows no saved URL the worker ignores while the URL is pinned', () => {
    const fields = fieldViews(new Map([['etherscan.url', 'https://attacker.example/api']]), { 'etherscan.key': src('env', '••••1234', '••••1234') }, true);
    expect(field(fields, 'etherscan.url')).toMatchObject({ locked: true, pinned: PINNED, source: null, shown: null });
    expect(JSON.stringify(fields)).not.toContain('attacker');
  });

  it('shows the environment URL in use while a saved one is ignored', () => {
    const sources = { 'etherscan.key': src('env', '••••1234', '••••1234'), 'etherscan.url': src('env', 'https://api.etherscan.io/v2/api', 'https://api.etherscan.io/v2/api') };
    const url = field(fieldViews(new Map([['etherscan.url', 'https://attacker.example/api']]), sources, true), 'etherscan.url');
    expect(url).toMatchObject({ source: 'env', shown: 'https://api.etherscan.io/v2/api' });
  });

  it('unlocks the URL as soon as a key is saved, whatever the report says', () => {
    const url = field(fieldViews(new Map([['etherscan.key', 'ABCD1234EFGH']]), envKey, true), 'etherscan.url');
    expect(url).toMatchObject({ locked: false, pinned: null });
  });

  it('unlocks the URL when the report says the key is from the console', () => {
    const url = field(fieldViews(new Map(), { 'etherscan.key': src('console', '••••', null) }, true), 'etherscan.url');
    expect(url).toMatchObject({ locked: false, pinned: null });
  });

  it('shows the environment URL, unlocked, when the environment set it beside a saved key', () => {
    const url = field(fieldViews(new Map([['etherscan.key', 'ABCD1234EFGH']]), { 'etherscan.url': src('env', 'https://proxy.example/api', 'https://proxy.example/api') }, true), 'etherscan.url');
    expect(url).toMatchObject({ set: true, shown: 'https://proxy.example/api', source: 'env', locked: false, pinned: null });
  });

  it('leaves the URL to the console while the key is from the console', () => {
    const url = field(fieldViews(new Map([['etherscan.url', 'https://proxy.example/api']]), { 'etherscan.key': src('console', '••••') }, true), 'etherscan.url');
    expect(url).toMatchObject({ set: true, shown: 'https://proxy.example/api', source: 'console', locked: false, pinned: null });
  });

  it('shows a URL with its credentials masked, wherever it came from', () => {
    const fromConsole = field(fieldViews(new Map([['etherscan.url', 'https://ada:pw5678@x/api?apikey=SECRET1234']]), {}, true), 'etherscan.url');
    expect(fromConsole.shown).toBe('https://••••@x/api?apikey=••••');
    for (const url of ['https:ada:pw5678@x/api', 'https:/ada:pw5678@x/api', 'https:\\ada:pw5678@x/api']) {
      expect(new URL(url).password).toBe('pw5678');
      const shown = field(fieldViews(new Map([['etherscan.url', url]]), {}, true), 'etherscan.url').shown!;
      expect(shown).not.toContain('pw5678');
      expect(shown).not.toContain('ada');
      expect(shown).toContain('••••@x/api');
    }
    // The worker masks it before reporting; masked again, it stays as it was.
    const fromEnv = field(fieldViews(new Map(), { 'etherscan.url': src('env', 'https://x/api?apikey=••••', 'https://x/api?apikey=••••') }, true), 'etherscan.url');
    expect(fromEnv.shown).toBe('https://x/api?apikey=••••');
  });
});

describe('configFromSources', () => {
  it('reads chains, funding and the numbers the worker reported', () => {
    const sources = { 'rpc.1': src('env', null), 'rpc.8453': src('env', null), 'etherscan.key': src('console', null), 'etherscan.rps': src('env', '2.5'), 'follow.hops': src('console', '5') };
    expect(configFromSources(sources)).toEqual({ chains: [1, 8453], funding: true, perSecond: 2.5, followHops: 5, tokensPayees: false });
  });

  it('says nothing is set when the worker reported nothing', () => {
    expect(configFromSources({})).toEqual({ chains: [], funding: false, perSecond: null, followHops: null, tokensPayees: false });
  });

  it('counts a console RPC and key saved before the worker reports them', () => {
    const settings = new Map([['rpc.1', RPC], ['etherscan.key', 'ABCD1234EFGH']]);
    expect(configFromSources({ 'rpc.10': src('env', null) }, settings)).toMatchObject({ chains: [1, 10], funding: true });
  });

  it('does not count a blank console setting', () => {
    expect(configFromSources({}, new Map([['rpc.1', '  '], ['etherscan.key', '']]))).toMatchObject({ chains: [], funding: false });
  });

  it('leaves out a number the worker ignores, so its default is meant', () => {
    expect(configFromSources({ 'etherscan.rps': src('env', '0'), 'follow.hops': src('env', '99') })).toMatchObject({ perSecond: null, followHops: null });
  });

  it('reads tokens.payees as on only when the worker reported on, never from a console save', () => {
    expect(configFromSources({ 'tokens.payees': src('console', 'on') }).tokensPayees).toBe(true);
    expect(configFromSources({ 'tokens.payees': src('env', 'off') }).tokensPayees).toBe(false);
    expect(configFromSources({ 'tokens.payees': src('env', 'yes') }).tokensPayees).toBe(false);
    expect(configFromSources({}, new Map([['tokens.payees', 'on']])).tokensPayees).toBe(false);
  });

  it('reads the numbers from the report only, as the worker uses what it reported', () => {
    expect(configFromSources({}, new Map([['follow.hops', '5']]))).toMatchObject({ followHops: null });
  });
});

describe('variableOf', () => {
  it('names the environment variable that pins each setting', () => {
    expect(FIELDS.map((f) => variableOf(f.key))).toEqual(['WASHTRACE_RPC_1', 'WASHTRACE_ETHERSCAN_KEY', 'WASHTRACE_ETHERSCAN_RPS', 'WASHTRACE_ETHERSCAN_URL', 'WASHTRACE_FOLLOW_HOPS', 'WASHTRACE_TOKENS_PAYEES', 'WASHTRACE_STORED_REPO']);
  });
});

describe('tokens.payees', () => {
  const payees = FIELDS.find((f) => f.key === 'tokens.payees')!;

  it('is a field next to follow.hops, off by default, that takes on or off only', () => {
    const keys = FIELDS.map((f) => f.key);
    expect(keys.indexOf('tokens.payees')).toBe(keys.indexOf('follow.hops') + 1);
    expect(payees).toMatchObject({ label: 'Read tokens of wallets paid in tokens', secret: false, fallback: 'off' });
    expect(payees.validate('on')).toBeNull();
    expect(payees.validate('off')).toBeNull();
    for (const v of ['ON', 'true', '1', 'yes', '']) expect(payees.validate(v)).toBe('Read tokens of wallets paid in tokens is on or off.');
  });

  it('calls a value the worker reads as off, but is not off, invalid', () => {
    expect(payees.used('on')).toBe(true);
    expect(payees.used('off')).toBe(true);
    expect(payees.used('ON')).toBe(false);
    expect(field(fieldViews(new Map(), { 'tokens.payees': src('env', 'yes', 'yes') }, true), 'tokens.payees').invalid).toBe('Read tokens of wallets paid in tokens is on or off.');
  });
});

describe('stored.repo', () => {
  it('stored.repo is a field, validated as owner/name', () => {
    const f = FIELDS.find((x) => x.key === 'stored.repo')!;
    expect(f.secret).toBe(false);
    expect(f.validate('jonathanmiro97/washtrace-data')).toBeNull();
    expect(f.validate('a.b/c_d-e')).toBeNull();
    for (const bad of ['', 'nodash', 'a/b/c', 'a b/c', '/c', 'a/']) expect(f.validate(bad)).toMatch(/owner\/name/);
  });
});

describe('validators', () => {
  const check = (key: string, v: string) => FIELDS.find((f) => f.key === key)!.validate(v);

  it.each([
    ['rpc.1', 'https://eth.example/v2/k', null],
    ['rpc.1', 'http://192.168.1.5:8545', null],
    ['rpc.1', 'wss://eth.example/ws', 'An RPC URL starts with https:// (or http:// for a node on your network).'],
    ['rpc.1', 'eth.example', 'An RPC URL starts with https:// (or http:// for a node on your network).'],
    ['rpc.1', 'https://eth-mainnet.g.alchemy.com/••••A1B2', 'Type the whole URL: •••• stands for a part that is kept hidden.'],
    ['etherscan.key', 'ABCD1234EFGH5678', null],
    ['etherscan.key', 'has space', 'An Etherscan key is letters and digits only, as etherscan.io/myapikey shows it.'],
    ['etherscan.key', '', 'An Etherscan key is letters and digits only, as etherscan.io/myapikey shows it.'],
    ['etherscan.rps', '4', null],
    ['etherscan.rps', '0.5', null],
    ['etherscan.rps', '0', 'Calls per second must be a number above 0, such as 4.'],
    ['etherscan.rps', 'fast', 'Calls per second must be a number above 0, such as 4.'],
    ['etherscan.url', 'https://api.etherscan.io/v2/api', null],
    ['etherscan.url', 'http://api.etherscan.io/v2/api', 'The Etherscan URL starts with https://.'],
    ['follow.hops', '0', null],
    ['follow.hops', '10', null],
    ['follow.hops', '11', 'Follow hops must be a whole number from 0 to 10.'],
    ['follow.hops', '2.5', 'Follow hops must be a whole number from 0 to 10.'],
    ['follow.hops', '-1', 'Follow hops must be a whole number from 0 to 10.'],
  ])('%s %j → %j', (key, v, expected) => {
    expect(check(key, v)).toBe(expected);
  });
});

describe('GET /api/settings', () => {
  it('answers writable and the fields, with no secret in it', async () => {
    fake.values = new Map([['rpc.1', RPC], ['etherscan.url', 'https://api.etherscan.io/v2/api']]);
    fake.reported = { 'rpc.1': src('console', null) };
    const res = await settingsRoute.GET(get());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).writable).toBe(true);
    expect(text).not.toContain('sEcReT');
    expect(JSON.parse(text).fields.find((f: { key: string }) => f.key === 'rpc.1').shown).toMatch(/^https:\/\/eth-mainnet\.g\.alchemy\.com\//);
    // No collection loaded a money trail: no key means the money lenses are off.
    expect(JSON.parse(text).trailFunded).toBe(false);
  });

  it('answers no credential of the Etherscan URL', async () => {
    fake.values = new Map([['etherscan.url', 'https://x/api?apikey=SECRET1234']]);
    expect(await (await settingsRoute.GET(get())).text()).not.toContain('SECRET');
  });

  it('says when a loaded money trail feeds the money lenses without a key', async () => {
    fake.collections.mockResolvedValueOnce([{ id: 3, trailImportedSha: null }, { id: 4, trailImportedSha: 'feed' }]);
    const body = await (await settingsRoute.GET(get())).json();
    expect(body.trailFunded).toBe(true);
    expect(fake.importedFunding).toHaveBeenCalledWith(4);
    expect(fake.importedFunding).not.toHaveBeenCalledWith(3);
  });

  it('is not writable from another host while basic auth is off', async () => {
    auth(false);
    fake.values = new Map([['rpc.1', RPC]]);
    const body = await (await settingsRoute.GET(get())).json();
    expect(body).toMatchObject({ writable: false, open: false });
    expect(body.fields.find((f: { key: string }) => f.key === 'rpc.1').shown).toBe('••••');
  });

  it('is writable and open from this machine while basic auth is off', async () => {
    auth(false);
    expect(await (await settingsRoute.GET(get(local))).json()).toMatchObject({ writable: true, open: true });
  });

  it('is writable, and not open, with basic auth on, from anywhere', async () => {
    expect(await (await settingsRoute.GET(get())).json()).toMatchObject({ writable: true, open: false });
  });
});

describe('POST /api/settings', () => {
  it('saves a value with the signed-in user as actor', async () => {
    const res = await settingsRoute.POST(post({ key: 'follow.hops', value: ' 4 ' }, { 'x-washtrace-user': 'ada' }));
    expect(res.status).toBe(200);
    expect(fake.setSetting).toHaveBeenCalledWith('follow.hops', '4', 'ada');
  });

  it('says console when no user is named', async () => {
    await settingsRoute.POST(post({ key: 'rpc.1', value: RPC }));
    expect(fake.setSetting).toHaveBeenCalledWith('rpc.1', RPC, 'anonymous');
  });

  it('deletes with a null value', async () => {
    await settingsRoute.POST(post({ key: 'etherscan.key', value: null }));
    expect(fake.setSetting).toHaveBeenCalledWith('etherscan.key', null, 'anonymous');
  });

  it('answers a saved secret without its value', async () => {
    const res = await settingsRoute.POST(post({ key: 'rpc.1', value: RPC }));
    expect(await res.text()).not.toContain('sEcReT');
  });

  it('saves from this machine while basic auth is off', async () => {
    auth(false);
    expect((await settingsRoute.POST(post({ key: 'follow.hops', value: '4' }, local))).status).toBe(200);
    expect(fake.setSetting).toHaveBeenCalledWith('follow.hops', '4', 'anonymous');
  });

  it('403s from another host while basic auth is off, before anything else', async () => {
    auth(false);
    fake.reported = { 'follow.hops': src('env', '3') };
    const res = await settingsRoute.POST(post({ key: 'follow.hops', value: 'many' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(LOCAL_ONLY);
    expect(fake.setSetting).not.toHaveBeenCalled();
  });

  it('saves over a field the environment set', async () => {
    fake.reported = { 'follow.hops': src('env', '3', '3') };
    expect((await settingsRoute.POST(post({ key: 'follow.hops', value: '4' }))).status).toBe(200);
    expect(fake.setSetting).toHaveBeenCalledWith('follow.hops', '4', 'anonymous');
  });

  it('409s the Etherscan URL while the key is from the environment, saying why', async () => {
    fake.reported = { 'etherscan.key': src('env', '••••', '••••') };
    const res = await settingsRoute.POST(post({ key: 'etherscan.url', value: 'https://attacker.example/api' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(PIN);
    expect(fake.setSetting).not.toHaveBeenCalled();
  });

  it('lets a pinned Etherscan URL be cleared', async () => {
    fake.reported = { 'etherscan.key': src('env', '••••', '••••') };
    expect((await settingsRoute.POST(post({ key: 'etherscan.url', value: null }))).status).toBe(200);
    expect(fake.setSetting).toHaveBeenCalledWith('etherscan.url', null, 'anonymous');
  });

  it('400s a URL still holding the mask it was shown with', async () => {
    const res = await settingsRoute.POST(post({ key: 'etherscan.url', value: 'https://x/api?apikey=••••' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Type the whole URL: •••• stands for a part that is kept hidden.');
    expect(fake.setSetting).not.toHaveBeenCalled();
  });

  it("400s with the validator's message", async () => {
    const res = await settingsRoute.POST(post({ key: 'rpc.1', value: 'wss://eth.example/ws' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('An RPC URL starts with https:// (or http:// for a node on your network).');
    expect(fake.setSetting).not.toHaveBeenCalled();
  });

  it('400s an unknown key or a value that is not a string', async () => {
    expect((await settingsRoute.POST(post({ key: 'rpc.999', value: RPC }))).status).toBe(400);
    expect((await settingsRoute.POST(post({ key: 'follow.hops', value: 4 }))).status).toBe(400);
    expect(fake.setSetting).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/check', () => {
  it('asks the worker to test an RPC and answers its id', async () => {
    const res = await checkRoute.POST(post({ kind: 'rpc', chainId: 1 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 42 });
    expect(fake.requestCheck).toHaveBeenCalledWith('rpc', 1);
  });

  it('asks for an Etherscan test with no chain', async () => {
    await checkRoute.POST(post({ kind: 'etherscan' }));
    expect(fake.requestCheck).toHaveBeenCalledWith('etherscan', null);
  });

  it.each([
    [{ kind: 'dns' }],
    [{ kind: 'rpc' }],
    [{ kind: 'rpc', chainId: '1' }],
    [{ kind: 'rpc', chainId: 999 }],
    [{ kind: 'rpc', chainId: 1.5 }],
  ])('400s %j', async (body) => {
    expect((await checkRoute.POST(post(body))).status).toBe(400);
    expect(fake.requestCheck).not.toHaveBeenCalled();
  });

  it('403s from another host while basic auth is off', async () => {
    auth(false);
    const res = await checkRoute.POST(post({ kind: 'rpc', chainId: 1 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(LOCAL_ONLY);
    expect(fake.requestCheck).not.toHaveBeenCalled();
  });
});

describe('GET /api/settings/check/[id]', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  it('answers the check as the store has it', async () => {
    const res = await checkIdRoute.GET(get(), ctx('42'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ finished: true, ok: true, detail: { finalized: 26_253_624 } });
    expect(fake.check).toHaveBeenCalledWith(42);
  });

  it('404s an unknown or malformed id', async () => {
    fake.check.mockResolvedValueOnce(null);
    expect((await checkIdRoute.GET(get(), ctx('43'))).status).toBe(404);
    expect((await checkIdRoute.GET(get(), ctx('abc'))).status).toBe(404);
  });

  it('403s while basic auth is off', async () => {
    auth(false);
    const res = await checkIdRoute.GET(get(), ctx('42'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(LOCAL_ONLY);
    expect(fake.check).not.toHaveBeenCalled();
  });
});

describe('POST /api/collections, the no-RPC warning', () => {
  const watch = () => collectionsRoute.POST(post({ chainId: 1, address: '0x' + 'ab'.repeat(20) }, local));

  it('warns when the worker reports no RPC for the chain, whatever the API\'s own environment says', async () => {
    vi.stubEnv('WASHTRACE_RPC_1', RPC);
    expect((await (await watch()).json()).warning).toContain('No RPC is configured for chain 1');
  });

  it('the no-RPC warning says stored data is still read', async () => {
    const warning = (await (await watch()).json()).warning;
    expect(warning).toContain('No RPC is configured for chain 1, so only its stored data, if it has any, is read.');
    expect(warning).not.toMatch(/nothing will be read/);
  });

  it('does not warn when the worker reports an RPC for the chain', async () => {
    fake.reported = { 'rpc.1': src('console', null) };
    expect((await (await watch()).json()).warning).toBeUndefined();
  });

  it('does not warn for an RPC saved in the console before the worker reports it', async () => {
    fake.values = new Map([['rpc.1', RPC]]);
    expect((await (await watch()).json()).warning).toBeUndefined();
  });

  it('warns when the console setting is blank', async () => {
    fake.values = new Map([['rpc.1', '  ']]);
    expect((await (await watch()).json()).warning).toContain('No RPC is configured for chain 1');
  });
});

describe('shownSecret', () => {
  // The console's copy and the worker's (env.ts) must mask alike, or a value shows differently on the two sides.
  it.each([
    ['rpc.1', 'short'],
    ['etherscan.key', 'ABCD1234EFGH5678'],
    ['rpc.1', 'https://eth-mainnet.g.alchemy.com/v2/sEcReTkEyA1B2'],
    ['rpc.1', 'https://user:pass@eth.example:8545/v2/KEY0123456789'],
    ['rpc.1', 'wss://eth.example/ws/KEY0123456789'],
    ['rpc.1', 'not a url at all, long enough'],
  ])('%s %j is masked the same by both', (key, value) => {
    expect(shownSecret(key, value)).toBe(workerShownSecret(key, value));
  });
});

describe('maskedUrl', () => {
  // The same drift check as shownSecret: the console masks the Etherscan URL itself, and must match what the worker reports.
  it.each([
    'https://api.etherscan.io/v2/api',
    'https://user:pass@api.example/v2/api',
    'https:/a:b@api.example/v2/api',
    'https://api.example/v2/api?apikey=KEY0123456789',
    'https://api.example/v2/api?chainid=1&apikey=KEY0123456789&module=account&flag&empty=',
    'https://user:pass@api.example/api?apikey=KEY0123456789&x=1',
    'https://api.example/v2/api?apikey=••••',
    'not a url',
  ])('%j is masked the same by both', (url) => {
    expect(maskedUrl(url)).toBe(workerMaskedUrl(url));
  });
});
