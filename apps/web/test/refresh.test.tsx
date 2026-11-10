import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Refresh } from '@/components/refresh';

const refresh = vi.fn();
// One router for every render, as the App Router gives: the interval is set up once.
const router = { refresh };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

let visibility: DocumentVisibilityState = 'visible';
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Refresh', () => {
  it('re-renders the page from the server once an interval', async () => {
    render(<Refresh everyMs={15_000} />);
    await tick(14_999);
    expect(refresh).not.toHaveBeenCalled();
    await tick(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await tick(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh while the tab is hidden, and picks up again once it is shown', async () => {
    render(<Refresh everyMs={15_000} />);
    visibility = 'hidden';
    await tick(45_000);
    expect(refresh).not.toHaveBeenCalled();
    visibility = 'visible';
    await tick(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says how often it polls before its first refresh', () => {
    const c = render(<Refresh everyMs={15_000} />);
    expect(c.container.textContent).toMatch(/^live · every /);
  });
});
