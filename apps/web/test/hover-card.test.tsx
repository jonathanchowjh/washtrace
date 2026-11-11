import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverCard, KEEP_MS, OPEN_MS, cardLines, forgetCards, type Card } from '@/components/hover-card';

const W = '0x' + 'a'.repeat(40);
const wallet: Card = { kind: 'wallet', judged: true, address: W, trades: 4, flagged: 2, rings: 2, ring: { anchor: W, rank: 3, wallets: 3, sample: [], sales: 1, floorSales: 0, tokens: 1, volumeWei: '0', firstAt: null, lastAt: null } };
const fetchMock = vi.fn();
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); forgetCards(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
const draw = () => render(<HoverCard src="/api/x"><a href="/w">wallet</a></HoverCard>);
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('a hover card', () => {
  it('opens only after the pointer rests on the link, and closes when it leaves', async () => {
    fetchMock.mockResolvedValue(reply(wallet));
    draw();
    fireEvent.mouseEnter(screen.getByText('wallet').parentElement!);
    await wait(OPEN_MS - 1);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await wait(1);
    expect(screen.getByRole('tooltip').textContent).toContain('4 transfers here · 2 flagged');
    fireEvent.mouseLeave(screen.getByText('wallet').parentElement!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on focus too, closes on Escape, and leaves the link to navigate', async () => {
    fetchMock.mockResolvedValue(reply(wallet));
    draw();
    const link = screen.getByText('wallet');
    fireEvent.focus(link);
    await wait(OPEN_MS);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(link.getAttribute('href')).toBe('/w');
  });

  it('reads a thing once however often it is hovered', async () => {
    fetchMock.mockResolvedValue(reply(wallet));
    draw();
    const at = screen.getByText('wallet').parentElement!;
    for (let i = 0; i < 3; i++) { fireEvent.mouseEnter(at); await wait(OPEN_MS); fireEvent.mouseLeave(at); }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when the read fails, and asks again on the next hover', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, false)).mockResolvedValue(reply(wallet));
    draw();
    const at = screen.getByText('wallet').parentElement!;
    fireEvent.mouseEnter(at);
    await wait(OPEN_MS);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseLeave(at);
    fireEvent.mouseEnter(at);
    await wait(OPEN_MS);
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('reads a thing again once its card is a minute old, so a new analysis shows', async () => {
    fetchMock.mockResolvedValue(reply(wallet));
    draw();
    const at = screen.getByText('wallet').parentElement!;
    fireEvent.mouseEnter(at); await wait(OPEN_MS); fireEvent.mouseLeave(at);
    await wait(KEEP_MS);
    fireEvent.mouseEnter(at); await wait(OPEN_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says not judged yet before any analysis, never 0 flagged', () => {
    expect(cardLines({ kind: 'token', judged: false, tokenId: '7', transfers: 2, flagged: 0 }).lines).toEqual(['2 transfers · not judged yet']);
    expect(cardLines(wallet).lines[1]).toBe('In Ring 3 and 1 more ring');
  });

  it('names each count by what it counts: a wallet\'s and a token\'s transfers, a ring\'s flagged sales', () => {
    expect(cardLines(wallet).lines[0]).toBe('4 transfers here · 2 flagged');
    expect(cardLines({ kind: 'token', judged: true, tokenId: '7', transfers: 5, flagged: 4 }).lines).toEqual(['5 transfers · 4 flagged']);
    expect(cardLines({ kind: 'ring', judged: true, ring: { ...wallet.ring!, wallets: 3, tokens: 2, sales: 4, volumeWei: '0' } }).lines[1]).toBe('4 flagged sales · 0 ETH');
  });
});
