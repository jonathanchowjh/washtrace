import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZonePicker } from '@/components/zone';
import { detectedZone } from '@/lib/zone';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const ZONES = ['Africa/Abidjan', 'America/New_York', 'Asia/Singapore', 'Europe/London'];

beforeEach(() => {
  // A stored, current detection, so the first-visit effect stays quiet.
  document.cookie = `washtrace_tz=${encodeURIComponent(`auto:${detectedZone()}`)}; path=/`;
  vi.stubGlobal('Intl', Object.assign(Object.create(Intl), { supportedValuesOf: () => ZONES }, {
    DateTimeFormat: Intl.DateTimeFormat,
  }));
  // jsdom lacks scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = () => {
  render(<ZonePicker />);
  fireEvent.click(screen.getByRole('button', { name: /Times shown in/ }));
};

describe('ZonePicker', () => {
  it('opens a short, scrolling list that starts with automatic detection', () => {
    open();
    const list = screen.getByRole('listbox');
    expect(list.className).toContain('max-h-64');
    expect(list.className).toContain('overflow-y-auto');
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('Detect automatically');
  });

  it('filters by what is typed, ignoring case and underscores', () => {
    open();
    const search = screen.getByRole('combobox');
    fireEvent.change(search, { target: { value: 'SING' } });
    expect(screen.getByRole('option', { name: 'Asia/Singapore' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Europe/London' })).toBeNull();
    fireEvent.change(search, { target: { value: 'new york' } });
    expect(screen.getByRole('option', { name: 'America/New York' })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No zone matches')).toBeTruthy();
  });

  it('picks the active option with the arrow keys and Enter', () => {
    open();
    const search = screen.getByRole('combobox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(document.cookie).toContain('washtrace_tz=Africa%2FAbidjan');
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on Escape', () => {
    open();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('reopens on the current choice even after a search', () => {
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sing' } });
    fireEvent.click(screen.getByRole('option', { name: 'Asia/Singapore' }));
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Times shown in/ }));
    const singapore = screen.getByRole('option', { name: 'Asia/Singapore' });
    expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBe(singapore.id);
    expect(singapore.getAttribute('aria-selected')).toBe('true');
    expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts.at(-1)).toBe(singapore);
  });

  it('does nothing on Enter when nothing matches', () => {
    open();
    const search = screen.getByRole('combobox');
    fireEvent.change(search, { target: { value: 'zzz' } });
    refresh.mockClear();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('closes when focus leaves the panel', () => {
    open();
    fireEvent.blur(screen.getByRole('combobox'), { relatedTarget: document.body });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
