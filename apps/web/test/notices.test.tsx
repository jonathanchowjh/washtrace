import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Notices, Silent } from '@/components/head';
import type { Notice } from '@/lib/status';

afterEach(cleanup);

const needs: Notice = { severity: 'needs-you', text: 'Etherscan rejected the key.', doThis: 'Open Settings', href: '/settings' };
const working: Notice = { severity: 'working', text: 'Checking wallets for Terraforms: 1,612 of 11,259' };
const info: Notice = { severity: 'info', text: 'No Etherscan key.', action: { label: 'How to turn it on', href: '/worker#sources' } };

describe('Notices', () => {
  it('gives a needs-you item a Do this link to its action', () => {
    render(<Notices notices={[needs]} />);
    expect(screen.getByText('Do this:')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings');
    expect(screen.getByText('Etherscan rejected the key.')).toBeTruthy();
  });

  it('says a needs-you item with no place to go as plain text', () => {
    render(<Notices notices={[{ severity: 'needs-you', text: 'fund has never run.', doThis: 'Check the worker is running' }]} />);
    expect(screen.getByText(/Check the worker is running/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders working and info items without a Do this line', () => {
    render(<Notices notices={[working, info]} />);
    expect(screen.queryByText('Do this:')).toBeNull();
    expect(screen.getByText(/Checking wallets for Terraforms/)).toBeTruthy();
    expect(screen.getByText('No Etherscan key.')).toBeTruthy();
  });

  it('counts only needs-you items in the header', () => {
    const { rerender } = render(<Notices notices={[working, info]} />);
    expect(screen.getByRole('heading').textContent).toBe('Nothing has failed.');
    rerender(<Notices notices={[needs, working, info]} />);
    expect(screen.getByRole('heading').textContent).toBe('1 thing needs you');
    rerender(<Notices notices={[needs, { ...needs, text: 'second' }]} />);
    expect(screen.getByRole('heading').textContent).toBe('2 things need you');
  });
});

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
