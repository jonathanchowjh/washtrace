import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PageError from '@/app/error';

afterEach(cleanup);

describe('the error page', () => {
  it('says the store did not answer, with what failed and a way to try again', () => {
    const retry = vi.fn();
    render(<PageError error={new Error('connect ECONNREFUSED 127.0.0.1:5432')} retry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain('The store did not answer');
    expect(screen.getByRole('alert').textContent).toContain('connect ECONNREFUSED 127.0.0.1:5432');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("in production points at the server log by digest, since the message is Next's generic sentence", () => {
    const error = Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '4821' });
    render(<PageError error={error} retry={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('digest 4821');
    expect(screen.getByRole('alert').textContent).not.toContain('Server Components render');
  });
});
