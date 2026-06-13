import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '@/components/theme';

const osDark = (dark: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: dark && q.includes('dark'), media: q }));

// Node's own localStorage global shadows jsdom's here, so give the test a plain one.
let stored: Record<string, string>;

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  stored = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => { stored[k] = v; },
  });
  osDark(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ThemeToggle', () => {
  it('offers dark while light, switches, and remembers the choice', () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(button.textContent).toContain('Dark mode');
    fireEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('washtrace.theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' }).textContent).toContain('Light mode');
  });

  it('reads the chosen theme from the page, and switches to the other', () => {
    document.documentElement.dataset.theme = 'dark';
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('washtrace.theme')).toBe('light');
  });

  it('follows the OS when no choice was made', () => {
    osDark(true);
    render(<ThemeToggle />);
    expect(screen.getByRole('button').textContent).toContain('Light mode');
  });

  it('still switches when storage throws', () => {
    localStorage.setItem = () => { throw new Error('blocked'); };
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
