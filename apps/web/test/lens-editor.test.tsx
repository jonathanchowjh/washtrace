import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPIES, DEFAULT_RULE, type LensRule } from '@washtrace/detect/lens-rule';
import { send } from '@/components/lens-actions';
import { LensEditor } from '@/components/lens-editor';
import { LOCAL_ONLY } from '@/lib/auth';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const NEEDS = {
  transfers: 1200, transfersRead: true, funding: true, perSecond: 4, watched: 2, followHops: 3, fanout: 25, callsPerWallet: 4, behind: false, paused: false, tokens: { started: false, counts: null, payees: false, runTokensRead: null, symbols: 'USDC, USDT, DAI, APE' },
  money: { traders: { checked: 5, of: 5 }, limit: 3, ownLimit: null, pendingByDepth: {}, estimate: null, seeding: false },
};
const editor = (over: Partial<Parameters<typeof LensEditor>[0]> = {}) =>
  render(
    <LensEditor base={BASE} chainId={1} address={ADDR} selected="AC" title="New lens" name="" rule={DEFAULT_RULE} differs={null} writable notFinal={[]} funded needs={NEEDS} {...over} />,
  ).container;
const sent = (fetchMock: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, method: init.method, body: JSON.parse(init.body as string) };
};
const reply = (status: number, body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const button = (c: Element, name: string) => within(c as HTMLElement).getByRole('button', { name }) as HTMLButtonElement;
const type = (el: Element, value: string) => { fireEvent.change(el, { target: { value } }); fireEvent.blur(el); };

describe('the layout', () => {
  it('has the header chip, the intro, both sections, every column and row, and the two buttons', () => {
    const c = editor();
    const text = c.textContent!;
    expect(text).toContain('yours · editing');
    expect(text).toContain('Every loop starts with the trade: the NFT goes from seller → buyer. A lens says which edges may carry the way back to the seller, in which direction, and how much of each.');
    for (const s of ['1 · Edges that may close the loop', '2 · The loop as a whole', '3 · Data this lens needs']) expect(within(c).getByRole('heading', { name: s })).toBeTruthy();
    // The data section comes after the rule and before Preview, as in the mockup.
    const order = (s: string) => text.indexOf(s);
    expect(order('2 · The loop as a whole')).toBeLessThan(order('3 · Data this lens needs'));
    expect(order('3 · Data this lens needs')).toBeLessThan(order('Preview'));
    expect(within(c.querySelector('[aria-labelledby="rule-edges"]') as HTMLElement).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Use', 'Edge type', 'Direction in the loop', 'At most in a loop', 'Smallest that counts', 'Repeats between the same 2 wallets',
    ]);
    for (const row of ['Hops back to the seller', 'Loop closes at', 'Every edge happens within', 'Order in time', 'Never a middle wallet', 'Which trades it judges', 'At least N loops among the wallets involved']) {
      expect(within(c).getByText(row)).toBeTruthy();
    }
    expect(within(c).getByText('Name')).toBeTruthy();
    expect(within(c).getAllByRole('button').map((b) => b.textContent)).toEqual(['Preview', 'Cancel', 'Save and run']);
  });

  it('says what never.over counts: wallets linked to more than N of this collection\'s wallets (Ruling BB)', async () => {
    const c = editor({ name: 'Mine' });
    const over = within(c).getByLabelText("Wallets linked to more than this many of this collection's wallets are never passed through") as HTMLInputElement;
    expect(over.value).toBe('20');
    // The field sits between the two halves (the row's gap spaces them): "Wallets linked to more than [20] of this collection's wallets (exchanges, routers)".
    expect([...over.closest('label')!.childNodes].map((n) => (n === over ? '[20]' : n.textContent))).toEqual(['Wallets linked to more than', '[20]', 'of this collection’s wallets (exchanges, routers)']);
    expect(c.textContent).not.toContain('transfers read here');
    const fetchMock = reply(201, { lens: { id: 9, key: 'L9' } });
    vi.stubGlobal('fetch', fetchMock);
    type(over, '50');
    fireEvent.click(button(c, 'Save and run'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(fetchMock).body.rule.never.over).toBe(50);
  });

  it('disables the unavailable row and says why; Other tokens can be switched on', () => {
    const c = editor();
    expect((within(c).getByLabelText('Follow NFT: other watched collections') as HTMLInputElement).disabled).toBe(true);
    expect(c.textContent).toContain("Not in this version: a lens reads this collection's transfers.");
    expect((within(c).getByLabelText('Follow Other tokens') as HTMLInputElement).disabled).toBe(false);
  });

  it('the Other tokens row reads "Any amount: tokens differ in value" and takes no amount, while ETH keeps its field', () => {
    const c = editor();
    const row = within(c).getByLabelText('Follow Other tokens').closest('tr') as HTMLElement;
    expect(row.textContent).toContain('Any amount: tokens differ in value');
    expect(within(row).queryByLabelText(/smallest payment counted/)).toBeNull();
    expect(within(c).getByLabelText('ETH payment: smallest payment counted, in ETH')).toBeTruthy();
  });

  it('says that closing at a funder acts as the seller when the window is on the after side, and not otherwise', () => {
    const after: LensRule = { ...structuredClone(DEFAULT_RULE), closes: 'seller-or-funder', window: { days: 30, side: 'after' } };
    expect(editor({ rule: after }).textContent).toContain('no wallet counts as a funder');
    cleanup();
    // Closing at the seller already: the note would explain a funder the rule does not use.
    expect(editor({ rule: { ...after, closes: 'seller' } }).textContent).not.toContain('no wallet counts as a funder');
    cleanup();
    expect(editor().textContent).not.toContain('no wallet counts as a funder');
  });

  it('shows no lens key anywhere a reader or a screen reader sees', () => {
    const c = editor({ title: 'Copy of Money loops back', name: 'Money loops back (copy)', rule: COPIES.AU.rule, differs: COPIES.AU.differs, selected: 'AU' });
    const reads = [c.textContent, ...[...c.querySelectorAll('[aria-label],[title]')].flatMap((e) => [e.getAttribute('aria-label'), e.getAttribute('title')])].join('\n');
    expect(reads).not.toMatch(/\b(AU|AC|L\d+)\b/);
  });
});

describe('a copy of a built-in', () => {
  it('opens with its rule, its name and the sentence saying how it differs', () => {
    const c = editor({ title: 'Copy of Money loops back', name: 'Money loops back (copy)', rule: COPIES.AU.rule, differs: COPIES.AU.differs, selected: 'AU' });
    expect((within(c).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Money loops back (copy)');
    expect(c.textContent).toContain(COPIES.AU.differs!);
    expect((within(c).getByLabelText('Follow NFT: same token') as HTMLInputElement).checked).toBe(true);
    expect((within(c).getByLabelText('Follow ETH payment') as HTMLInputElement).checked).toBe(true);
    expect((within(c).getByLabelText('Follow ETH sent by a contract (internal)') as HTMLInputElement).checked).toBe(true);
    expect((within(c).getByLabelText('Most wallets between the seller and the buyer') as HTMLInputElement).value).toBe('6');
  });

  it('edits a copy, and leaves the shared copies and the default rule as they were', async () => {
    const before = structuredClone({ DEFAULT_RULE, COPIES });
    vi.stubGlobal('fetch', reply(201, { lens: { id: 9, key: 'L9' } }));
    const c = editor({ rule: COPIES.AU.rule, name: 'Mine', selected: 'AU' });
    fireEvent.click(within(c).getByLabelText('Follow ETH payment'));
    type(within(c).getByLabelText('Most wallets between the seller and the buyer'), '2');
    fireEvent.click(button(c, 'Save and run'));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(COPIES).toEqual(before.COPIES);
    expect(DEFAULT_RULE).toEqual(before.DEFAULT_RULE);
    cleanup();
    const d = editor();
    fireEvent.click(within(d).getByLabelText('Follow ETH payment'));
    type(within(d).getByLabelText('Days from the trade within which an edge counts'), '7');
    expect(DEFAULT_RULE).toEqual(before.DEFAULT_RULE);
  });
});

describe('Save and run', () => {
  it('posts the name, the rule and the collection, then opens the new lens\'s tab', async () => {
    const fetchMock = reply(201, { lens: { id: 9, key: 'L9', name: 'Mine' } });
    vi.stubGlobal('fetch', fetchMock);
    const c = editor({ name: '  Mine ' });
    type(within(c).getByLabelText('Days from the trade within which an edge counts'), '7');
    type(within(c).getByLabelText('ETH payment: smallest payment counted, in ETH'), '0.5');
    fireEvent.click(button(c, 'Save and run'));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`${BASE}?method=L9#evidence`));
    const { url, method, body } = sent(fetchMock);
    expect(url).toBe('/api/lenses');
    expect(method).toBe('POST');
    expect(body).toEqual({
      name: 'Mine', chainId: 1, address: ADDR,
      rule: { ...DEFAULT_RULE, window: { days: 7, side: 'either' }, edges: { ...DEFAULT_RULE.edges, eth: { ...DEFAULT_RULE.edges.eth, minWei: '500000000000000000' } } },
    });
    expect(refresh).toHaveBeenCalled();
  });

  it.each([[400, 'Hops: "from" is more than "to".'], [409, 'Another lens is already called "Blur 3-hop".']])('shows a %i in an alert and keeps the form', async (status, error) => {
    vi.stubGlobal('fetch', reply(status, { error }));
    const c = editor({ name: 'Blur 3-hop' });
    type(within(c).getByLabelText('Days from the trade within which an edge counts'), '9');
    fireEvent.click(button(c, 'Save and run'));
    const alert = await within(c).findByRole('alert');
    expect(alert.textContent).toBe(error);
    // The focus goes to what went wrong, not back to the page: a screen reader says it, and Tab goes on from there.
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(push).not.toHaveBeenCalled();
    expect((within(c).getByLabelText('Days from the trade within which an edge counts') as HTMLInputElement).value).toBe('9');
    expect(button(c, 'Save and run').disabled).toBe(false);
  });

  it('saves what is typed when Enter submits the form before the field loses focus', async () => {
    const fetchMock = reply(201, { lens: { id: 9, key: 'L9' } });
    vi.stubGlobal('fetch', fetchMock);
    const c = editor({ name: 'Mine' });
    const days = within(c).getByLabelText('Days from the trade within which an edge counts') as HTMLInputElement;
    days.focus();
    fireEvent.change(days, { target: { value: '7' } });
    fireEvent.submit(c.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent(fetchMock).body.rule.window).toEqual({ days: 7, side: 'either' });
  });

  it('says so when the service does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch'); }));
    const c = editor({ name: 'x' });
    fireEvent.click(button(c, 'Save and run'));
    expect((await within(c).findByRole('alert')).textContent).toBe('The service did not answer.');
  });

  it('checks the rule before posting, and shows the same error the server would', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const c = editor({ name: 'x' });
    type(within(c).getByLabelText('Fewest wallets between the seller and the buyer'), '4');
    type(within(c).getByLabelText('Most wallets between the seller and the buyer'), '2');
    fireEvent.click(button(c, 'Save and run'));
    expect((await within(c).findByRole('alert')).textContent).toBe('Hops: "from" is more than "to".');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses "any" hops with a fewest above 0 before posting', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const c = editor({ name: 'x', rule: COPIES.A.rule });
    type(within(c).getByLabelText('Fewest wallets between the seller and the buyer'), '1');
    fireEvent.click(button(c, 'Save and run'));
    expect((await within(c).findByRole('alert')).textContent).toBe('With "any" length, the fewest wallets between must be 0.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for a name, of at most 60 characters, before posting', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const c = editor({ name: '   ' });
    fireEvent.click(button(c, 'Save and run'));
    expect((await within(c).findByRole('alert')).textContent).toBe('Give the lens a name.');
    cleanup();
    const d = editor({ name: 'x'.repeat(61) });
    fireEvent.click(button(d, 'Save and run'));
    expect((await within(d).findByRole('alert')).textContent).toBe('A name is at most 60 characters.');
    cleanup();
    // The route's own rule, lens-rule's nameError: a tab in a name would break a tab, a chip and a CSV header.
    const e = editor({ name: 'Blur\t3-hop' });
    fireEvent.click(button(e, 'Save and run'));
    expect((await within(e).findByRole('alert')).textContent).toBe('A name cannot hold control characters.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('editing a lens', () => {
  it('patches it, then goes to the same tab', async () => {
    const fetchMock = reply(200, { lens: { id: 7, key: 'L7' } });
    vi.stubGlobal('fetch', fetchMock);
    const c = editor({ title: 'Blur 3-hop', name: 'Blur 3-hop', lensId: 7, selected: 'L7' });
    type(within(c).getByLabelText('Days from the trade within which an edge counts'), '14');
    fireEvent.click(button(c, 'Save and run'));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`${BASE}?method=L7#evidence`));
    const { url, method, body } = sent(fetchMock);
    expect(url).toBe('/api/lenses/7');
    expect(method).toBe('PATCH');
    // The collection it was opened from goes too, so Save and run queues its run there, as the button says (M2).
    expect(body).toEqual({ name: 'Blur 3-hop', rule: { ...DEFAULT_RULE, window: { days: 14, side: 'either' } }, chainId: 1, address: ADDR });
    expect(button(c, 'Save and run').title).toBe('Save this lens, then queue its run on this collection');
  });
});

describe('send, the one way a lens write reaches its route, which the editor and the lens actions share', () => {
  it('sends POST and PATCH as JSON and gives back the parsed body', async () => {
    for (const method of ['POST', 'PATCH'] as const) {
      const fetchMock = reply(method === 'POST' ? 201 : 200, { lens: { id: 7, key: 'L7' } });
      vi.stubGlobal('fetch', fetchMock);
      expect(await send('/api/lenses/7', method, { name: 'Mine' })).toEqual({ error: null, body: { lens: { id: 7, key: 'L7' } } });
      expect(sent(fetchMock)).toEqual({ url: '/api/lenses/7', method, body: { name: 'Mine' } });
    }
  });

  it('types the body as its caller says, so a misspelt field does not compile', async () => {
    vi.stubGlobal('fetch', reply(201, { lens: { id: 9, key: 'L9' } }));
    const said = await send<{ lens: { key: string } }>('/api/lenses', 'POST', {});
    if (said.error !== null) throw new Error(said.error);
    expect(said.body.lens.key).toBe('L9');
    // @ts-expect-error: the body has no such field
    expect(said.body.lens.kye).toBeUndefined();
    // Untyped, it is unknown: read only once narrowed.
    const plain = await send('/api/lenses', 'POST', {});
    // @ts-expect-error: unknown has no fields
    expect(plain.error === null && plain.body.lens).toBeTruthy();
  });

  it("says the route's error, else the status it answered, else that nothing answered", async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'Another lens is already called "Mine".' }));
    expect(await send('/api/lenses', 'POST', {})).toEqual({ error: 'Another lens is already called "Mine".' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })));
    expect(await send('/api/lenses', 'POST', {})).toEqual({ error: 'The service answered 502.' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch'); }));
    expect(await send('/api/lenses/7', 'PATCH', {})).toEqual({ error: 'The service did not answer.' });
    // A delete that took, with no body to read.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await send('/api/lenses/7', 'DELETE')).toEqual({ error: null, body: {} });
  });
});

describe('Cancel', () => {
  it('goes back to the selected tab without saving', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const c = editor({ selected: 'AU' });
    fireEvent.click(button(c, 'Cancel'));
    expect(push).toHaveBeenCalledWith(`${BASE}?method=AU`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('without permission to write', () => {
  it('disables every control but Cancel, and says why', () => {
    const c = editor({ writable: false, name: 'Mine' });
    const controls = [...c.querySelectorAll('input, select, textarea, button')] as HTMLButtonElement[];
    expect(controls.length).toBeGreaterThan(20);
    for (const el of controls) expect(el.disabled, el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).toBe(el.textContent === 'Cancel' ? false : true);
    expect(c.textContent).toContain(LOCAL_ONLY);
    expect(button(c, 'Save and run').title).toBe(LOCAL_ONLY);
  });
});

describe('in the collection page\'s panel', () => {
  it('takes the selected tab\'s place, and the tab stays', async () => {
    const { LensTabs } = await import('@/components/lens-tabs');
    const c = render(
      <LensTabs base={BASE} chainId={1} address={ADDR} selected="AU" totals={null} latestId={null} paused={false} runs={[]} notFinal={[]} moneyShort={{}} tokens={{}}
        coverage={{ trail: false, funded: true, coming: false, silent: false }} writable editor={<p>the form</p>}>
        <p>the lists</p>
      </LensTabs>,
    ).container;
    const panel = c.querySelector('[data-lens-panel]')!;
    expect(panel.textContent).toBe('the form');
    expect(c.querySelector('nav[aria-label="Lens"] [aria-current="page"]')!.textContent).toContain('Money loops back');
  });
});

describe('what ?lens= opens', () => {
  const mine = [{ id: 7, key: 'L7', name: 'Blur 3-hop', rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 }] as never;

  it('opens a new lens, a copy of a built-in or of yours, or an edit of yours', async () => {
    const { editorStart } = await import('@/lib/lens-api');
    expect(editorStart('new', mine)).toMatchObject({ title: 'New lens', name: '', rule: DEFAULT_RULE });
    expect(editorStart('copy-AU', mine)).toMatchObject({ title: 'Copy of Money loops back', name: 'Money loops back (copy)', rule: COPIES.AU.rule, differs: COPIES.AU.differs });
    expect(editorStart('copy-L7', mine)).toMatchObject({ name: 'Blur 3-hop (copy)', differs: null });
    expect(editorStart('edit-L7', mine)).toMatchObject({ title: 'Blur 3-hop', name: 'Blur 3-hop', lensId: 7 });
  });

  it('ignores anything else, a built-in or a deleted lens being edited included', async () => {
    const { editorStart } = await import('@/lib/lens-api');
    for (const raw of [undefined, '', 'edit-AU', 'edit-A', 'edit-L99', 'copy-L99', 'copy-', 'copy-Z', 'delete-L7', 'new-1']) expect(editorStart(raw, mine)).toBeNull();
  });
});
