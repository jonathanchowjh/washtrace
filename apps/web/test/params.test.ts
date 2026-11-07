import { describe, expect, it } from 'vitest';
import { addressOf, chainIdOf, chainOf, findText, idOf, pageOf, pages, tokenIdOf, txOf } from '../lib/params';

const ADDR = '0x' + 'a'.repeat(40);

describe('params', () => {
  it('reads ids and hex the way every caller needs, lowercased', () => {
    expect(chainOf('1')).toBe(1);
    expect(chainOf('12345678901')).toBeNull();
    expect(addressOf(ADDR.toUpperCase().replace('0X', '0x'))).toBe(ADDR);
    expect(addressOf('0x12')).toBeNull();
    expect(txOf('0x' + 'F'.repeat(64))).toBe('0x' + 'f'.repeat(64));
    expect(tokenIdOf('007')).toBe('7');
    expect(tokenIdOf('1'.repeat(79))).toBeNull();
    expect(idOf('42')).toBe(42);
    expect(idOf('x')).toBeNull();
  });

  it('takes a chain id from a body only in the range a path takes, and not 0', () => {
    expect(chainIdOf(1)).toBe(1);
    expect(chainIdOf(0)).toBeNull();
    expect(chainIdOf(1e21)).toBeNull();
    expect(chainIdOf(1.5)).toBeNull();
    expect(chainIdOf('1')).toBeNull();
  });

  it('trims and cuts Find text, and drops an empty one', () => {
    expect(findText('  abc ')).toBe('abc');
    expect(findText('x'.repeat(150))).toHaveLength(100);
    expect(findText('   ')).toBeNull();
    expect(findText(undefined)).toBeNull();
  });

  it('reads a page as a whole number from 1, else the first, and counts pages from 1', () => {
    expect(pageOf('3')).toBe(3);
    for (const junk of [undefined, '', '0', '-2', '1.5', 'abc', '1e400']) expect(pageOf(junk)).toBe(1);
    expect(pages(0, 50)).toBe(1);
    expect(pages(51, 50)).toBe(2);
  });
});
