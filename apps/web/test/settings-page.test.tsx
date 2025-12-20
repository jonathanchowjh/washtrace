import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '@/components/settings';
import { READ_ONLY, type FieldView } from '@/lib/settings';

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
    { key: 'rpc.1', label: 'Ethereum RPC URL', secret: true, set: false, shown: null, source: null, locked, invalid: null },
    { key: 'etherscan.key', label: 'Etherscan API key', secret: true, set: false, shown: null, source: null, locked, invalid: null },
    { key: 'etherscan.rps', label: 'Etherscan calls per second', secret: false, set: false, shown: null, source: null, locked, invalid: null },
    { key: 'etherscan.url', label: 'Etherscan API URL', secret: false, set: false, shown: null, source: null, locked, invalid: null },
    { key: 'follow.hops', label: 'Follow hops', secret: false, set: false, shown: null, source: null, locked, invalid: null },
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
    expect(screen.getByText(READ_ONLY)).toBeTruthy();
    const controls = [...document.querySelectorAll('input, button')] as (HTMLInputElement | HTMLButtonElement)[];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c.disabled).toBe(true);
  });

  it('says why each Test is off', () => {
    render(<Settings writable={false} fields={fields(RPC_SET, true)} />);
    for (const b of screen.getAllByRole('button', { name: /^Test\b/ })) expect(b.getAttribute('title')).toBe(READ_ONLY);
  });

  it('shows no read-only line when writable', () => {
    render(<Settings writable fields={fields()} />);
    expect(screen.queryByText(READ_ONLY)).toBeNull();
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
  });

  it('gives each field an anchor by its key', () => {
    render(<Settings writable fields={fields()} />);
    for (const f of fields()) expect(box(f.key)).toBeTruthy();
  });

  it('says where each value came from', () => {
    render(<Settings writable fields={fields({
      'etherscan.key': { set: true, shown: '••••', source: 'env', locked: true },
      'follow.hops': { set: true, shown: '2', source: 'console' },
    })} />);
    expect(box('etherscan.key').textContent).toContain('Set by the environment (WASHTRACE_ETHERSCAN_KEY)');
    expect(box('follow.hops').textContent).toContain('Set here');
    expect(box('etherscan.rps').textContent).toContain('Not set');
  });

  it('locks a field the environment set', () => {
    render(<Settings writable fields={fields({ 'follow.hops': { set: true, shown: '5', source: 'env', locked: true } })} />);
    const input = box('follow.hops').querySelector('input')!;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('5');
    expect((box('follow.hops').querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect((box('etherscan.rps').querySelector('input') as HTMLInputElement).disabled).toBe(false);
  });

  it('says, as a fault, that the worker ignores an invalid value', () => {
    render(<Settings writable fields={fields({ 'follow.hops': { set: true, shown: '99', source: 'env', locked: true, invalid: 'Follow hops must be a whole number from 0 to 10.' } })} />);
    const said = screen.getByText(/^Ignored:/);
    expect(said.textContent).toBe('Ignored: Follow hops must be a whole number from 0 to 10. The worker uses 3.');
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
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Follow hops must be a whole number from 0 to 10.' }, 400)));
    render(<Settings writable fields={fields()} />);
    fireEvent.change(box('follow.hops').querySelector('input')!, { target: { value: '40' } });
    fireEvent.click(box('follow.hops').querySelector('button')!);
    await waitFor(() => expect(live('follow.hops').textContent).toContain('Follow hops must be a whole number from 0 to 10.'));
    expect(live('follow.hops').querySelector('.text-fault')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
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

  it('offers no Clear for a secret the environment set', () => {
    render(<Settings writable fields={fields({ 'rpc.1': { set: true, shown: '••••', source: 'env', locked: true } })} />);
    expect(screen.queryByRole('button', { name: /^Clear/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Replace Ethereum RPC URL' }) as HTMLButtonElement).disabled).toBe(true);
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
    for (const name of ['Replace Ethereum RPC URL', 'Test Ethereum RPC URL', 'Set Etherscan API key', 'Test Etherscan API key', 'Save Follow hops', 'Save Etherscan calls per second']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Clear Ethereum RPC URL…' })).toBeTruthy();
  });

  it('points every label at a real control, and names each field by its label', () => {
    render(<Settings writable fields={fields(RPC_SET)} />);
    for (const l of document.querySelectorAll('label[for]')) expect(document.getElementById(l.getAttribute('for')!)).toBeTruthy();
    expect(box('rpc.1').querySelector('label')).toBeNull();
    expect(screen.getByRole('group', { name: 'Ethereum RPC URL' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Follow hops' }) as HTMLInputElement).name).toBe('value');
  });

  it('describes each field and its input with its hint', () => {
    render(<Settings writable fields={fields()} />);
    const described = (el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');
    expect(described(screen.getByRole('group', { name: 'Ethereum RPC URL' }))).toContain("Where the worker reads Ethereum's blocks");
    expect(described(screen.getByRole('textbox', { name: 'Follow hops' }))).toContain('How many wallets out from the traders');
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
