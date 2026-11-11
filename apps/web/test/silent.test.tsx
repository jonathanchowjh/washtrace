import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Silent } from '@/components/ui';

afterEach(cleanup);

describe('Silent', () => {
  it('says when the worker last reported, in the reader\'s zone, and links to the worker', () => {
    const since = Date.UTC(2026, 10, 3, 9, 30);
    const { container } = render(<Silent silent={{ since }} />);
    const text = container.textContent!;
    expect(text).toContain('The worker has not reported since');
    expect(text).toContain('so nothing on this page is being kept current.');
    expect(container.querySelector('time')!.getAttribute('dateTime')).toBe(new Date(since).toISOString());
    expect(screen.getByRole('link').getAttribute('href')).toBe('/worker');
  });

  it('says the worker has not run yet when no pass ever ran', () => {
    const { container } = render(<Silent silent={{ since: null }} />);
    expect(container.textContent).toContain('The worker has not run yet, so nothing has been read.');
    expect(container.querySelector('time')).toBeNull();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/worker');
  });
});
