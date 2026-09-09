import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingSource } from '@washtrace/detect';
import { FIELDS, configFromSources, variableOf, view } from '@/lib/settings';

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
const READ_ONLY = 'Settings are read-only until basic auth is on: set WASHTRACE_USERNAME and WASHTRACE_PASSWORD.';
const src = (source: 'env' | 'console', value: string | null): SettingSource & { reportedAt: number } => ({ source, value, reportedAt: 1 });
const field = (fields: ReturnType<typeof view>, key: string) => fields.find((f) => f.key === key)!;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
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
    const fields = view(new Map([['rpc.1', RPC]]), { 'rpc.1': src('console', null) }, true);
    const rpc = field(fields, 'rpc.1');
    expect(rpc).toMatchObject({ set: true, shown: '••••A1B2', source: 'console', locked: false, secret: true });
    expect(JSON.stringify(fields)).not.toContain('sEcReT');
  });

  it('shows no part of a secret to a read-only viewer', () => {
    const rpc = field(view(new Map([['rpc.1', RPC]]), {}, false), 'rpc.1');
    expect(rpc).toMatchObject({ set: true, shown: '••••', source: 'console' });
  });

  it('shows a secret the environment set as set, with no part of it', () => {
    const key = field(view(new Map(), { 'etherscan.key': src('env', null) }, true), 'etherscan.key');
    expect(key).toMatchObject({ set: true, shown: '••••', source: 'env', locked: true });
  });

  it('locks a field the environment set, and shows its value when not secret', () => {
    const hops = field(view(new Map([['follow.hops', '2']]), { 'follow.hops': src('env', '5') }, true), 'follow.hops');
    expect(hops).toMatchObject({ set: true, shown: '5', source: 'env', locked: true, invalid: null });
  });

  it('locks every field while read-only', () => {
    const fields = view(new Map([['follow.hops', '2']]), {}, false);
    expect(fields.map((f) => f.key)).toEqual(FIELDS.map((f) => f.key));
    expect(fields.every((f) => f.locked)).toBe(true);
  });

  it('says a field is not set when neither the console nor the environment set it', () => {
    expect(field(view(new Map(), {}, true), 'etherscan.rps')).toMatchObject({ set: false, shown: null, source: null, locked: false, invalid: null });
  });

  it('shows a console value even before the worker reports it', () => {
    expect(field(view(new Map([['etherscan.rps', '3']]), {}, true), 'etherscan.rps')).toMatchObject({ set: true, shown: '3', source: 'console' });
  });

  it('says why the worker ignores an invalid environment value', () => {
    const hops = field(view(new Map(), { 'follow.hops': src('env', '99') }, true), 'follow.hops');
    expect(hops.invalid).toBe('Follow hops must be a whole number from 0 to 10.');
  });

  it('calls invalid only what the worker ignores, not what the console would refuse to save', () => {
    const env = (key: string, v: string) => field(view(new Map(), { [key]: src('env', v) }, true), key).invalid;
    expect(env('follow.hops', '5.0')).toBeNull();
    expect(env('follow.hops', '1e1')).toBeNull();
    expect(env('etherscan.url', 'http://x')).toBeNull();
    expect(env('etherscan.rps', '1e3')).toBeNull();
    expect(env('etherscan.rps', '0')).toBe('Calls per second must be a number above 0, such as 4.');
  });
});

describe('view, the Etherscan URL', () => {
  const PINNED = 'The Etherscan key is set by the environment, so only the environment can change its URL.';
  const envKey = { 'etherscan.key': src('env', null) };

  it('locks the URL, saying why, while the key is from the environment, and shows no console URL the worker ignores', () => {
    const url = field(view(new Map([['etherscan.url', 'https://attacker.example/api']]), envKey, true), 'etherscan.url');
    expect(url).toMatchObject({ set: false, shown: null, source: null, locked: true, pinned: PINNED, invalid: null });
  });

  it('shows the environment URL, locked, when the environment set it beside the key', () => {
    const url = field(view(new Map(), { ...envKey, 'etherscan.url': src('env', 'https://proxy.example/api') }, true), 'etherscan.url');
    expect(url).toMatchObject({ set: true, shown: 'https://proxy.example/api', source: 'env', locked: true, pinned: "Set by the environment, so it can't be changed here." });
  });

  it('leaves the URL to the console while the key is from the console', () => {
    const url = field(view(new Map([['etherscan.url', 'https://proxy.example/api']]), { 'etherscan.key': src('console', null) }, true), 'etherscan.url');
    expect(url).toMatchObject({ set: true, shown: 'https://proxy.example/api', source: 'console', locked: false, pinned: null });
  });

  it('shows a URL with its credentials masked, wherever it came from', () => {
    const fromConsole = field(view(new Map([['etherscan.url', 'https://ada:pw5678@x/api?apikey=SECRET1234']]), {}, true), 'etherscan.url');
    expect(fromConsole.shown).toBe('https://••••@x/api?apikey=••••');
    for (const url of ['https:ada:pw5678@x/api', 'https:/ada:pw5678@x/api', 'https:\\ada:pw5678@x/api']) {
      expect(new URL(url).password).toBe('pw5678');
      const shown = field(view(new Map([['etherscan.url', url]]), {}, true), 'etherscan.url').shown!;
      expect(shown).not.toContain('pw5678');
      expect(shown).not.toContain('ada');
      expect(shown).toContain('••••@x/api');
    }
    // The worker masks it before reporting; masked again, it stays as it was.
    const fromEnv = field(view(new Map(), { 'etherscan.url': src('env', 'https://x/api?apikey=••••') }, true), 'etherscan.url');
    expect(fromEnv.shown).toBe('https://x/api?apikey=••••');
  });
});

describe('configFromSources', () => {
  it('reads chains, funding and the numbers the worker reported', () => {
    const sources = { 'rpc.1': src('env', null), 'rpc.8453': src('env', null), 'etherscan.key': src('console', null), 'etherscan.rps': src('env', '2.5'), 'follow.hops': src('console', '5') };
    expect(configFromSources(sources)).toEqual({ chains: [1, 8453], funding: true, perSecond: 2.5, followHops: 5 });
  });

  it('says nothing is set when the worker reported nothing', () => {
    expect(configFromSources({})).toEqual({ chains: [], funding: false, perSecond: null, followHops: null });
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

  it('reads the numbers from the report only, as the worker uses what it reported', () => {
    expect(configFromSources({}, new Map([['follow.hops', '5']]))).toMatchObject({ followHops: null });
  });
});

describe('variableOf', () => {
  it('names the environment variable that pins each setting', () => {
    expect(FIELDS.map((f) => variableOf(f.key))).toEqual(['WASHTRACE_RPC_1', 'WASHTRACE_ETHERSCAN_KEY', 'WASHTRACE_ETHERSCAN_RPS', 'WASHTRACE_ETHERSCAN_URL', 'WASHTRACE_FOLLOW_HOPS', 'WASHTRACE_STORED_REPO']);
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
    const res = await settingsRoute.GET();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).writable).toBe(true);
    // The non-secret Etherscan URL may say https; take it out, then no https is left: no RPC URL leaked.
    expect(text.replace('https://api.etherscan.io/v2/api', '').match(/https/g)).toBeNull();
    expect(text).not.toContain('sEcReT');
    // No collection loaded a money trail: no key means the money lenses are off.
    expect(JSON.parse(text).trailFunded).toBe(false);
  });

  it('answers no credential of the Etherscan URL', async () => {
    fake.values = new Map([['etherscan.url', 'https://x/api?apikey=SECRET1234']]);
    expect(await (await settingsRoute.GET()).text()).not.toContain('SECRET');
  });

  it('says when a loaded money trail feeds the money lenses without a key', async () => {
    fake.collections.mockResolvedValueOnce([{ id: 3, trailImportedSha: null }, { id: 4, trailImportedSha: 'feed' }]);
    const body = await (await settingsRoute.GET()).json();
    expect(body.trailFunded).toBe(true);
    expect(fake.importedFunding).toHaveBeenCalledWith(4);
    expect(fake.importedFunding).not.toHaveBeenCalledWith(3);
  });

  it('is not writable while basic auth is off', async () => {
    auth(false);
    fake.values = new Map([['rpc.1', RPC]]);
    const body = await (await settingsRoute.GET()).json();
    expect(body.writable).toBe(false);
    expect(body.fields.find((f: { key: string }) => f.key === 'rpc.1').shown).toBe('••••');
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
    expect(fake.setSetting).toHaveBeenCalledWith('rpc.1', RPC, 'console');
  });

  it('deletes with a null value', async () => {
    await settingsRoute.POST(post({ key: 'etherscan.key', value: null }));
    expect(fake.setSetting).toHaveBeenCalledWith('etherscan.key', null, 'console');
  });

  it('answers a saved secret without its value', async () => {
    const res = await settingsRoute.POST(post({ key: 'rpc.1', value: RPC }));
    expect(await res.text()).not.toContain('sEcReT');
  });

  it('403s while basic auth is off, before anything else', async () => {
    auth(false);
    fake.reported = { 'follow.hops': src('env', '3') };
    const res = await settingsRoute.POST(post({ key: 'follow.hops', value: 'many' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(READ_ONLY);
    expect(fake.setSetting).not.toHaveBeenCalled();
  });

  it('409s a field the environment set, before validating', async () => {
    fake.reported = { 'follow.hops': src('env', '3') };
    const res = await settingsRoute.POST(post({ key: 'follow.hops', value: 'many' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Set by the environment, so it can't be changed here.");
    expect(fake.setSetting).not.toHaveBeenCalled();
  });

  it('409s clearing a field the environment set', async () => {
    fake.reported = { 'etherscan.key': src('env', null) };
    expect((await settingsRoute.POST(post({ key: 'etherscan.key', value: null }))).status).toBe(409);
  });

  it('409s the Etherscan URL while the key is from the environment, saying why', async () => {
    fake.reported = { 'etherscan.key': src('env', null) };
    for (const value of ['https://attacker.example/api', null]) {
      const res = await settingsRoute.POST(post({ key: 'etherscan.url', value }));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('The Etherscan key is set by the environment, so only the environment can change its URL.');
    }
    expect(fake.setSetting).not.toHaveBeenCalled();
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

  it('403s while basic auth is off', async () => {
    auth(false);
    const res = await checkRoute.POST(post({ kind: 'rpc', chainId: 1 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(READ_ONLY);
    expect(fake.requestCheck).not.toHaveBeenCalled();
  });
});

describe('GET /api/settings/check/[id]', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = () => new Request('http://x/api');

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
    expect((await res.json()).error).toBe(READ_ONLY);
    expect(fake.check).not.toHaveBeenCalled();
  });
});

describe('POST /api/collections, the no-RPC warning', () => {
  const watch = () => collectionsRoute.POST(post({ chainId: 1, address: '0x' + 'ab'.repeat(20) }));

  it('warns when the worker reports no RPC for the chain, whatever the API\'s own environment says', async () => {
    vi.stubEnv('WASHTRACE_RPC_1', RPC);
    expect((await (await watch()).json()).warning).toContain('No RPC is configured for chain 1');
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
