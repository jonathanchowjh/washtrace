import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotFound from '@/app/not-found';
import NotInCollection from '@/app/c/[chain]/[address]/not-found';

const nav = { path: '/' };
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));

afterEach(() => { cleanup(); nav.path = '/'; });

const MISSING = '0x' + '0'.repeat(39) + '1';

describe('the not-found pages', () => {
  it('says a collection nobody watches is not watched, with its chain and address, and offers to watch it', () => {
    nav.path = `/c/1/${MISSING}`;
    const c = render(<NotFound />).container;
    expect(c.querySelector('h1')?.textContent).toBe('Not watched');
    expect(c.textContent).toContain('This collection is not watched.');
    expect(c.textContent).toContain('Ethereum');
    expect(c.textContent).toContain(MISSING);
    const watch = [...c.querySelectorAll('a')].find((a) => a.textContent === 'Watch it')!;
    expect(watch.getAttribute('href')).toBe(`/?watch=1:${MISSING}`);
    expect(watch.className).toContain('btn');
    expect([...c.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/' && a.textContent === 'Back to Collections')).toBe(true);
  });

  it('says only not found for any other address, or one under /c/ that is no collection', () => {
    for (const path of ['/nowhere', '/c/1/not-an-address']) {
      nav.path = path;
      const c = render(<NotFound />).container;
      expect(c.querySelector('h1')?.textContent).toBe('Not found');
      expect(c.textContent).not.toMatch(/not watched/i);
      cleanup();
    }
  });

  it('never says not watched of something missing inside a watched collection', () => {
    const c = render(<NotInCollection />).container;
    expect(c.querySelector('h1')?.textContent).toBe('Not found');
    expect(c.textContent).not.toMatch(/not watched/i);
  });
});
