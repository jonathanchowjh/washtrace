import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Pager } from '@/components/pager';

afterEach(cleanup);

const href = (n: number) => `/c/1/0xabc/t/7?show=sales${n > 1 ? `&page=${n}` : ''}`;
const hrefOf = (c: HTMLElement, text: string) => [...c.querySelectorAll('a')].find((a) => a.textContent === text)?.getAttribute('href');

describe('the pager', () => {
  it('says the range and links First and Last to the first and last page', () => {
    const { container: c } = render(<Pager total={2656} page={1} size={100} href={href} label="transfers" />);
    expect(c.textContent).toContain('1–100 of 2,656 transfers');
    expect(c.textContent).toContain('of 27');
    expect(hrefOf(c, 'Next ›')).toBe('/c/1/0xabc/t/7?show=sales&page=2');
    expect(hrefOf(c, 'Last »')).toBe('/c/1/0xabc/t/7?show=sales&page=27');
    // On the first page there is nothing before it to link to.
    expect(hrefOf(c, '« First')).toBeUndefined();
    expect(hrefOf(c, '‹ Previous')).toBeUndefined();
  });

  it('links back to page 1 and the page before from a later page', () => {
    const { container: c } = render(<Pager total={2656} page={5} size={100} href={href} />);
    expect(hrefOf(c, '« First')).toBe('/c/1/0xabc/t/7?show=sales');
    expect(hrefOf(c, '‹ Previous')).toBe('/c/1/0xabc/t/7?show=sales&page=4');
  });

  it('has a page box that keeps every other param as a hidden input and sends page', () => {
    const { container: c } = render(<Pager total={2656} page={3} size={100} href={href} />);
    const form = c.querySelector('form')!;
    expect(form.getAttribute('method')).toBe('get');
    expect(form.getAttribute('action')).toBe('/c/1/0xabc/t/7');
    const hidden = [...form.querySelectorAll('input[type=hidden]')].map((i) => [i.getAttribute('name'), (i as HTMLInputElement).value]);
    expect(hidden).toEqual([['show', 'sales']]);
    const box = form.querySelector('input[type=number]') as HTMLInputElement;
    expect(box.name).toBe('page');
    expect(box.min).toBe('1');
    expect(box.max).toBe('27');
    expect(box.value).toBe('3');
  });

  it('names the page param as asked, so several pagers can share a page', () => {
    const wallets = (n: number) => `/w/1/0xabc?tpage=2&wpage=${n}`;
    const { container: c } = render(<Pager total={500} page={2} size={50} href={wallets} pageParam="wpage" />);
    expect([...c.querySelectorAll('input[type=hidden]')].map((i) => i.getAttribute('name'))).toEqual(['tpage']);
    expect(c.querySelector('input[type=number]')?.getAttribute('name')).toBe('wpage');
  });

  it('open: says "more than", has no last page and no cap on the box', () => {
    const { container: c } = render(<Pager total={40} page={2} size={20} href={href} label="wallets" open />);
    expect(c.textContent).toContain('21–40 of more than 40 wallets');
    expect(c.textContent).not.toMatch(/ of \d+\s*$/);
    expect(c.textContent).not.toContain('Last');
    expect(c.querySelector('form')?.textContent).not.toContain('of ');
    expect(c.querySelector('input[type=number]')?.hasAttribute('max')).toBe(false);
    expect(hrefOf(c, 'Next ›')).toBe('/c/1/0xabc/t/7?show=sales&page=3');
    expect(hrefOf(c, '‹ Previous')).toBe('/c/1/0xabc/t/7?show=sales');
  });

  it('open on the first page still offers Next', () => {
    const { container: c } = render(<Pager total={20} page={1} size={20} href={href} open />);
    expect(hrefOf(c, 'Next ›')).toBe('/c/1/0xabc/t/7?show=sales&page=2');
  });

  it('clamps a page past the end to the last page', () => {
    const { container: c } = render(<Pager total={160} page={9} size={20} href={href} label="things" />);
    expect(c.textContent).toContain('141–160 of 160 things');
    expect((c.querySelector('input[type=number]') as HTMLInputElement).value).toBe('8');
  });

  it('with one page shows only the count', () => {
    const { container: c } = render(<Pager total={42} page={1} size={100} href={href} label="transfers" />);
    expect(c.textContent).toBe('42 transfers');
    expect(c.querySelector('form')).toBeNull();
    expect(c.querySelector('a')).toBeNull();
  });
});
