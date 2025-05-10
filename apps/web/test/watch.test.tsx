import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressOf } from '@/lib/api';
import { SUGGESTED, Suggested, WatchPanel } from '@/components/watch';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SUGGESTED', () => {
  it('holds addresses as the store keeps them, so a watched one is found', () => {
    for (const s of SUGGESTED) expect(addressOf(s.address)).toBe(s.address);
  });
});

describe('Suggested', () => {
  it('links a watched suggestion to its page and offers the rest', () => {
    render(<Suggested watched={['1/0x4e1f41613c9084fdb9e34e11fae9412427480e56']} />);
    expect(screen.getByRole('link', { name: 'Watching →' }).getAttribute('href')).toBe('/c/1/0x4e1f41613c9084fdb9e34e11fae9412427480e56');
    expect(screen.getAllByRole('button', { name: 'Watch' })).toHaveLength(SUGGESTED.length - 1);
  });

  it('watches with one press, named, and refreshes', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ created: true }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    render(<Suggested watched={[]} />);
    const [first] = screen.getAllByRole('button', { name: 'Watch' });
    fireEvent.click(first!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ chainId: 1, address: SUGGESTED[0].address, name: SUGGESTED[0].name });
    expect(screen.getByRole('status').textContent).toBe('Dreadfulz: Watching. The worker reads it on its next pass.');
  });
});

describe('WatchPanel', () => {
  it('stays open when the refresh after a first watch would start it shut', () => {
    const { container, rerender } = render(<WatchPanel startOpen><summary>Watch</summary></WatchPanel>);
    rerender(<WatchPanel startOpen={false}><summary>Watch</summary></WatchPanel>);
    expect(container.querySelector('details')!.open).toBe(true);
  });
});
