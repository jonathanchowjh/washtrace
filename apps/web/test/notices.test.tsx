import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Notices } from '@/components/head';
import type { Notice } from '@/lib/status';

afterEach(cleanup);

const needs: Notice = { severity: 'needs-you', text: 'Etherscan rejected the key.', action: { label: 'Open Settings', href: '/settings' } };
const working: Notice = { severity: 'working', text: 'Checking wallets for Terraforms: 1,612 of 11,259' };
const info: Notice = { severity: 'info', text: 'No Etherscan key.', action: { label: 'How to turn it on', href: '/worker#sources' } };

describe('Notices', () => {
  it('gives a needs-you item a Do this link to its action', () => {
    render(<Notices notices={[needs]} />);
    expect(screen.getByText('Do this:')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings');
    expect(screen.getByText('Etherscan rejected the key.')).toBeTruthy();
  });

  it('renders working and info items without a Do this line', () => {
    render(<Notices notices={[working, info]} />);
    expect(screen.queryByText('Do this:')).toBeNull();
    expect(screen.getByText(/Checking wallets for Terraforms/)).toBeTruthy();
    expect(screen.getByText('No Etherscan key.')).toBeTruthy();
  });

  it('counts only needs-you items in the header', () => {
    const { rerender } = render(<Notices notices={[working, info]} />);
    expect(screen.getByRole('heading').textContent).toBe('Nothing needs you');
    rerender(<Notices notices={[needs, working, info]} />);
    expect(screen.getByRole('heading').textContent).toBe('1 thing needs you');
    rerender(<Notices notices={[needs, { ...needs, text: 'second' }]} />);
    expect(screen.getByRole('heading').textContent).toBe('2 things need you');
  });
});
