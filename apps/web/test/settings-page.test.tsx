import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '@/components/settings';
import { LOCAL_ONLY } from '@/lib/auth';
import { OPEN, type FieldView } from '@/lib/settings';
import { withoutKey } from '@/lib/format';
import { FOLLOW_FANOUT } from '@washtrace/detect/lens-rule';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Every field as the API answers it with nothing set; `more` overrides by key. */
function fields(more: Record<string, Partial<FieldView>> = {}, locked = false): FieldView[] {
  const base: FieldView[] = [
    { key: 'rpc.1', label: 'Ethereum RPC URL', secret: true, set: false, shown: null, source: null, env: null, locked, pinned: null, invalid: null },
    { key: 'etherscan.key', label: 'Etherscan API key', secret: true, set: false, shown: null, source: null, env: null, locked, pinned: null, invalid: null },
    { key: 'etherscan.rps', label: 'Etherscan calls per second', secret: false, set: false, shown: null, source: null, env: null, locked, pinned: null, invalid: null },
    { key: 'etherscan.url', label: 'Etherscan API URL', secret: false, set: false, shown: null, source: null, env: null, locked, pinned: null, invalid: null },
    { key: 'follow.hops', label: 'Follow money (wallets out)', secret: false, set: false, shown: null, source: null, env: null, locked, pinned: null, invalid: null },
  ];
  return base.map((f) => ({ ...f, ...more[f.key] }));
}

const box = (key: string) => document.getElementById(key)!;
/** The field's one live region, always there so a screen reader announces what lands in it. */
const live = (key: string) => box(key).querySelector('[role=status]')!;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const RPC_SET = { 'rpc.1': { set: true, shown: '••••a1b2', source: 'console' as const } };

/** A fetch that answers the check request with id 7, then each poll with the next of `polls` (the last repeats). */
function checks(polls: unknown[]) {
  let i = 0;
  return vi.fn(async (url: string) => {
    if (url === '/api/settings/check') return json({ id: 7 }, 201);
    return json(polls[Math.min(i++, polls.length - 1)]);
  });
}

describe('Settings, read-only', () => {
  it('says why in one line at the top, and disables every input and button', () => {
    render(<Settings writable={false} fields={fields({ ...RPC_SET, 'follow.hops': { set: true, shown: '3', source: 'console' } }, true)} />);
    expect(screen.getByText(LOCAL_ONLY)).toBeTruthy();
    const controls = [...document.querySelectorAll('input, button')] as (HTMLInputElement | HTMLButtonElement)[];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c.disabled).toBe(true);
  });

  it('leaves a number field empty when unset: its hint says what the worker uses, so no placeholder repeats it', () => {
    render(<Settings writable fields={fields()} />);
    expect(box('etherscan.rps').querySelector('input')!.hasAttribute('placeholder')).toBe(false);
    expect(box('etherscan.rps').textContent).toContain('so the worker uses');
  });

  it('says why each Test is off', () => {
    render(<Settings writable={false} fields={fields(RPC_SET, true)} />);
    for (const b of screen.getAllByRole('button', { name: /^Test\b/ })) expect(b.getAttribute('title')).toBe(LOCAL_ONLY);
  });

  it('shows no read-only line when writable', () => {
    render(<Settings writable fields={fields()} />);
    expect(screen.queryByText(LOCAL_ONLY)).toBeNull();
  });
});

describe('Settings, each field', () => {
  it('says what the worker uses each field for', () => {
    render(<Settings writable fields={fields()} />);
    expect(box('rpc.1').textContent).toContain("Where the worker reads Ethereum's blocks and transfers");
    expect(box('etherscan.key').textContent).toContain('Lets the worker see who paid whom, for the money lenses');
    expect(box('etherscan.key').textContent).toMatch(/Money loops back.*Linked wallets/);
    expect(box('etherscan.key').textContent).not.toMatch(/\bSCC\b|\bAU\b|\bAC\b/);
    for (const key of ['etherscan.rps', 'etherscan.url', 'follow.hops']) expect(box(key).querySelector('[data-hint]')?.textContent?.length).toBeGreaterThan(20);
    expect(box('follow.hops').textContent).not.toMatch(/\bhops?\b/i);
  });

  it('says what tokens.payees is for, what it costs and when a payee is not read, with the fan-out the worker follows by', () => {
    const payees: FieldView = { key: 'tokens.payees', label: 'Read tokens of wallets paid in tokens', secret: false, set: false, shown: null, source: null, env: null, locked: false, pinned: null, invalid: null };
    render(<Settings writable fields={[...fields(), payees]} />);
    expect(box('tokens.payees').querySelector('[data-hint]')?.textContent).toBe(
      `On, reading other tokens also reads the tokens of wallets your traders paid in the listed tokens, so a one-wallet token loop can be seen; up to ${FOLLOW_FANOUT} more reads per trader. `
      + `Not read: the payees of a trader that paid over ${FOLLOW_FANOUT} others or whose list was too long to read, and any marketplace, custodian, wrapped token or other contract washtrace knows, or the zero address.`);
  });

  it('says what follow.reread is for, what it costs and how to turn it off', () => {
    const reread: FieldView = { key: 'follow.reread', label: 'Read traders again (days)', secret: false, set: false, shown: null, source: null, env: null, locked: false, pinned: null, invalid: null };
    render(<Settings writable fields={[...fields(), reread]} />);
    expect(box('follow.reread').querySelector('[data-hint]')?.textContent).toBe(
      "Read a trader's money and other tokens again when it trades, at most once every this many days. 0 is off. Each re-read is about 4 Etherscan calls, and the token read about 1 more. Turning it off stops new re-reads; any already due are read once.");
  });

  it('gives each field an anchor by its key', () => {
    render(<Settings writable fields={fields()} />);
    for (const f of fields()) expect(box(f.key)).toBeTruthy();
  });

  it('says where each value came from', () => {
    render(<Settings writable fields={fields({
      'etherscan.key': { set: true, shown: '••••', source: 'env', env: '••••' },
      'follow.hops': { set: true, shown: '2', source: 'console' },
    })} />);
    expect(box('etherscan.key').textContent).toContain('From .env (WASHTRACE_ETHERSCAN_KEY).');
    expect(box('follow.hops').textContent).toContain('Saved here.');
    expect(box('etherscan.rps').textContent).toContain('None: not saved here or in .env');
  });

  it('shows another chain\'s RPC under the chain\'s heading, read-only, with where it comes from and a Test', () => {
    const anvil: FieldView = {
      key: 'rpc.31337', label: 'Local (anvil) RPC URL', secret: true, set: true, shown: 'http://anvil:8545/••••8545', source: 'env', env: 'http://anvil:8545/••••8545',
      locked: true, pinned: "Only .env sets this chain's RPC: the console saves Ethereum's alone.", invalid: null,
    };
    render(<Settings writable fields={[...fields(), anvil]} />);
    expect(box('rpc.31337').closest('section')!.querySelector('h2')!.textContent).toBe('Where it reads the chain');
    expect(box('rpc.31337').textContent).toContain('http://anvil:8545/••••8545');
    expect(box('rpc.31337').textContent).toContain("Only .env sets this chain's RPC: the console saves Ethereum's alone. From .env (WASHTRACE_RPC_31337).");
    expect(box('rpc.31337').querySelector('[data-hint]')!.textContent).toBe('Where the worker reads the blocks and transfers of collections on Local (anvil). Shown as the worker reported it.');
    expect((screen.getByRole('button', { name: 'Replace Local (anvil) RPC URL' }) as HTMLButtonElement).disabled).toBe(true);
    // The worker tests the URL it reads, so a read-only one can be tested too.
    expect(box('rpc.31337').querySelector('button[data-test]')).not.toBeNull();
  });

  it('puts the stored data dataset under a heading of its own, not with who paid whom', () => {
    const repo: FieldView = { key: 'stored.repo', label: 'Stored data dataset', secret: false, set: false, shown: null, source: null, env: null, locked: false, pinned: null, invalid: null };
    render(<Settings writable fields={[...fields(), repo]} />);
    const section = box('stored.repo').closest('section')!;
    expect(section.id).toBe('stored');
    expect(section.querySelector('h2')!.textContent).toBe('Where it downloads stored data');
    expect(section.textContent).toContain('Download stored data, reading stage 1 (Download) for every collection');
    expect(box('etherscan.key').closest('section')!.querySelector('#stored\\.repo')).toBeNull();
    expect(box('stored.repo').querySelector('[data-hint]')!.textContent).toMatch(/^The Hugging Face dataset/);
  });

  it('shows a value from .env with where it came from, and lets it be replaced', () => {
    render(<Settings writable fields={fields({ 'rpc.1': { set: true, source: 'env', shown: 'https://x.example/••••a1b2', env: 'https://x.example/••••a1b2' } })} />);
    expect(box('rpc.1').textContent).toContain('https://x.example/••••a1b2');
    expect(box('rpc.1').textContent).toContain('From .env (WASHTRACE_RPC_1).');
    expect((screen.getByRole('button', { name: 'Replace Ethereum RPC URL' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /^Clear/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
  });

  it('offers Reset to .env value on a console value that .env also sets', async () => {
    const fetch = vi.fn(async () => json({ key: 'rpc.1', set: true }));
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields({ 'rpc.1': { set: true, source: 'console', shown: '••••c0de', env: '••••a1b2' } })} />);
    expect(box('rpc.1').textContent).toContain('Saved here, over .env (WASHTRACE_RPC_1).');
    expect(screen.queryByRole('button', { name: /^Clear/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Ethereum RPC URL to its .env value…' }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Ethereum RPC URL to its .env value' }));
    await waitFor(() => expect(live('rpc.1').textContent).toContain("Back to the .env value from the worker's next pass."));
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ key: 'rpc.1', value: null });
  });

  it('offers Reset to .env on a number .env also sets, and Clear when it does not', async () => {
    const fetch = vi.fn(async () => json({ key: 'follow.hops', set: true }));
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields({ 'follow.hops': { set: true, source: 'console', shown: '4', env: '2' } })} />);
    expect(box('follow.hops').querySelector<HTMLButtonElement>('button[type=submit]')!.title).toContain('.env value');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Follow money (wallets out) to its .env value…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset Follow money (wallets out) to its .env value' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ key: 'follow.hops', value: null });
    cleanup();
    render(<Settings writable fields={fields({ 'follow.hops': { source: 'console', shown: '4', env: null } })} />);
    expect(screen.getByRole('button', { name: 'Clear Follow money (wallets out)…' })).toBeTruthy();
  });

  it('offers Clear on a console value .env does not set', () => {
    render(<Settings writable fields={fields(RPC_SET)} />);
    expect(screen.getByRole('button', { name: 'Clear Ethereum RPC URL…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
  });

  it('says none for a source nothing sets', () => {
    render(<Settings writable fields={fields()} />);
    expect(box('rpc.1').textContent).toContain('None: not saved here or in .env, so the worker reads nothing from Ethereum.');
  });

  it('says the console is open when saving needs no login', () => {
    render(<Settings writable open fields={fields()} />);
    expect(screen.getByRole('note').textContent).toBe(OPEN);
  });

  it('says why it is read-only', () => {
    render(<Settings writable={false} fields={fields({}, true)} />);
    expect(screen.getByRole('note').textContent).toBe(LOCAL_ONLY);
  });

  it('locks the Etherscan URL while the key is from the environment, and says why and what the worker uses', () => {
    const why = 'The Etherscan key is set by the environment, so only the environment can change its URL.';
    render(<Settings writable fields={fields({
      'etherscan.key': { set: true, shown: '••••', source: 'env', env: '••••' },
      'etherscan.url': { locked: true, pinned: why },
    })} />);
    const input = box('etherscan.url').querySelector('input')!;
    expect(input.disabled).toBe(true);
    expect(input.title).toBe(why);
    expect((box('etherscan.url').querySelector('button') as HTMLButtonElement).title).toBe(why);
    expect(box('etherscan.url').textContent).toContain(`${why} Not set in .env (WASHTRACE_ETHERSCAN_URL), so the worker uses https://api.etherscan.io/v2/api.`);
  });

  it('says a pinned Etherscan URL is from .env when .env sets it', () => {
    const why = 'The Etherscan key is set by the environment, so only the environment can change its URL.';
    render(<Settings writable fields={fields({
      'etherscan.key': { set: true, shown: '••••', source: 'env', env: '••••' },
      'etherscan.url': { set: true, shown: 'https://scan.example/api', source: 'env', env: 'https://scan.example/api', locked: true, pinned: why },
    })} />);
    const text = box('etherscan.url').textContent!;
    expect(text).toContain(`${why} From .env (WASHTRACE_ETHERSCAN_URL).`);
    expect(text).not.toContain('Not set');
  });

  it('says, as a fault, that the worker ignores an invalid value', () => {
    render(<Settings writable fields={fields({ 'follow.hops': { set: true, shown: '99', source: 'env', env: '99', invalid: 'Follow money (wallets out) must be a whole number from 0 to 10.' } })} />);
    const said = screen.getByText(/^Ignored:/);
    expect(said.textContent).toBe('Ignored: Follow money (wallets out) must be a whole number from 0 to 10. The worker uses 3.');
    expect(said.closest('.text-fault')).toBeTruthy();
  });

  it('saves a value, then refreshes', async () => {
    const fetch = vi.fn(async () => json({ key: 'follow.hops', set: true }));
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields()} />);
    fireEvent.change(box('follow.hops').querySelector('input')!, { target: { value: '4' } });
    fireEvent.click(box('follow.hops').querySelector('button')!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/settings');
    expect(JSON.parse(String(init.body))).toEqual({ key: 'follow.hops', value: '4' });
  });

  it('says what the API refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Follow money (wallets out) must be a whole number from 0 to 10.' }, 400)));
    render(<Settings writable fields={fields()} />);
    fireEvent.change(box('follow.hops').querySelector('input')!, { target: { value: '40' } });
    fireEvent.click(box('follow.hops').querySelector('button')!);
    await waitFor(() => expect(live('follow.hops').textContent).toContain('Follow money (wallets out) must be a whole number from 0 to 10.'));
    expect(live('follow.hops').querySelector('.text-fault')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Settings, an on/off setting', () => {
  const payees = (more: Partial<FieldView> = {}): FieldView[] => [...fields(), { key: 'tokens.payees', label: 'Read tokens of wallets paid in tokens', secret: false, set: false, shown: null, source: null, env: null, locked: false, pinned: null, invalid: null, ...more }];
  const toggle = () => screen.getByRole('switch', { name: 'Read tokens of wallets paid in tokens' }) as HTMLInputElement;
  const sent = (fetch: ReturnType<typeof vi.fn>, i: number) => JSON.parse(String((fetch.mock.calls[i] as unknown as [string, RequestInit])[1].body));

  it('is a switch, off by default and on when the saved value is on, with no text box', () => {
    render(<Settings writable fields={payees()} />);
    expect(toggle().checked).toBe(false);
    expect(box('tokens.payees').querySelector('input:not([type=checkbox])')).toBeNull();
    cleanup();
    render(<Settings writable fields={payees({ set: true, shown: 'on', source: 'console' })} />);
    expect(toggle().checked).toBe(true);
  });

  it('saves on, then off, through the same save as every field, and refreshes', async () => {
    const fetch = vi.fn(async () => json({ key: 'tokens.payees', set: true }));
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={payees()} />);
    fireEvent.click(toggle());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('/api/settings');
    expect(sent(fetch, 0)).toEqual({ key: 'tokens.payees', value: 'on' });
    expect(toggle().checked).toBe(true);
    fireEvent.click(toggle());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(sent(fetch, 1)).toEqual({ key: 'tokens.payees', value: 'off' });
    expect(toggle().checked).toBe(false);
  });

  it('flips back and says why when the save is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Read tokens of wallets paid in tokens is on or off.' }, 400)));
    render(<Settings writable fields={payees()} />);
    fireEvent.click(toggle());
    await waitFor(() => expect(live('tokens.payees').textContent).toContain('is on or off.'));
    expect(toggle().checked).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('is disabled for a reader who may not write', () => {
    render(<Settings writable={false} fields={payees({ locked: true })} />);
    expect(toggle().disabled).toBe(true);
  });
});

describe('Settings, secrets', () => {
  it('shows a secret masked, and Replace opens an empty input', async () => {
    const fetch = vi.fn(async () => json({ key: 'rpc.1', set: true }));
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields(RPC_SET)} />);
    expect(box('rpc.1').textContent).toContain('••••a1b2');
    expect(box('rpc.1').querySelector('input')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace Ethereum RPC URL' }));
    const input = box('rpc.1').querySelector('input')!;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'https://eth.example/v2/new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Ethereum RPC URL' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ key: 'rpc.1', value: 'https://eth.example/v2/new' });
  });

  it('cancels a Replace without saving', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields(RPC_SET)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Replace Ethereum RPC URL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Ethereum RPC URL' }));
    expect(box('rpc.1').querySelector('input')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks inline before clearing, and clears on the second press only', async () => {
    const fetch = vi.fn(async () => json({ key: 'rpc.1', set: false }));
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields(RPC_SET)} />);
    fireEvent.click(screen.getByRole('button', { name: /^Clear/ }));
    expect(fetch).not.toHaveBeenCalled();
    expect(box('rpc.1').textContent).toMatch(/Clear the Ethereum RPC URL\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Ethereum RPC URL' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ key: 'rpc.1', value: null });
  });
});

describe('Settings, for a screen reader', () => {
  it('keeps one empty live region per field from the start', () => {
    render(<Settings writable fields={fields(RPC_SET)} />);
    for (const f of fields()) {
      expect(box(f.key).querySelectorAll('[role=status]')).toHaveLength(1);
      expect(live(f.key).textContent).toBe('');
    }
    expect(document.querySelector('[role=alert]')).toBeNull();
  });

  it('names each button with its field', () => {
    render(<Settings writable fields={fields({ ...RPC_SET, 'etherscan.key': { set: false } })} />);
    for (const name of ['Replace Ethereum RPC URL', 'Test Ethereum RPC URL', 'Set Etherscan API key', 'Test Etherscan API key', 'Save Follow money (wallets out)', 'Save Etherscan calls per second']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Clear Ethereum RPC URL…' })).toBeTruthy();
  });

  it('points every label at a real control, and names each field by its label', () => {
    render(<Settings writable fields={fields(RPC_SET)} />);
    for (const l of document.querySelectorAll('label[for]')) expect(document.getElementById(l.getAttribute('for')!)).toBeTruthy();
    expect(box('rpc.1').querySelector('label')).toBeNull();
    expect(screen.getByRole('group', { name: 'Ethereum RPC URL' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Follow money (wallets out)' }) as HTMLInputElement).name).toBe('value');
  });

  it('describes each field and its input with its hint', () => {
    render(<Settings writable fields={fields()} />);
    const described = (el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');
    expect(described(screen.getByRole('group', { name: 'Ethereum RPC URL' }))).toContain("Where the worker reads Ethereum's blocks");
    expect(described(screen.getByRole('textbox', { name: 'Follow money (wallets out)' }))).toContain('How many wallets out from the traders');
    expect(described(screen.getByRole('textbox', { name: 'Follow money (wallets out)' }))).toContain(
      'Lowering it stops reading wallets past the new limit, except on collections where a lens asked for more; a lens that needs them reads "at least".');
  });
});

describe('Settings, Test', () => {
  const testRpc = () => fireEvent.click(box('rpc.1').querySelector('button[data-test]')!);

  it('asks for an RPC check, polls, and shows each part when it finishes', async () => {
    vi.useFakeTimers();
    const fetch = checks([{ finished: false }, { finished: true, ok: true, detail: { finalized: 26_253_624, archive: true, logs: true } }]);
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields(RPC_SET)} />);
    testRpc();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(live('rpc.1').textContent).toBe('Finalized block 26,253,624 · Archive reads ✓ · 50,000-block log reads ✓');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/settings/check');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'rpc', chainId: 1 });
    expect(fetch.mock.calls.slice(1).map((c) => c[0])).toEqual(['/api/settings/check/7', '/api/settings/check/7']);
  });

  it('marks a part that failed, and says what that means', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', checks([{ finished: true, ok: true, detail: { finalized: 100, archive: false, logs: false } }]));
    render(<Settings writable fields={fields(RPC_SET)} />);
    testRpc();
    await act(() => vi.advanceTimersByTimeAsync(500));
    const text = live('rpc.1').textContent!;
    expect(text).toContain('Archive reads ✗');
    expect(text).toContain('50,000-block log reads ✗');
    expect(text).toMatch(/can't find a collection's first block/);
    expect(text).toMatch(/slower/);
  });

  it('says Etherscan answered', async () => {
    vi.useFakeTimers();
    const fetch = checks([{ finished: true, ok: true, detail: {} }]);
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields({ 'etherscan.key': { set: true, shown: '••••', source: 'console' } })} />);
    fireEvent.click(box('etherscan.key').querySelector('button[data-test]')!);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(live('etherscan.key').textContent).toBe('Etherscan answered ✓');
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ kind: 'etherscan' });
  });

  it("shows the worker's error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', checks([{ finished: true, ok: false, detail: { error: 'HTTP 401 from the RPC' } }]));
    render(<Settings writable fields={fields(RPC_SET)} />);
    testRpc();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(live('rpc.1').textContent).toContain('HTTP 401 from the RPC');
  });

  it('gives up after 20 s and points at the worker', async () => {
    vi.useFakeTimers();
    const fetch = checks([{ finished: false }]);
    vi.stubGlobal('fetch', fetch);
    render(<Settings writable fields={fields(RPC_SET)} />);
    testRpc();
    await act(() => vi.advanceTimersByTimeAsync(19_000));
    expect(live('rpc.1').textContent).toBe('');
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    const said = live('rpc.1');
    expect(said.textContent).toContain('No answer in 20 s. The worker runs tests: is it running? See Worker.');
    expect(said.querySelector('a')!.getAttribute('href')).toBe('/worker');
    const polls = fetch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(fetch.mock.calls.length).toBe(polls);
  });

  it('gives up after 20 s when the request itself never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<Settings writable fields={fields(RPC_SET)} />);
    testRpc();
    await act(() => vi.advanceTimersByTimeAsync(19_000));
    expect(screen.getByRole('button', { name: 'Test Ethereum RPC URL' }).textContent).toBe('Testing…');
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(live('rpc.1').textContent).toContain('The service did not answer in 20 s.');
    expect(screen.getByRole('button', { name: 'Test Ethereum RPC URL' }).textContent).toBe('Test');
  });

  it('gives up after 20 s when a poll hangs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/settings/check' ? Promise.resolve(json({ id: 7 }, 201)) : new Promise<Response>(() => {}))));
    render(<Settings writable fields={fields(RPC_SET)} />);
    testRpc();
    await act(() => vi.advanceTimersByTimeAsync(20_500));
    expect(live('rpc.1').textContent).toContain('No answer in 20 s. The worker runs tests: is it running? See Worker.');
    expect(screen.getByRole('button', { name: 'Test Ethereum RPC URL' }).textContent).toBe('Test');
  });

  it('stops polling when the page goes away', async () => {
    vi.useFakeTimers();
    const fetch = checks([{ finished: false }]);
    vi.stubGlobal('fetch', fetch);
    const { unmount } = render(<Settings writable fields={fields(RPC_SET)} />);
    testRpc();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const polls = fetch.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch.mock.calls.length).toBe(polls);
  });

  it('cannot test what is not set', () => {
    render(<Settings writable fields={fields()} />);
    const b = box('rpc.1').querySelector('button[data-test]') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('title')).toMatch(/nothing to test/i);
  });
});

describe('no Etherscan key, and a stored money trail', () => {
  it('says what no key means for the money lenses: off, or on stored money trails only', () => {
    expect(withoutKey(false)).toBe('Linked wallets and Money loops back do not run');
    expect(withoutKey(true)).toBe('Linked wallets and Money loops back run only on stored money trails, and newer wallets go unchecked');
  });

  it('never says the money lenses do not run while a loaded trail feeds them', () => {
    const text = render(<Settings fields={fields()} writable trailFunded />).container.textContent!;
    expect(text).not.toContain('do not run');
    expect(text).not.toContain('those lenses are off');
    expect(text).not.toContain('funding is off');
    expect(text).toContain('None: not saved here or in .env, so reading stage 5 (Money) needs a key: Linked wallets and Money loops back run only on stored money trails, and newer wallets go unchecked.');
  });

  it('names the stage each group feeds, and says a missing key needs one', () => {
    const text = render(<Settings fields={fields()} writable />).container.textContent!;
    expect(text).toContain("Read new transfers from the chain, reading stage 4 (Chain) for every collection, needs an RPC for each chain it reads. Without one, nothing newer is read.");
    expect(text).toContain("reading stage 5 (Money) for every collection, needs an Etherscan key.");
    expect(text).toContain('without a key they do not run.');
  });

  it('says they do not run when nothing feeds them', () => {
    const text = render(<Settings fields={fields()} writable />).container.textContent!;
    expect(text).toContain('None: not saved here or in .env, so reading stage 5 (Money) needs a key, and Linked wallets and Money loops back do not run.');
  });
});
